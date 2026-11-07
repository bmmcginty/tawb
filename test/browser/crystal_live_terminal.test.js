'use strict';

// Live regions as a person with a terminal actually meets them.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_live_terminal.test.js
//
// The scripted reader tests pin the hold time and queue policy, and the browser
// differential proves the observer sees a mutation. Neither shows that the
// announcement reaches the status row of a real tty, that a second region's
// announcement is not lost behind the first, or that both runtimes word the row
// the same way. This drives one polite and one assertive region through both
// interfaces and compares the rows.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile,
} = require('./tmux_reader');

const skip = browserTestSkip();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Announcements fixture</title></head>
<body>
  <h1>Announcements fixture</h1>
  <div role="status" id="polite">Nothing yet</div>
  <div role="alert" id="assertive">Quiet</div>
  <p>A steady paragraph between the two regions.</p>
  <script>
    setTimeout(() => {
      document.getElementById('polite').textContent = 'Five results';
    }, 1000);
    setTimeout(() => {
      document.getElementById('assertive').textContent = 'Connection lost';
    }, 6000);
  </script>
</body></html>`;

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

async function waitForStatus(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.status().includes(text)) return true;
    await sleep(100);
  }
  return reader.status().includes(text);
}

async function announcementRun(root, runtime, interfaceName, server) {
  const lynx = interfaceName === 'lynx';
  const name = `${runtime.name}-${interfaceName}-announcements`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const reader = new ReaderTty({
    session: `tawb-announcements-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [
      ...runtime.args,
      ...(lynx ? ['--front-end', 'lynx'] : []),
      '--browser', 'firefox', '--profile', profile,
      '--no-alt-screen', server.url,
    ],
    env: environment(root, name),
  });
  try {
    await reader.start({ ready: 'Announcements fixture' });
    assert.ok(await waitForStatus(reader, 'Five results'),
      `${name} never announced the polite region; status ${reader.status()}`);
    const polite = reader.status();
    // The assertive region changes well after the polite hold expires, so its
    // row is the second announcement rather than a replacement of the first.
    assert.ok(await waitForStatus(reader, 'Connection lost', 20000),
      `${name} never announced the assertive region; status ${reader.status()}`);
    const assertive = reader.status();
    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [], `${name} left a profile process`);
    return { polite, assertive, profile };
  } finally {
    reader.stop();
  }
}

for (const interfaceName of ['default', 'lynx']) {
  test(`both readers put live announcements on the ${interfaceName} status row`,
    { skip }, async () => {
      const root = tempDir(`tawb-announcements-${interfaceName}-`);
      const server = await startServer();
      const profiles = [];
      try {
        const seen = [];
        for (const runtime of RUNTIMES) {
          const run = await announcementRun(root, runtime, interfaceName, server);
          profiles.push(run.profile);
          seen.push({ polite: run.polite, assertive: run.assertive });
        }
        assert.deepEqual(seen[1], seen[0],
          `the ${interfaceName} readers worded an announcement differently`);
      } finally {
        for (const profile of profiles) killProfile(profile);
        await server.close();
        removeTempDir(root);
      }
    });
}
