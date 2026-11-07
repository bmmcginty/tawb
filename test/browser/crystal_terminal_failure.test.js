'use strict';

// The terminal's own failure boundary: a signal and a resize arriving while a
// browser command is still outstanding.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 \
//       node --test --test-concurrency=1 test/browser/crystal_terminal_failure.test.js
//
// Resizing only proves the redraw path when the reader is already idle.
// A resize during a slow navigation has to survive the arrival that follows
// it, with the new width and the new height. A signal during that same
// navigation has to leave in bounded time and still close the browser, the
// broker and the tab it opened. The tmux pane is the only channel read here:
// neither reader's internal state is inspected.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  COLS, ROWS, RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile, waitForRow,
} = require('./tmux_reader');

const skip = browserTestSkip();
const SLOW_MS = 2500;
const SHUTDOWN_BUDGET_MS = 5000;

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    if (req.url === '/slow') {
      setTimeout(() => {
        if (res.writableEnded) return;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end('<!doctype html><title>Slow page</title><h1>Slow page</h1>'
          + '<p>The slow response arrived.</p>');
      }, SLOW_MS);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end('<!doctype html><title>Start page</title><h1>Start page</h1>'
      + '<p>A steady place to stand.</p><p><a href="/slow">Slow link</a></p>');
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

// Start a navigation that will not answer for SLOW_MS, but do not wait for it.
async function startSlowNavigation(reader) {
  await reader.start({ ready: 'Start page' });
  await moveTo(reader, /Slow link/);
  await reader.press('Enter', { settle: 100, timeout: 1200 });
}

function openReader(root, runtime, address, name) {
  const profile = path.join(root, name, 'profile');
  return {
    profile,
    reader: new ReaderTty({
      session: `tawb-terminal-${name}-${process.pid}`.toLowerCase(),
      command: runtime.command,
      args: [...runtime.args, '--browser', 'firefox', '--profile', profile,
        '--no-alt-screen', address],
      env: environment(root, name),
    }),
  };
}

async function signalRun(root, runtime, origin) {
  const { reader, profile } = openReader(root, runtime, `${origin}/`,
    `${runtime.name}-signal`);
  try {
    await startSlowNavigation(reader);
    const started = Date.now();
    assert.ok(reader.signal('SIGTERM'), 'the reader had no process to signal');
    for (const deadline = Date.now() + SHUTDOWN_BUDGET_MS; Date.now() < deadline;) {
      await sleep(100);
      if (!reader.alive()) break;
    }
    const elapsed = Date.now() - started;
    assert.ok(!reader.alive(),
      `${runtime.name} did not leave within ${SHUTDOWN_BUDGET_MS}ms of SIGTERM`);
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${runtime.name} left a browser running after SIGTERM`);
    return { elapsed, profile, processes: processesUsing(profile) };
  } finally {
    reader.stop();
  }
}

for (const runtime of RUNTIMES) {
  test(`a ${runtime.name} reader leaves a slow navigation when it is signalled`,
    { skip }, async () => {
      const root = tempDir(`tawb-terminal-signal-${runtime.name}-`);
      const server = await startServer();
      try {
        const result = await signalRun(root, runtime, server.origin);
        assert.deepEqual(result.processes, [],
          `${runtime.name} left a process naming its profile`);
        assert.ok(result.elapsed < SHUTDOWN_BUDGET_MS,
          `${runtime.name} spent ${result.elapsed}ms shutting down`);
      } finally {
        await server.close();
        removeTempDir(root);
      }
    });
}

async function resizeRun(root, runtime, origin) {
  const { reader, profile } = openReader(root, runtime, `${origin}/`,
    `${runtime.name}-resize`);
  try {
    await startSlowNavigation(reader);
    await reader.resize(101, 31);
    assert.ok(await waitForRow(reader, 'Slow page', 15000),
      `${runtime.name} did not finish the slow navigation at the new size`);
    // The live refresh can follow the load, so read the screen after it has
    // had the same chance to repaint that a person would give it.
    await sleep(750);
    const drawn = reader.drawn();
    assert.deepEqual(drawn, reader.rows().filter((_row, index) => index !== 30),
      'the resized pane still reports the old height');
    assert.ok(drawn.every((row) => row.length === 101),
      `${runtime.name} did not repaint the resized width`);
    const cursor = reader.cursor();
    assert.ok(cursor.row >= 0 && cursor.row < 31, 'the cursor left the resized pane');
    assert.ok(cursor.column >= 0 && cursor.column < 101, 'the cursor left the resized columns');
    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${runtime.name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [],
      `${runtime.name} left a process naming its profile`);
    return { drawn, profile };
  } finally {
    reader.stop();
  }
}

test('both readers finish a navigation that was resized while it was loading',
  { skip }, async () => {
    const root = tempDir('tawb-terminal-resize-');
    const server = await startServer();
    const profiles = [];
    try {
      const seen = [];
      for (const runtime of RUNTIMES) {
        const run = await resizeRun(root, runtime, server.origin);
        profiles.push(run.profile);
        seen.push(run);
      }
      assert.deepEqual(seen[1].drawn, seen[0].drawn,
        'the two readers drew different screens after the same resize');
    } finally {
      for (const profile of profiles) killProfile(profile);
      await server.close();
      removeTempDir(root);
    }
  });

// A forgotten height would still pass the drawing checks above if both
// readers agreed on a stale one, so pin the geometry the resize asked for.
test('a resize during loading uses the size the terminal now has',
  { skip }, async () => {
    const server = await startServer();
    try {
      const root = tempDir('tawb-terminal-resize-size-');
      try {
        const { reader } = openReader(root, RUNTIMES[RUNTIMES.length - 1],
          `${server.origin}/`, 'size');
        try {
          await startSlowNavigation(reader);
          await reader.resize(101, 31);
          assert.ok(await waitForRow(reader, 'Slow page', 15000));
          assert.equal(reader.rows().length, 31, 'the pane kept its old row count');
          assert.equal(reader.rows()[0].length, 101, 'the pane kept its old column count');
          assert.notDeepEqual([COLS, ROWS], [101, 31]);
        } finally {
          reader.stop();
        }
      } finally {
        removeTempDir(root);
      }
    } finally {
      await server.close();
    }
  });
