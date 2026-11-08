'use strict';

// Terminal edges the ordinary key path does not reach: an application-cursor
// mode keyboard and the end of input while the reader is idle.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 \
//       node --test --test-concurrency=1 test/browser/crystal_terminal_edges.test.js
//
// A terminal in application-cursor mode sends arrows as SS3 (`ESC O A`)
// rather than CSI (`ESC [ A`). The reader must treat the two as the same
// key or a real terminal can move the cursor differently from every tmux
// test that only ever sent `Down`. The test writes the raw bytes to the tty,
// reads the screen back through tmux, and compares both runtimes.
//
// The second edge is EOF. A pty cannot deliver EOF while a program holds it
// in raw mode, and `C-d` is an ordinary byte there, so the reader is started
// with its standard input on a named pipe while its output still goes to the
// tmux pane. Closing the writer while the reader is idle in browse mode ends
// the keyboard. Both runtimes have to leave the reading loop, close the
// browser they started, and leave no process naming the profile. The test
// never signals the reader and never presses a key to quit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile, waitForRow, waitForStatus,
} = require('./tmux_reader');

const skip = browserTestSkip();
const EOF_BUDGET_MS = 15000;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Terminal edge fixture</title></head><body>
<h1>Terminal edge fixture</h1>
${Array.from({ length: 40 }, (unused, i) => `<p>Edge paragraph ${i}.</p>`).join('\n')}
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
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function openReader(root, runtime, origin, name, options = {}) {
  const profile = path.join(root, name, 'profile');
  const env = environment(root, name);
  const args = [...runtime.args, '--browser', 'firefox', '--profile', profile,
    '--no-alt-screen', `${origin}/`];
  let command = runtime.command;
  let commandArgs = args;
  if (options.stdin) {
    env.TAWB_TEST_STDIN = options.stdin;
    command = 'sh';
    commandArgs = ['-c', 'exec "$0" "$@" < "$TAWB_TEST_STDIN"', runtime.command, ...args];
  }
  return {
    profile,
    reader: new ReaderTty({
      session: `tawb-terminal-edge-${name}-${process.pid}`.toLowerCase(),
      command,
      args: commandArgs,
      env,
    }),
  };
}

async function ss3Run(root, runtime, origin) {
  const name = `${runtime.name}-ss3`;
  const { reader, profile } = openReader(root, runtime, origin, name);
  try {
    await reader.start({ ready: 'Terminal edge fixture' });
    await reader.press('=');
    assert.ok(await waitForStatus(reader, 'line ', 15000),
      `${runtime.name} never reported its position on the edge fixture`);
    const before = reader.cursor();
    // Two SS3 downs and one SS3 up: exactly what an application-cursor-mode
    // terminal sends for Down, Down, Up.
    await reader.type('\x1bOB', { settle: 250 });
    await reader.type('\x1bOB', { settle: 250 });
    const afterDown = reader.cursor();
    await reader.type('\x1bOA', { settle: 250 });
    const after = reader.cursor();
    const drawn = reader.drawn();
    const status = reader.status();
    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${runtime.name} left a browser running after quitting`);
    return { before, afterDown, after, drawn, status };
  } finally {
    reader.stop();
    killProfile(profile);
  }
}

test('both readers follow SS3 arrows from an application-cursor-mode terminal',
  { skip }, async () => {
    const root = tempDir('tawb-terminal-ss3-');
    const server = await startServer();
    try {
      const seen = [];
      for (const runtime of RUNTIMES) seen.push(await ss3Run(root, runtime, server.origin));
      const [javascript, crystal] = seen;
      // The keys did something, and both runtimes agree about what.
      assert.ok(javascript.afterDown.row > javascript.before.row
        || javascript.afterDown.column !== javascript.before.column,
        'the JavaScript reader did not move on an SS3 arrow');
      assert.ok(crystal.afterDown.row > crystal.before.row
        || crystal.afterDown.column !== crystal.before.column,
        'the Crystal reader did not move on an SS3 arrow');
      assert.deepEqual(crystal.before, javascript.before,
        'the two readers started from different places');
      assert.deepEqual(crystal.afterDown, javascript.afterDown,
        'the two readers moved differently on SS3 Down');
      assert.deepEqual(crystal.after, javascript.after,
        'the two readers returned differently on SS3 Up');
      assert.deepEqual(crystal.drawn, javascript.drawn,
        'the two readers drew different screens after the SS3 keys');
      assert.equal(crystal.status, javascript.status,
        'the two readers reported different status rows after the SS3 keys');
    } finally {
      await server.close();
      removeTempDir(root);
    }
  });

async function eofRun(root, runtime, origin) {
  const name = `${runtime.name}-eof`;
  const fifo = path.join(root, name, 'stdin.pipe');
  fs.mkdirSync(path.dirname(fifo), { recursive: true });
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr || made.error}`);

  const { reader, profile } = openReader(root, runtime, origin, name, { stdin: fifo });
  // The writer has to exist before the pane's shell can finish opening the
  // pipe for reading. It closes only when this test says so.
  const holder = spawn('sh', ['-c', 'exec 3>"$0"; read _; exec 3>&-', fifo],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  try {
    await reader.start({ ready: 'Terminal edge fixture' });
    assert.ok(await waitForRow(reader, 'Edge paragraph 0.', 15000),
      `${runtime.name} never settled on the edge fixture`);
    // Idle in browse mode: the page is drawn, no key is pending, and no
    // prompt or mode owns the keyboard.
    await sleep(750);
    assert.ok(reader.alive(), `${runtime.name} left before its input ended`);
    const drawn = reader.drawn();
    holder.stdin.write('close\n');
    for (const deadline = Date.now() + EOF_BUDGET_MS; Date.now() < deadline;) {
      await sleep(100);
      if (!reader.alive()) break;
    }
    assert.ok(!reader.alive(),
      `${runtime.name} did not leave within ${EOF_BUDGET_MS}ms of end of input`);
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${runtime.name} left a browser running after end of input`);
    assert.deepEqual(processesUsing(profile), [],
      `${runtime.name} left a process naming its profile`);
    return { drawn };
  } finally {
    holder.kill();
    reader.stop();
    killProfile(profile);
  }
}

test('both readers leave from end of input while idle in browse mode',
  { skip }, async () => {
    const root = tempDir('tawb-terminal-eof-');
    const server = await startServer();
    try {
      const seen = [];
      for (const runtime of RUNTIMES) seen.push(await eofRun(root, runtime, server.origin));
      assert.deepEqual(seen[1].drawn, seen[0].drawn,
        'the two readers were showing different pages when their input ended');
    } finally {
      await server.close();
      removeTempDir(root);
    }
  });
