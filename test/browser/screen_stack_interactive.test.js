'use strict';

// Black-box terminal coverage for shared list policy and the poppable screen
// stack. The unit and differential tests can inspect state, but only a tmux
// pane proves which screen actually owns keys, how SIGWINCH redraws it, and
// whether a real browser update stays behind it until it pops.
//
//   tools/build_crystal.sh
//   xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 \
//     node --test --test-concurrency=1 test/browser/screen_stack_interactive.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const {
  COLS, ROWS, RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile, waitForRow, waitForStatus, waitForDrawn,
} = require('./tmux_reader');

const skip = browserTestSkip();
const FIXTURE = fs.readFileSync(path.join(__dirname, 'screen_stack.html'), 'utf8');

async function startServer() {
  let control = 'wait';
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    if (req.url === '/control') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(control);
      return;
    }
    if (req.url === '/download') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="screen-stack-probe.bin"',
      });
      res.end(Buffer.alloc(2048, 3));
      return;
    }
    const match = /^\/(alpha|bravo|charlie)$/.exec(req.url);
    if (match) {
      const title = `${match[1][0].toUpperCase()}${match[1].slice(1)} bookmark`;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      });
      res.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    fixture: `${origin}/fixture`,
    armUpdate() { control = 'update'; },
    armAlert() { control = 'alert'; },
    reset() { control = 'wait'; },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function selectedLine(reader) {
  return reader.rows()[reader.cursor().row].trim();
}

function bookmarkOrder(reader) {
  const names = ['Alpha bookmark', 'Bravo bookmark', 'Charlie bookmark'];
  return reader.rows().flatMap((row) => {
    const found = names.find((name) => row.includes(name));
    return found ? [found] : [];
  });
}

async function moveUntil(reader, pattern, { key = 'Down', limit = 40 } = {}) {
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return true;
    await reader.press(key);
  }
  return pattern.test(selectedLine(reader));
}

async function waitForTitle(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.rows()[0].includes(text)) return true;
    await sleep(200);
  }
  return reader.rows()[0].includes(text);
}

async function waitForSelection(reader, pattern, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(selectedLine(reader))) return true;
    await sleep(200);
  }
  return pattern.test(selectedLine(reader));
}

