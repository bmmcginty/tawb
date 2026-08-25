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

const { processAlive, killProcessGroup, processesUsing, anyProcessUsing } = require('../src/proc');

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
