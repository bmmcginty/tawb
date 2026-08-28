'use strict';

// Killing a browser means killing a process group.
//
// The shape being tested is the one buildCommand creates on a machine with no
// display: we spawn xvfb-run, a shell, and the browser is that shell's child.
// A shell is stood in for here by `sh`, because the point has nothing to do
// with browsers — it is that a signal sent to a shell waiting on a foreground
// command does not reach the command.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const {
  processAlive, killProcessGroup, processesUsing, anyProcessUsing,
  requireBrowserUser, watchChildStartup, compactDiagnostic, browserStartupError,
} = require('../src/proc');

// A shell holding a long-running child, in a process group of its own. Resolves
// once the grandchild has announced its pid, so both are known to be running.
function spawnShellHoldingAChild() {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'sleep 60 & echo "$!"; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    child.on('error', reject);
    child.stdout.once('data', (buf) => {
      const inner = Number(String(buf).trim());
      if (!inner) reject(new Error('the shell did not report its child'));
      else resolve({ child, inner });
    });
  });
}

// Signals are delivered asynchronously; the process is reaped a moment later.
async function goneWithin(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('signalling the process we spawned leaves its child running', async () => {
  const { child, inner } = await spawnShellHoldingAChild();
  try {
    child.kill('SIGTERM');
    assert.ok(await goneWithin(child.pid), 'the shell survived its own SIGTERM');
    // The bug, stated as a fact about the platform: this is why a browser was
    // left behind on every close.
    assert.ok(processAlive(inner), 'the child died with the shell after all');
  } finally {
    killProcessGroup(child.pid, 'SIGKILL');
    try { process.kill(inner, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('signalling the group takes the child down with it', async () => {
  const { child, inner } = await spawnShellHoldingAChild();
  try {
    assert.equal(killProcessGroup(child.pid), true, 'the group refused the signal');
    assert.ok(await goneWithin(child.pid), 'the shell outlived the group signal');
    assert.ok(await goneWithin(inner), 'the child outlived the group signal');
  } finally {
    killProcessGroup(child.pid, 'SIGKILL');
    try { process.kill(inner, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('a process group that has already gone is not an error', () => {
  const { child } = { child: spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore', detached: true }) };
  return new Promise((resolve) => {
    child.on('exit', () => {
      assert.equal(killProcessGroup(child.pid), false, 'a dead group answered the signal');
      assert.equal(killProcessGroup(0), false, 'a missing pid was signalled anyway');
      resolve();
    });
  });
});


// Whether a directory is still being used is the question that decides if it
// can be deleted, and a browser answers it by naming its profile in its own
// arguments — which is the only trace of the association that survives the
// process that set it up.

test('a path a running process names is seen as in use', async () => {
  const marker = `/tmp/tweb-inuse-check-${process.pid}-${Date.now()}`;
  assert.equal(anyProcessUsing(marker), false, 'a path nothing mentions looked busy');

  const holder = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${marker}`],
    { stdio: 'ignore', detached: true });
  holder.unref();
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(processesUsing(marker), [holder.pid], 'the holder was not found');
    assert.equal(anyProcessUsing(marker), true);

    killProcessGroup(holder.pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && processAlive(holder.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(anyProcessUsing(marker), false, 'a path stayed busy after its holder went');
  } finally {
    killProcessGroup(holder.pid, 'SIGKILL');
  }
});

test('asking about nothing is not asking about everything', () => {
  assert.deepEqual(processesUsing(''), [], 'an empty path matched processes');
  assert.equal(anyProcessUsing(null), false);
});

// Browser startup diagnostics have to survive the launcher. Without these,
// Chromium's root refusal was discarded and then misreported as a profile
// conflict, sending the user towards a directory that was not the problem.

test('launching a browser as root is refused without disabling its sandbox', () => {
  assert.throws(
    () => requireBrowserUser('chromium', () => 0),
    /will not launch chromium as root.*normal user account.*--no-sandbox/i,
  );
  assert.doesNotThrow(() => requireBrowserUser('chromium', () => 1000));
});

test('a browser exit reports its status and bounded stderr instead of guessing', async () => {
  const child = spawn('sh', ['-c', 'printf "first line\\nreal failure\\n" >&2; exit 23'], {
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  const startup = watchChildStartup(child);
  await new Promise((resolve) => child.once('close', resolve));

  const err = browserStartupError({
    name: 'test-browser', executable: '/bin/test-browser', profileDir: '/tmp/profile',
    port: 9123, timeoutMs: 25000, state: startup,
  });
  assert.match(err.message, /exited with status 23/);
  assert.match(err.message, /Executable: \/bin\/test-browser/);
  assert.match(err.message, /Profile: \/tmp\/profile/);
  assert.match(err.message, /Browser said: first line real failure/);
  assert.doesNotMatch(err.message, /another browser|profile (?:clash|conflict)/i);
});

test('a browser timeout identifies its port and keeps diagnostics readable', () => {
  const stderr = `ignored-${'x'.repeat(9000)}\n\x1b[31mremote agent unavailable\x1b[0m\n`;
  assert.equal(compactDiagnostic(stderr, 24), 'remote agent unavailable');

  const err = browserStartupError({
    name: 'firefox', executable: '/usr/bin/firefox', profileDir: '/tmp/firefox-profile',
    port: 9333, timeoutMs: 45000,
    state: { exited: false, code: null, signal: null, error: null, stderr: '' },
  });
  assert.match(err.message, /did not open debugging port 9333 within 45s/);
});


// xvfb-run runs its command as `"$@" 2>&1`. Everything the browser says
// therefore arrives on stdout, so a launcher watching stderr alone hears
// nothing at all — which is exactly what a machine with no display reported:
// a timeout, and no browser output to explain it.

test('what the browser says through xvfb-run is not lost with its stderr', async () => {
  // Two shapes: a browser complaining on stderr, and the same complaint after
  // xvfb-run's `2>&1` has folded it into stdout. Both have to reach the user.
  const onStderr = spawn('sh', ['-c', 'printf "cannot open display\\n" >&2; exit 1'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const merged = spawn('sh', ['-c', 'printf "cannot open display\\n" 2>&1; exit 1'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const states = [onStderr, merged].map((child) => watchChildStartup(child));
  await Promise.all([onStderr, merged].map(
    (child) => new Promise((resolve) => child.once('close', resolve)),
  ));
  for (const state of states) {
    const err = browserStartupError({
      name: 'firefox', executable: '/usr/bin/firefox', profileDir: '/tmp/p',
      port: 9000, timeoutMs: 45000, state,
    });
    assert.match(err.message, /Browser said: cannot open display/);
  }
});

test('a startup failure says what display the browser was given', () => {
  const err = browserStartupError({
    name: 'google-chrome-stable',
    executable: '/usr/bin/google-chrome-stable',
    profileDir: '/home/someone/.local/share/tawb/profile',
    port: 43291,
    timeoutMs: 25000,
    state: { exited: false, output: '' },
    context: ['Display: none, so the browser was run under /usr/bin/xvfb-run', null],
  });
  assert.match(err.message, /Display: none, so the browser was run under \/usr\/bin\/xvfb-run/);
  // A silent browser is a fact about the failure, not an absence to leave out.
  assert.match(err.message, /The browser said nothing/);
});