async function libraryJourney(root, server, engine, runtime) {
  server.reset();
  const name = `${runtime.name}-${engine}-stack-library`;
  const profile = path.join(root, name, 'profile');
  const env = environment(root, name);
  const reader = new ReaderTty({
    session: `tawb-stack-library-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', engine, '--profile', profile,
      '--no-alt-screen', server.fixture],
    env,
  });
  try {
    await reader.start({ ready: 'Screen stack fixture' });
    // File three bookmarks through this same assembled reader. Chromium does
    // not promise to flush bookmark changes before a separately prepared
    // browser exits, and using the reader also makes the resulting history
    // real input for the history screen below.
    for (const route of ['alpha', 'bravo', 'charlie']) {
      const title = `${route[0].toUpperCase()}${route.slice(1)} bookmark`;
      await reader.press('C-l');
      await reader.press('C-u');
      await reader.type(`${server.origin}/${route}`);
      await reader.press('Enter');
      assert.ok(await waitForRow(reader, title, 15000),
        `${name} did not navigate to the ${route} bookmark fixture`);
      await reader.press('C-d');
      await reader.press('Enter');
      assert.ok(await waitForStatus(reader, 'Bookmarked', 10000),
        `${name} did not file the ${route} bookmark`);
    }
    await reader.press('C-l');
    await reader.press('C-u');
    await reader.type(server.fixture);
    await reader.press('Enter');
    assert.ok(await waitForRow(reader, 'Screen stack fixture', 15000),
      `${name} did not return to the screen fixture`);
    assert.ok(await waitForRow(reader, 'Download probe', 15000),
      `${name} did not finish scanning the screen fixture controls`);

    // Stand on the final control so leaving every raised screen has a deep,
    // stable page place to restore rather than merely returning to the top.
    assert.ok(await moveUntil(reader, /\[Palette:/),
      `${name} did not reach the fixture's final control`);
    const pageLine = selectedLine(reader);

    await reader.press('C-o');
    assert.ok(await waitForRow(reader, 'Bravo bookmark'),
      `${name} did not open the browser bookmark list; screen was:\n${reader.raw()}`);

    // Printable browse commands belong to typeahead while a lookup list owns
    // the keyboard. q must filter, not terminate the process.
    await reader.typeKeys('q');
    assert.ok(reader.alive(), `${name} treated q as Quit in a lookup list`);
    assert.match(reader.status(), /matching "q"/i);
    await reader.press('C-u');

    await reader.typeKeys('bravo');
    assert.match(selectedLine(reader), /Bravo bookmark/,
      `${name} did not select the only matching bookmark`);
    await reader.press('C-u');
    assert.match(selectedLine(reader), /Bravo bookmark/,
      `${name} lost stable selection when the bookmark filter cleared`);

    const order = bookmarkOrder(reader);
    const selected = order.indexOf('Bravo bookmark');
    assert.notEqual(selected, -1, `${name} did not redraw every bookmark after Ctrl+U`);
    const replacement = order[selected + 1] || order[selected - 1];
    assert.ok(replacement, `${name} did not have a neighbour for deletion fallback`);

    await reader.resize(101, 31);
    assert.match(reader.raw(), /Bravo bookmark/,
      `${name} lost the bookmark screen on resize`);
    await reader.resize(COLS, ROWS);
    assert.match(selectedLine(reader), /Bravo bookmark/,
      `${name} lost bookmark selection when the old size returned`);

    await reader.press('M-d');
    await reader.press('y');
    assert.ok(await waitForStatus(reader, 'Removed bookmark', 10000),
      `${name} did not remove the selected browser bookmark`);
    assert.match(selectedLine(reader), new RegExp(replacement),
      `${name} did not choose the nearest row after bookmark deletion`);

    // The page changes in the real browser while the library owns the tty.
    // Its rebuild must be held until the screen leaves.
    server.armUpdate();
    await sleep(1800);
    assert.match(reader.raw(), /Bookmarks/,
      `${name} let the page repaint over the bookmark screen`);
    assert.doesNotMatch(reader.drawn().join('\n'), /Held dynamic row/,
      `${name} exposed a held update through the bookmark screen`);
    await reader.press('Escape');
    assert.ok(await waitForDrawn(reader, 'Held dynamic row', 15000),
      `${name} did not apply the held update after popping the list`);
    assert.equal(selectedLine(reader), pageLine,
      `${name} did not restore the page line after the bookmark list`);

    await reader.press('M-h');
    assert.ok(await waitForRow(reader, 'Alpha bookmark'),
      `${name} did not open browser history`);
    await reader.typeKeys('alpha');
    assert.match(selectedLine(reader), /Alpha bookmark/,
      `${name} did not typeahead-filter browser history`);
    await reader.press('C-u');
    assert.match(selectedLine(reader), /Alpha bookmark/,
      `${name} did not retain history selection when clearing`);
    await reader.press('Escape');

    await reader.press('M-j');
    assert.ok(await waitForRow(reader, 'Downloads'),
      `${name} did not open browser downloads; screen was:\n${reader.raw()}`);
    // A fresh browser may have no downloads. Empty lookup lists still own
    // printable keys and expose exactly the same typeahead editor.
    await reader.typeKeys('q');
    assert.ok(reader.alive(), `${name} let q quit from browser downloads`);
    assert.match(reader.status(), /matching "q"/i,
      `${name} did not typeahead-filter browser downloads`);
    await reader.press('BSpace');
    assert.doesNotMatch(reader.status(), /matching/i,
      `${name} did not erase the download filter with Backspace`);
    await reader.press('C-u');
    await reader.press('Escape');

    await reader.quit();
    return profile;
  } finally {
    reader.stop();
  }
}

for (const engine of ['firefox', 'chromium']) {
  test(`both readers enforce lookup-list policy and restoration through ${engine} tmux`,
    { skip }, async () => {
      const root = tempDir(`tawb-stack-library-${engine}-`);
      const server = await startServer();
      const profiles = [];
      try {
        for (const runtime of RUNTIMES) {
          const profile = await libraryJourney(root, server, engine, runtime);
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await server.close();
        removeTempDir(root);
      }
    });
}

async function surfaceJourney(root, server, runtime) {
  const name = `${runtime.name}-stack-surfaces`;
  const profile = path.join(root, name, 'profile');
  const env = environment(root, name);
  const config = path.join(env.XDG_CONFIG_HOME, 'tawb');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.lynx.json'),
    JSON.stringify({ version: 1, lynx: { showCursor: true } }));
  fs.writeFileSync(path.join(config, 'keys-lynx.json'), JSON.stringify({
    version: 1,
    actions: {
      'document-info': ['='],
      'toggle-trace': ['Ctrl+T'],
      'trace-log': ['t'],
      'keyboard-wizard': ['k'],
    },
  }));
  const reader = new ReaderTty({
    session: `tawb-stack-surfaces-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--front-end', 'lynx', '--browser', 'firefox',
      '--profile', profile, '--no-alt-screen', server.fixture],
    env,
  });
  try {
    await reader.start({ ready: 'Screen stack fixture' });

    // The select is the fixture's final line, so End reaches it without
    // coupling this test to how prose happens to wrap or how Tab is imported.
    assert.ok(await moveUntil(reader, /Palette/),
      `${name} did not reach the native select; selected ${selectedLine(reader)}; screen was:\n${reader.raw()}`);
    await reader.press('Enter');
    assert.ok(await waitForRow(reader, 'Choosing'),
      `${name} did not open the native select chooser; selected ${selectedLine(reader)}; screen was:\n${reader.raw()}`);
    await reader.typeKeys('blu');
    assert.match(selectedLine(reader), /Blue choice/,
      `${name} did not typeahead-filter the chooser; screen was:\n${reader.raw()}`);
    await reader.press('C-u');
    assert.match(selectedLine(reader), /Blue choice/,
      `${name} lost chooser selection when the filter cleared`);
    await reader.resize(96, 29);
    assert.match(reader.raw(), /Blue choice/,
      `${name} did not redraw the chooser after resize`);
    await reader.resize(COLS, ROWS);
    await reader.press('Enter');
    assert.ok(await waitForRow(reader, 'Selected: Blue choice', 15000),
      `${name} did not apply the chosen native option`);

    const pagePlace = reader.cursor();
    const pageLine = selectedLine(reader);
    await reader.press('=');
    assert.ok(await waitForRow(reader, 'Information'),
      `${name} did not open document information; screen was:\n${reader.raw()}`);
    await reader.press('j');
    assert.match(reader.raw(), /Information/,
      `${name} let j escape from the information surface`);
    const afterMovement = reader.drawn();
    await reader.press('x');
    assert.deepEqual(reader.drawn(), afterMovement,
      `${name} treated a plain letter as an information filter`);
    await reader.press('/');
    await reader.typeKeys('title');
    assert.match(reader.status(), /matching "title"/i,
      `${name} did not explicitly filter document information`);
    await reader.press('BSpace');
    assert.match(reader.status(), /matching "titl"/i,
      `${name} did not edit the explicit information filter`);
    await reader.press('C-u');
    assert.doesNotMatch(reader.status(), /matching/i,
      `${name} did not clear the explicit information filter`);
    await reader.press('Enter');
    await reader.press('/');
    await reader.typeKeys('address');
    await reader.press('Enter');
    assert.match(reader.raw(), /Information/,
      `${name} left information when Enter only ended filter input`);
    await reader.resize(103, 32);
    assert.match(reader.raw(), /Information/,
      `${name} did not redraw information after resize`);
    await reader.resize(COLS, ROWS);
    await reader.press('Escape');
    assert.ok(await waitForTitle(reader, 'Screen stack fixture'),
      `${name} did not return from information`);
    assert.equal(reader.cursor().row, pagePlace.row,
      `${name} did not restore the page row after information`);
    assert.equal(selectedLine(reader), pageLine,
      `${name} did not restore the page line after information`);

    await reader.press('C-t');
    assert.ok(await waitForStatus(reader, 'Trace logging on', 10000),
      `${name} did not toggle trace logging; screen was:\n${reader.raw()}`);
    await reader.press('Down');
    await reader.press('t');
    assert.ok(await waitForRow(reader, 'Trace Log'),
      `${name} did not open the trace reading surface; screen was:\n${reader.raw()}`);
    await reader.press('j');
    assert.match(reader.raw(), /Trace Log/,
      `${name} let j escape from the trace log`);
    await reader.press('/');
    await reader.typeKeys('trace');
    assert.ok(await waitForStatus(reader, 'matching "trace"', 5000),
      `${name} did not explicitly filter the trace log; status was ${reader.status()}; screen was:\n${reader.raw()}`);
    await reader.press('C-u');
    await reader.press('Escape');
    await reader.press('Escape');
    assert.ok(await waitForTitle(reader, 'Screen stack fixture'),
      `${name} did not return from the trace log`);

    // The wizard owns the whole terminal and its own key loop, while still
    // being the stack's top screen.
    await reader.press('k');
    assert.ok(await waitForRow(reader, 'keyboard shortcuts'),
      `${name} did not open the keyboard wizard; screen was:\n${reader.raw()}`);
    await reader.press('/');
    await reader.typeKeys('bookmark');
    assert.match(reader.raw(), /bookmark/i,
      `${name} did not explicitly filter wizard actions`);
    await reader.press('BSpace');
    await reader.press('C-u');
    await reader.press('Enter');
    await reader.resize(99, 30);
    assert.match(reader.raw(), /keyboard shortcuts/i,
      `${name} did not redraw the wizard after resize`);
    await reader.resize(COLS, ROWS);
    await reader.press('Escape');
    if (reader.alive()) await reader.press('n');
    assert.ok(await waitForTitle(reader, 'Screen stack fixture'),
      `${name} did not restore the page after the wizard`);

    await reader.quit();
    return profile;
  } finally {
    reader.stop();
  }
}

test('both readers enforce chooser and explicit-reading policy through tmux',
  { skip }, async () => {
    const root = tempDir('tawb-stack-surfaces-');
    const server = await startServer();
    const profiles = [];
    try {
      for (const runtime of RUNTIMES) {
        const profile = await surfaceJourney(root, server, runtime);
        profiles.push(profile);
        await waitForProfileToDrain(profile);
      }
    } finally {
      for (const profile of profiles) killProfile(profile);
      await server.close();
      removeTempDir(root);
    }
  });

// Chromium exposes page alerts through its native accessibility tree. Raising
// one while a filtered library is open proves that a browser input layer can
// temporarily own the tty and return to the same top screen afterwards.
async function layeredDialogJourney(root, server, runtime) {
  server.reset();
  const name = `${runtime.name}-layered-dialog`;
  const profile = path.join(root, name, 'profile');
  const env = environment(root, name);
  const reader = new ReaderTty({
    session: `tawb-layered-dialog-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', 'chromium', '--profile', profile,
      '--no-alt-screen', server.fixture],
    env,
  });
  try {
    await reader.start({ ready: 'Screen stack fixture' });
    await reader.press('C-d');
    await reader.press('Enter');
    assert.ok(await waitForStatus(reader, 'Bookmarked', 10000),
      `${name} did not create the bookmark used by the layered screen`);
    await reader.press('C-o');
    assert.ok(await waitForRow(reader, 'Screen stack fixture'),
      `${name} did not open bookmarks before the dialog`);
    await reader.typeKeys('screen');
    assert.match(selectedLine(reader), /Screen stack fixture/);

    server.armAlert();
    assert.ok(await waitForStatus(reader, 'The browser is asking', 30000),
      `${name} did not notice the browser question above the library`);
    // The title and the status arrive before the accessibility tree has filled
    // in the question's own text. Chromium also drops input for about half a
    // second after showing a dialog as clickjacking protection, which a person
    // never races but a test can.
    await sleep(1200);
    assert.ok(await waitForRow(reader, 'Layered browser question', 10000),
      `${name} did not give the browser question the terminal; screen was:\n${reader.raw()}`);
    await reader.press('End');
    await reader.press('Enter');
    assert.ok(await waitForTitle(reader, 'Bookmarks', 10000),
      `${name} did not restore the library after answering the dialog`);
    assert.ok(await waitForSelection(reader, /Screen stack fixture/),
      `${name} lost the filtered library selection under the dialog; cursor ${JSON.stringify(reader.cursor())}; screen was:\n${reader.raw()}`);
    assert.doesNotMatch(reader.drawn().join('\n'), /Answered layered question/,
      `${name} let the page repaint over the restored library`);

    await reader.press('Escape');
    assert.ok(await waitForDrawn(reader, 'Answered layered question', 15000),
      `${name} did not reveal the answered page after the library popped`);
    await reader.quit();
    return profile;
  } finally {
    reader.stop();
  }
}

