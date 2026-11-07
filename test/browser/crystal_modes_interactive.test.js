'use strict';

// Every keyboard mode, in a real terminal, through both interfaces.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 \
//       node --test --test-concurrency=1 test/browser/crystal_modes_interactive.test.js
//
// The state tests cover each mode's own policy, and the browser differentials
// cover the actions those modes reach. What none of them proves is that a key
// reaches the mode at all through a real tty, that the mode owns the status
// row while it is up, or that a reader can leave it again. This drives the
// find, command, page-keyboard, forms, control, file, number, and field-command
// modes through both the default and Lynx interfaces.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile, waitForRow, waitForStatus,
} = require('./tmux_reader');

const skip = browserTestSkip();

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Modes fixture</title></head>
<body>
  <h1>Modes fixture</h1>
  <p>A quiet quokka sits in this paragraph.</p>
  <p><a href="#quokka-target">Quokka numbered link</a></p>
  <p id="quokka-target">The quokka target.</p>
  <label>Your name <input aria-label="Name field"></label>
  <button>Submit button</button>
  <label>Attach a file <input type="file" aria-label="Attachment field"></label>
  <label>Color choice <select aria-label="Color choice">
    <option>Red</option><option>Green</option><option>Blue</option>
  </select></label>
  <label>Screen light <input type="range" aria-label="Brightness slider" min="0" max="100" value="50"></label>
