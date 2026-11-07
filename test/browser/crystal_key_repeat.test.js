'use strict';

// Keys that keep arriving after a mode transition.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_key_repeat.test.js
//
// A held key does not stop because the reader changed mode under it. The
// failure this looks for is a repeat that lands in the new mode and is taken
// as input there: an arrow key that appends a character to the address bar
// turns a page load into a URL the browser cannot resolve, and the reader
// reports the failure a second later as if the site were broken.
//
// The burst is sent as one tmux write, which is what a tty delivers when a key
// is held: several decoded keys in a single read. The default interface is
// driven here; the Lynx interface keeps its selection on the page through the
// same burst but its own address-mode keys, so the recorded comparison is the
// ordinary interface's.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile,
} = require('./tmux_reader');

const skip = browserTestSkip();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Repeat fixture</title></head>
<body>
<h1>Repeat fixture</h1>
${Array.from({ length: 40 }, (unused, i) => `<p>Repeat paragraph ${i}.</p>`).join('\n')}
<p><a href="#target">Repeat link</a></p>
<p id="target">Repeat target.</p>
</body></html>`;

// Three cursor moves, the key that opens the address bar, then four more keys
// arriving while the address is being edited.
const BURST = ['Down', 'Down', 'Down', 'C-l', 'Down', 'Down', 'Right', 'Right'];

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(PAGE);
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

// One write, several keys: the reader reads them as one chunk, which is what
// a held key looks like to it.
function burst(reader, keys) {
  const sent = spawnSync('tmux', ['send-keys', '-t', reader.session, ...keys],
    { encoding: 'utf8', timeout: 20000 });
  if (sent.status !== 0) {
    throw new Error(`could not send the burst: ${sent.stderr || sent.error}`);
  }
}

async function repeatRun(root, runtime, server) {
  const name = `${runtime.name}-repeat`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const reader = new ReaderTty({
    session: `tawb-repeat-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [
      ...runtime.args,
      '--browser', 'firefox', '--profile', profile,
      '--no-alt-screen', server.url,
    ],
    env: environment(root, name),
  });
  try {
    await reader.start({ ready: 'Repeat fixture' });
    await sleep(1200);
    const before = reader.drawn();
    const addressBefore = before[1];
    burst(reader, BURST);
    await reader.quiet({ settle: 200, timeout: 8000 });
    const during = reader.drawn();
    const addressDuring = during[1];
    const hintDuring = during[2];
    // Escape leaves the address bar without going anywhere, so the page must
    // be exactly what it was before the burst.
    reader.send('Escape');
    await reader.quiet({ settle: 200, timeout: 8000 });
    const after = reader.drawn();
    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [], `${name} left a profile process`);
    return { before, addressBefore, during, addressDuring, hintDuring, after };
  } finally {
    reader.stop();
  }
}

test('both readers ignore held keys that arrive after a mode transition',
  { skip }, async (t) => {
    const root = tempDir('tawb-key-repeat-');
    const server = await startServer();
    const profiles = [];
    try {
      const seen = {};
      for (const runtime of RUNTIMES) {
        profiles.push(path.join(root, `${runtime.name}-repeat`.toLowerCase(), 'profile'));
        seen[runtime.name] = await repeatRun(root, runtime, server);
        t.diagnostic(`${runtime.name} address during the burst: `
          + JSON.stringify(seen[runtime.name].addressDuring.trim()));
      }
      const javascript = seen.JavaScript;
      const crystal = seen.Crystal;

      // The transition happened: the burst reached the address bar, and the
      // keys that arrived afterwards are what could have corrupted it.
      for (const [name, run] of Object.entries(seen)) {
        assert.match(run.hintDuring, /Address/, `${name} did not open the address bar`);
      }
      assert.equal(crystal.addressDuring, javascript.addressDuring,
        'the two readers left different addresses after the same burst');
      // Nothing was typed into the address: it still names the page that was
      // loaded, not that page with an arrow key appended to it.
      assert.equal(crystal.addressDuring.trim(), `[AX] ${server.url}`,
        'a repeated key was taken as address input');
      assert.equal(crystal.addressDuring, crystal.addressBefore);
      assert.deepEqual(crystal.during, javascript.during,
        'the two readers drew different screens after the same burst');
      assert.deepEqual(crystal.after, javascript.after,
        'the two readers drew different screens after leaving the address bar');
      assert.deepEqual(crystal.after, crystal.before,
        'cancelling the address bar did not restore the page');
    } finally {
      for (const profile of profiles) killProfile(profile);
      await server.close();
      removeTempDir(root);
    }
  });