test('both readers restore a filtered library after a browser dialog through tmux',
  { skip }, async () => {
    const root = tempDir('tawb-layered-dialog-');
    const server = await startServer();
    const profiles = [];
    try {
      for (const runtime of RUNTIMES) {
        const profile = await layeredDialogJourney(root, server, runtime);
        profiles.push(profile);
        await waitForProfileToDrain(profile);
      }
    } finally {
      for (const profile of profiles) killProfile(profile);
      await server.close();
      removeTempDir(root);
    }
  });

async function optionsJourney(root, server, runtime) {
  const name = `${runtime.name}-lynx-options-stack`;
  const profile = path.join(root, name, 'profile');
  const env = environment(root, name);
  const config = path.join(env.XDG_CONFIG_HOME, 'tawb');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.lynx.json'),
    JSON.stringify({ version: 1, lynx: { showCursor: true } }));
  const reader = new ReaderTty({
    session: `tawb-options-stack-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--front-end', 'lynx', '--browser', 'firefox',
      '--profile', profile, '--no-alt-screen', server.fixture],
    env,
  });
  try {
    await reader.start({ ready: 'Screen stack fixture' });
    await reader.press('Down');
    const place = reader.cursor();
    const line = selectedLine(reader);

    await reader.press('o');
    assert.ok(await waitForRow(reader, 'Options Menu'),
      `${name} did not push Lynx options`);
    await reader.press('S');
    await reader.press('x');
    await reader.press('Escape');
    assert.match(reader.raw(), /Options Menu/,
      `${name} popped options when Escape only cancelled a provisional choice`);
    await reader.resize(97, 30);
    assert.match(reader.raw(), /Options Menu/,
      `${name} did not redraw options after resize`);
    await reader.resize(COLS, ROWS);
    await reader.press('Escape');
    assert.ok(await waitForTitle(reader, 'Screen stack fixture'),
      `${name} did not pop Lynx options`);
    assert.deepEqual(reader.cursor(), place,
      `${name} did not restore the Lynx page place after options`);
    assert.equal(selectedLine(reader), line,
      `${name} did not restore the Lynx page line after options`);

    await reader.press('o');
    assert.ok(await waitForRow(reader, 'Options Menu'));
    await reader.press('r');
    assert.ok(await waitForTitle(reader, 'Screen stack fixture'),
      `${name} did not return with session options in effect`);
    await reader.quit();
    return profile;
  } finally {
    reader.stop();
  }
}

test('both Lynx readers keep options on top and restore the page through tmux',
  { skip }, async () => {
    const root = tempDir('tawb-options-stack-');
    const server = await startServer();
    const profiles = [];
    try {
      for (const runtime of RUNTIMES) {
        const profile = await optionsJourney(root, server, runtime);
        profiles.push(profile);
        await waitForProfileToDrain(profile);
      }
    } finally {
      for (const profile of profiles) killProfile(profile);
      await server.close();
      removeTempDir(root);
    }
  });
