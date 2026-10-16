'use strict';

// The test harness must leave nothing behind, including when it is killed
// outright.
//
// A browser is launched detached, so it is not in the harness's process group
// and no signal to the harness reaches it. The harness's own signal handlers
// cover an exit and a catchable signal, but not SIGKILL. What does cover it is
// a PID namespace of the run's own, whose init exiting takes every process in
// it down whatever group each chose, and, outside that, a detached guardian
// that finishes the cleanup when the shell goes down. This exercises both
// paths with a fake browser — a process that names the run's temporary
// directory the way a real one names its profile — so it needs no real browser
// and stays fast.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, removeTempDir } = require('./tmpdir');
const { processesUsing } = require('../src/proc');

const ROOT = path.join(__dirname, '..');
const WRAPPER = path.join(ROOT, 'tools', 'run_isolated.sh');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

// A long-lived process whose command line names the run's profile directory,
// which is how every part of a real run is findable.
const FAKE_BROWSER = 'setsid sh -c "while :; do sleep 1; done" fake-browser '
  + '--user-data-dir="$TMPDIR/profile" &';

function runDirs(under) {
  return fs.readdirSync(under).filter((name) => name.startsWith('tawb-run-'));
}

function startHarness(under, script, extraEnv = {}) {
  return spawn(WRAPPER, ['sh', '-c', script], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv, TMPDIR: under },
  });
}

// Whether the kernel and container allow the nested namespace the harness
// prefers. The probe is the same one the harness runs, so a skip here means
// the fallback is the path under test rather than a test that cannot run.
function canUnshare() {
  if (process.env.TAWB_NO_NAMESPACE) return false;
  return spawnSync(
    'unshare',
    ['--map-current-user', '--pid', '--fork', '--mount-proc', '--kill-child=SIGKILL', 'true'],
    { stdio: 'ignore' },
  ).status === 0;
}

function cleanUp(under, harness) {
  if (harness) {
    try { process.kill(-harness.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const pid of processesUsing(under)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  removeTempDir(under);
}

// Wait until the fake browser is up and report the profile it named.
async function waitForBrowser(under) {
  let profile = null;
  const up = await waitFor(() => {
    const dirs = runDirs(under);
    if (dirs.length === 0) return false;
    profile = path.join(under, dirs[0], 'profile');
    return processesUsing(profile).length > 0;
  });
  return up ? profile : null;
}

test('a harness killed with SIGKILL still leaves nothing behind', async () => {
  const under = tempDir('tawb-isolated-');
  let harness = null;
  try {
    harness = startHarness(under, `${FAKE_BROWSER} sleep 300`);
    const profile = await waitForBrowser(under);
    assert.ok(profile, 'the fake browser never started');

    harness.kill('SIGKILL');

    assert.ok(await waitFor(() => processesUsing(profile).length === 0),
      'the guardian did not reap the process the run left');
    assert.ok(await waitFor(() => runDirs(under).length === 0),
      'the run directory was not removed');
  } finally {
    cleanUp(under, harness);
  }
});

test('a harness that finishes still leaves nothing behind', async () => {
  const under = tempDir('tawb-isolated-');
  let harness = null;
  try {
    // The command exits at once, leaving the detached fake browser behind:
    // exactly the case the shell's own exit cleanup has to catch.
    harness = startHarness(under, `${FAKE_BROWSER} true`);
    const exited = await new Promise((resolve) => harness.on('exit', resolve));
    assert.equal(exited, 0, 'the harness did not exit cleanly');
    harness = null;

    assert.ok(await waitFor(() => processesUsing(path.join(under, 'tawb-run-')).length === 0),
      'a process the run left survived a clean exit');
    assert.ok(await waitFor(() => runDirs(under).length === 0),
      'the run directory was not removed after a clean exit');
  } finally {
    cleanUp(under, harness);
  }
});

// A helper a session bus started carries none of the run's environment, so the
// guardian's environment match cannot see it. Inside a namespace it does not
// need to: the helper is in the namespace, and the namespace goes down with
// its init. Nothing here names the run directory either.
test('a namespace takes down a helper that carries none of the run environment',
  { skip: !canUnshare() }, async () => {
    const under = tempDir('tawb-isolated-');
    const token = `tawb-foreign-helper-${process.pid}-${Date.now()}`;
    let harness = null;
    try {
      harness = startHarness(under,
        `setsid sh -c "while :; do sleep 1; done" ${token} & sleep 300`);
      assert.ok(await waitFor(() => processesUsing(token).length > 0),
        'the helper never started');

      harness.kill('SIGKILL');

      assert.ok(await waitFor(() => processesUsing(token).length === 0),
        'the namespace did not take the helper down with the run');
    } finally {
      cleanUp(under, harness);
      for (const pid of processesUsing(token)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

// With the namespace refused, the guardian outside the run is what finishes
// the job, and the run directory still has to go.
test('the guardian finishes a run when the namespace is refused', async () => {
  const under = tempDir('tawb-isolated-');
  let harness = null;
  try {
    harness = startHarness(under, `${FAKE_BROWSER} sleep 300`, { TAWB_NO_NAMESPACE: '1' });
    const profile = await waitForBrowser(under);
    assert.ok(profile, 'the fake browser never started');

    harness.kill('SIGKILL');

    assert.ok(await waitFor(() => processesUsing(profile).length === 0),
      'the guardian did not reap the process the run left');
    assert.ok(await waitFor(() => runDirs(under).length === 0),
      'the run directory was not removed');
  } finally {
    cleanUp(under, harness);
  }
});