</body></html>`;

function selectedLine(reader) {
  return reader.rows()[reader.cursor().row].trim();
}

async function waitForStatusMatch(reader, pattern, timeout = 10000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(reader.status())) return true;
    await sleep(200);
  }
  return pattern.test(reader.status());
}

async function waitForRaw(reader, pattern, timeout = 10000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(reader.raw())) return true;
    await sleep(200);
  }
  return pattern.test(reader.raw());
}

async function moveToField(reader, pattern, limit = 10) {
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return;
    await reader.press('f');
  }
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return;
    await reader.press('F');
  }
  assert.ok(pattern.test(selectedLine(reader)),
    `never reached field ${pattern}; selected ${selectedLine(reader)}`);
}

async function moveTo(reader, pattern, limit = 30) {
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return;
    await reader.press('Down');
  }
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return;
    await reader.press('Up');
  }
  assert.ok(pattern.test(selectedLine(reader)),
    `never reached ${pattern}; selected ${selectedLine(reader)}; screen was:\n${reader.raw()}`);
}

function settings(root, name, lynx) {
  if (!lynx) return;
  const config = path.join(root, name, 'config', 'tawb');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'settings.lynx.json'), JSON.stringify({
    version: 1,
    lynx: {
      keypadMode: 'LINKS_ARE_NUMBERED',
      textfieldsNeedActivation: false,
      showCursor: true,
    },
  }));
}

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/fixture`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function runJourney(root, runtime, interfaceName, server) {
  const lynx = interfaceName === 'lynx';
  const name = `${runtime.name}-${interfaceName}-modes`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  settings(root, name, lynx);
  const reader = new ReaderTty({
    session: `tawb-modes-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [
      ...runtime.args,
      ...(lynx ? ['--front-end', 'lynx'] : []),
      '--browser', 'firefox', '--profile', profile,
      '--no-alt-screen', server.url,
    ],
    env: environment(root, name),
  });
  const pageKeyboard = lynx ? 'C-\\' : 'M-k';
  const attachment = path.join(root, name, 'sample.txt');
  fs.writeFileSync(attachment, 'attached text\n');
  const seen = {};
  try {
    await reader.start({ ready: 'Modes fixture' });

    // Find: the prompt owns the status row, and Enter lands on the match.
    await reader.press('/');
    assert.equal(reader.status(), '/', `${name} did not draw the find prompt`);
    assert.match(reader.raw(), /Find — Enter/, `${name} did not name the find mode`);
    await reader.type('quiet quokka');
    await reader.press('Enter');
    assert.ok(await waitForStatus(reader, 'quiet quokka', 10000),
      `${name} did not report the find result`);
    seen.find = selectedLine(reader);
    assert.match(seen.find, /quiet quokka/, `${name} did not land on the matching text`);

    // Command: a name on the status row runs the same action its key does.
    await reader.press(':');
    assert.match(reader.status(), /Command/, `${name} did not open the command prompt`);
    await reader.type('Find forward');
    await reader.press('Enter');
    assert.equal(reader.status(), '/', `${name} did not run the chosen command`);
    await reader.press('Escape');
    assert.ok(await waitForStatus(reader, 'Search cancelled', 10000),
      `${name} did not leave the command-chosen find prompt`);

    // Page keyboard: the mode is entered and left by the same chord, and the
    // page remains the thing the terminal is showing.
    await reader.press(pageKeyboard);
    assert.ok(await waitForStatus(reader, 'Webpage keyboard on', 10000),
      `${name} did not enter webpage keyboard mode; status ${reader.status()}`);
    assert.match(reader.raw(), /Modes fixture/);
    await reader.press(pageKeyboard);
    assert.ok(await waitForStatus(reader, 'Webpage keyboard off', 10000),
      `${name} did not leave webpage keyboard mode; status ${reader.status()}`);
    // Leaving page mode asks the live ticker for a fresh scan once the reader
    // pauses. Let that scan finish before steering by the cursor again.
    await sleep(1500);

    // Forms: Tab from a text field lands on a button in forms mode, and Escape
    // gives the ordinary keyboard back.
    await moveTo(reader, /Name field/);
    // Lynx enters a text field as soon as an arrow lands on it; the ordinary
    // interface needs Enter first.
    if (!lynx) await reader.press('Enter');
    await reader.type('Ada');
    await reader.press('Tab');
    if (lynx) {
      // Lynx has no separate forms mode: Tab lands on the control and the
      // browse map keeps the keyboard, exactly as its line editor does.
      assert.ok(await waitForStatus(reader, 'Next control: Submit button', 10000),
        `${name} did not move Tab to the button; screen was:\n${reader.raw()}`);
    } else {
      assert.ok(await waitForRaw(reader, /Forms —/, 10000),
        `${name} did not enter forms mode at the button; screen was:\n${reader.raw()}`);
      await reader.press('Escape');
      assert.ok(await waitForStatus(reader, 'Left forms mode', 10000),
        `${name} did not leave forms mode`);
    }

    // Chooser: Enter on a native select opens its own list, the arrows move
    // through it, and Enter writes the choice back to the page. Escape on the
    // next visit leaves the selection as it was.
    if (lynx) {
      await moveTo(reader, /Color choice/);
      await reader.press('Escape');
    } else {
      await moveToField(reader, /Color choice/);
    }
    await reader.press('Enter');
    assert.ok(await waitForRaw(reader, /Choosing —/),
      `${name} did not open the select list; screen:\n${reader.raw()}`);
    await reader.press('Down');
    await reader.press('Down');
    await reader.press('Enter');
    assert.ok(await waitForStatus(reader, 'Chose "Blue".', 10000),
      `${name} did not choose the select option; status ${reader.status()}`);
    if (lynx) {
      await moveTo(reader, /Color choice/);
      await reader.press('Escape');
    } else {
      await moveToField(reader, /Color choice/);
    }
    await reader.press('Enter');
    assert.ok(await waitForRaw(reader, /Choosing —/),
      `${name} did not reopen the select list; screen:\n${reader.raw()}`);
    await reader.press('Escape');
    assert.ok(await waitForStatus(reader, 'Left "Color choice" as it was.', 10000),
      `${name} did not cancel the select list; status ${reader.status()}`);

    // Control: Enter on a slider takes the arrows, and Escape stops.
    await moveTo(reader, /Brightness slider/);
    // Lynx arrows onto a field enter its line editor; Escape leaves that and
    // gives Enter the control itself.
    if (lynx) await reader.press('Escape');
    await reader.press('Enter');
    assert.ok(await waitForStatus(reader, 'Controlling "Brightness slider"', 10000),
      `${name} did not enter control mode; status ${reader.status()}`);
    await reader.press('End');
    assert.ok(await waitForStatus(reader, 'Brightness', 10000),
      `${name} did not report a slider adjustment`);
    await reader.press('Escape');
    assert.ok(await waitForStatus(reader, 'Stopped controlling "Brightness slider"', 10000),
      `${name} did not leave control mode`);

    // Files: a file input is answered by a path on the status row, not by a
    // desktop chooser that neither reader can reach.
    await moveTo(reader, /Attachment field/);
    await reader.press('Enter');
    assert.match(reader.status(), /^File:/, `${name} did not open the file prompt`);
    await reader.type(attachment);
    await reader.press('Enter');
    assert.ok(await waitForStatus(reader, 'Attached sample.txt', 10000),
      `${name} did not attach the named file; status ${reader.status()}`);

    if (lynx) {
      // Number: the link number prompt moves to a numbered link without
      // following it.
        await reader.press('0');
      assert.match(reader.status(), /Follow link/, `${name} did not open the number prompt`);
      await reader.press('1');
      await reader.press('g');
      assert.ok(await waitForStatus(reader, 'Link 1.', 10000),
        `${name} did not move to link 1; status ${reader.status()}`);
      seen.number = selectedLine(reader);

      // Field command: Ctrl+V hands one browse command back while the field
      // is being edited, and Escape returns to the field.
        await moveTo(reader, /Name field/);
      await reader.type('Ada');
      await reader.press('C-v');
      assert.ok(await waitForStatus(reader, 'Command:', 10000),
        `${name} did not enter field-command mode; status ${reader.status()}`);
      await reader.press('Escape');
      assert.ok(await waitForStatus(reader, 'Command cancelled', 10000),
        `${name} did not return to the field after cancelling the command`);
      await reader.press('Escape');
    }

    // Address: the bar takes the hint row and gives the page back on Escape
    // without navigating anywhere. The ordinary interface edits the current
    // address; Lynx's g starts an empty one.
    await reader.press(lynx ? 'g' : 'C-l');
    assert.ok(await waitForRaw(reader, /Address — Enter: go/),
      `${name} did not open the address bar`);
    await reader.press('Escape');
    assert.ok(await waitForRow(reader, 'Modes fixture', 10000),
      `${name} did not return to the page after the address bar`);
    assert.doesNotMatch(reader.raw(), /Address — Enter: go/,
      `${name} left the address hint up after cancelling`);

    // The browser's own bookmark list is a screen of its own: it replaces the
    // page and closing it puts the reader back where they were standing.
    await reader.press(lynx ? 'v' : 'C-o');
    assert.ok(await waitForStatusMatch(reader, /Nothing here yet|entr/, 20000),
      `${name} did not draw the bookmarks list; status ${reader.status()}`);
    await reader.press('Escape');
    assert.ok(await waitForStatus(reader, 'Closed bookmarks.', 10000),
      `${name} did not close the bookmarks list; status ${reader.status()}`);

    // The keyboard screen shares the session's screen rather than taking an
    // alternate one, and leaving it asks about saving before the page returns.
    await reader.press(lynx ? 'k' : 'M-?');
    assert.ok(await waitForRaw(reader, /keyboard shortcuts/i),
      `${name} did not draw the keyboard screen`);
    await reader.press('Escape');
    assert.ok(await waitForRaw(reader, /Save keyboard changes\? y\/n/),
      `${name} did not ask about saving the keyboard`);
    await reader.press('n');
    assert.ok(await waitForStatus(reader, 'Keyboard shortcuts unchanged.', 10000),
      `${name} did not leave the keyboard screen; status ${reader.status()}`);
    assert.ok(await waitForRow(reader, 'Modes fixture', 10000),
      `${name} did not return to the page after the keyboard screen`);

    if (lynx) {
      // Options is a Lynx screen: it owns the whole terminal and Escape
      // restores the page without keeping any provisional change.
      await reader.press('o');
      assert.ok(await waitForRaw(reader, /Options/),
        `${name} did not draw the options screen`);
      await reader.press('Escape');
      assert.ok(await waitForStatus(reader, 'Options unchanged.', 10000),
        `${name} did not leave the options screen; status ${reader.status()}`);
      assert.ok(await waitForRow(reader, 'Modes fixture', 10000),
        `${name} did not return to the page after the options screen`);
    }

    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [], `${name} left a profile process`);
    return { name, seen, profile };
  } finally {
    reader.stop();
  }
}

for (const interfaceName of ['default', 'lynx']) {
  test(`both readers reach every mode through the ${interfaceName} interface`,
    { skip }, async () => {
      const root = tempDir(`tawb-modes-${interfaceName}-`);
      const server = await startServer();
      const profiles = [];
      try {
        const seen = [];
        for (const runtime of RUNTIMES) {
          const run = await runJourney(root, runtime, interfaceName, server);
          profiles.push(run.profile);
          seen.push(run.seen);
        }
        assert.deepEqual(seen[1], seen[0],
          `the ${interfaceName} modes ended in different places`);
      } finally {
        for (const profile of profiles) killProfile(profile);
        await server.close();
        removeTempDir(root);
      }
    });
}
