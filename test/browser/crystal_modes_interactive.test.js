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
  waitForProfileToDrain, killProfile, waitForStatus,
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
  <label>Screen light <input type="range" aria-label="Brightness slider" min="0" max="100" value="50"></label>
</body></html>`;

function selectedLine(reader) {
  return reader.rows()[reader.cursor().row].trim();
}

async function waitForRaw(reader, pattern, timeout = 10000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(reader.raw())) return true;
    await sleep(200);
  }
  return pattern.test(reader.raw());
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
