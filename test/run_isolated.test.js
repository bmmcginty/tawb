'use strict';

// The test harness must leave nothing behind, including when it is killed
// outright.
//
// A browser is launched detached, so it is not in the harness's process group
// and no signal to the harness reaches it. The harness's own signal handlers
// cover an exit and a catchable signal, but not SIGKILL. A detached guardian,
// started with the run, finishes the cleanup when the shell goes down. This
// exercises that path with a fake browser — a process that names the run's
// temporary directory the way a real one names its profile — so it needs no
// real browser and stays fast.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

function startHarness(under, script) {
  return spawn(WRAPPER, ['sh', '-c', script], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TMPDIR: under },
  });
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
