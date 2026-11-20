'use strict';

// A key pressed after the tab it named has gone. An OAuth popup is the shape
// that produced this in the wild: the browser removes the whole top-level
// context, and every later command — including `r` — used to answer with the
// protocol's own "no such frame" text and end the session.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 \
//       TAWB_CRYSTAL_BIN=/path/to/tawb \
//       node --test --test-concurrency=1 test/browser/frame_loss_recovery.test.js
//
// The popup closes itself, so no clickable page content is involved; what is
// asserted is that the reader survives, stays on the parent tab, and never
// prints the browsing-context identifier.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
} = require('./tmux_reader');

const skip = browserTestSkip();
const RAW_FRAME_ERROR = /no such frame|Browsing Context with id .+ not found/i;

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    if (req.url === '/popup') {
      res.end(`<!doctype html><title>Sign-in popup</title>
        <h1>Sign-in popup</h1><p>Choose an account.</p>
        <script>setTimeout(() => window.close(), 3500);</script>`);
      return;
    }
    res.end(`<!doctype html><title>Start page</title>
      <h1>Start page</h1>
      <p><a href="/popup" target="_blank">Open sign-in</a></p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function selectedLine(reader) {
  return reader.rows()[reader.cursor().row].trim();
}

async function moveTo(reader, pattern, limit = 20) {
  for (let step = 0; step < limit; step += 1) {
    if (pattern.test(selectedLine(reader))) return;
    await reader.press('Down');
  }
  assert.ok(pattern.test(selectedLine(reader)),
    `never reached ${pattern}; selected ${selectedLine(reader)}`);
}

async function waitFor(reader, pattern, timeout = 12000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    await sleep(200);
    if (pattern.test(reader.raw())) return true;
  }
  return pattern.test(reader.raw());
}

function openReader(root, runtime, address) {
  const name = `frame-loss-${runtime.name}`;
  return new ReaderTty({
    session: `tawb-frame-loss-${runtime.name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', 'firefox', '--profile',
      path.join(root, name, 'profile'), '--no-alt-screen', address],
    env: environment(root, name),
  });
}

for (const runtime of RUNTIMES) {
  test(`a ${runtime.name} reader survives a closed sign-in tab and rescans`,
    { skip }, async () => {
      const root = tempDir(`tawb-frame-loss-${runtime.name}-`);
      const server = await startServer();
      const reader = openReader(root, runtime, `${server.origin}/`);
      try {
        await reader.start({ ready: 'Start page' });
        await moveTo(reader, /Open sign-in/);
        await reader.press('Enter');
        assert.ok(await waitFor(reader, /sign-in/i),
          `${runtime.name} never followed the popup:\n${reader.raw()}`);
        // Reach the popup explicitly if the reader announced it in the
        // background instead of switching.
        if (!/Sign-in popup/.test(reader.raw())) {
          await reader.press('>');
          assert.ok(await waitFor(reader, /Sign-in popup/),
            `${runtime.name} never switched to the popup:\n${reader.raw()}`);
        }
        // The popup closes itself while the reader is reading it.
        await sleep(4500);
        await reader.press('r');
        await sleep(1500);
        assert.ok(reader.alive(),
          `${runtime.name} exited after rescanning a closed tab:\n${reader.raw()}`);
        assert.doesNotMatch(reader.raw(), RAW_FRAME_ERROR,
          `${runtime.name} printed the protocol's frame error:\n${reader.raw()}`);
        assert.ok(await waitFor(reader, /Start page/),
          `${runtime.name} did not return to the live tab:\n${reader.raw()}`);
      } finally {
        reader.stop();
        await server.close();
        removeTempDir(root);
      }
    });
}
