'use strict';

// Sweeping up what a session that is no longer running left behind: the
// browser it started, and the throwaway directory it was using.
//
// One sweep signals a whole process group by a pid out of a file and the other
// deletes a directory, both of which are large things to be wrong about. Most
// of what is tested here is therefore what they refuse to touch: a live
// session's browser, a browser another reader is in, one left running on
// purpose, a pid that has since been reused, a profile a browser is still
// reading, and a directory tweb never created.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { spawn } = require('node:child_process');

const state = tempDir('tweb-registry-state-');
process.env.XDG_DATA_HOME = state;

const {
  readRegistry, writeRegistry, recordBrowser, forgetBrowser, markKept,
  sweepStrandedBrowsers, stillOurBrowser,
  tempName, ownerOfTempDir, sweepStaleProfiles, tempProfiles,
} = require('../src/registry');
const { claimsPath } = require('../src/session');
const { processAlive, killProcessGroup } = require('../src/proc');

// A stand-in for a browser: a process group whose command line names the
// profile directory it was started with, which is what the sweep checks.
const strays = [];
function fakeBrowser(profileDir) {
  // The extra arguments land in the process's own argv, the way
  // --user-data-dir does on a real Chromium.
  // A loop rather than a single command, because a shell given one command
  // may exec into it and lose the argv this is all about.
  const child = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${profileDir}`], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  strays.push(child.pid);
  return child.pid;
}

async function goneWithin(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test.beforeEach(() => { writeRegistry([]); });

test.after(() => {
  for (const pid of strays) killProcessGroup(pid, 'SIGKILL');
  fs.rmSync(state, { recursive: true, force: true });
});

test('a browser whose session has gone is taken down', async () => {
  const profileDir = path.join(state, 'gone');
  const pid = fakeBrowser(profileDir);
  // Recorded against an owner that is not running: what a session killed
  // outright leaves behind.
  writeRegistry([{ pid, port: 9001, profileDir, engine: 'chromium', owner: 0x7ffffffe, keep: false }]);

  assert.equal(sweepStrandedBrowsers(), 1, 'the stranded browser was left alone');
  assert.ok(await goneWithin(pid), 'the browser outlived the sweep');
  assert.equal(readRegistry().length, 0, 'the swept entry was kept');
});

test('a browser whose session is still running is left alone', () => {
  const profileDir = path.join(state, 'live');
  const pid = fakeBrowser(profileDir);
  recordBrowser({ pid, port: 9002, profileDir, engine: 'chromium' }); // owner is us

  assert.equal(sweepStrandedBrowsers(), 0, 'a live session lost its browser');
  assert.ok(processAlive(pid), 'a live session lost its browser');
  assert.equal(readRegistry().length, 1, 'a live entry was dropped');
});

test('a browser another reader is still in is left alone', () => {
  const profileDir = path.join(state, 'shared');
  const pid = fakeBrowser(profileDir);
  writeRegistry([{ pid, port: 9003, profileDir, engine: 'chromium', owner: 0x7ffffffe, keep: false }]);
  // A tab claim from a reader that is running. It has to be some other
  // process: a claim of our own is not what "another reader" means, and the
  // sweep runs in a session that has not claimed anything yet.
  const reader = spawn('sleep', ['60'], { stdio: 'ignore', detached: true });
  reader.unref();
  strays.push(reader.pid);
  fs.mkdirSync(path.dirname(claimsPath(9003)), { recursive: true });
  fs.writeFileSync(claimsPath(9003), JSON.stringify([{ pid: reader.pid, targetId: 'T', at: Date.now() }]));

  assert.equal(sweepStrandedBrowsers(), 0, 'a browser with a reader in it was killed');
  assert.ok(processAlive(pid), 'a browser with a reader in it was killed');
  fs.rmSync(claimsPath(9003), { force: true });
});

test('a browser left running on purpose is left alone', () => {
  const profileDir = path.join(state, 'kept');
  const pid = fakeBrowser(profileDir);
  recordBrowser({ pid, port: 9004, profileDir, engine: 'chromium' });
  markKept(9004);
  writeRegistry(readRegistry().map((e) => ({ ...e, owner: 0x7ffffffe })));

  assert.equal(sweepStrandedBrowsers(), 0, '--keep-browser lost its browser');
  assert.ok(processAlive(pid), '--keep-browser lost its browser');
  assert.equal(readRegistry()[0].keep, true, 'the keep mark was lost');
});

test('a pid that now belongs to something else is not signalled', () => {
  const profileDir = path.join(state, 'reused');
  // Alive, but its command line does not name the profile: the number was
  // reused by a process that has nothing to do with us.
  const pid = fakeBrowser(path.join(state, 'somebody-else'));
  writeRegistry([{ pid, port: 9005, profileDir, engine: 'chromium', owner: 0x7ffffffe, keep: false }]);

  assert.equal(stillOurBrowser(pid, profileDir), false, 'an unrelated process was claimed as ours');
  assert.equal(sweepStrandedBrowsers(), 0, 'an unrelated process group was signalled');
  assert.ok(processAlive(pid), 'an unrelated process was killed');
  assert.equal(readRegistry().length, 0, 'a stale entry was kept');
});

test('an entry for a process that has already gone is simply dropped', async () => {
  const pid = fakeBrowser(path.join(state, 'dead'));
  killProcessGroup(pid, 'SIGKILL');
  await goneWithin(pid);
  writeRegistry([{ pid, port: 9006, profileDir: path.join(state, 'dead'), owner: 0x7ffffffe, keep: false }]);

  assert.equal(sweepStrandedBrowsers(), 0, 'a dead process was counted as swept');
  assert.equal(readRegistry().length, 0, 'a dead entry was kept');
});

test('browsers recorded at the same moment do not overwrite each other', async () => {
  // Sessions start browsers concurrently — a test run starts several at once.
  // A single shared list would mean read, modify, write, and the entry lost in
  // the overlap is a browser that could never be swept.
  const recorders = [];
  for (let i = 0; i < 12; i += 1) {
    const port = 9100 + i;
    recorders.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', `
        process.env.XDG_DATA_HOME = ${JSON.stringify(state)};
        require(${JSON.stringify(require.resolve('../src/registry'))})
          .recordBrowser({ pid: process.pid, port: ${port}, profileDir: 'p', engine: 'chromium' });
      `], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', resolve);
    }));
  }
  await Promise.all(recorders);

  const ports = readRegistry().map((e) => e.port).sort((a, b) => a - b);
  assert.equal(ports.length, 12, `entries were lost: kept ${ports.length} of 12`);
  writeRegistry([]);
});

test('recording, forgetting and a sweep of nothing', () => {
  assert.equal(sweepStrandedBrowsers(), 0, 'an empty registry swept something');
  recordBrowser({ pid: process.pid, port: 9007, profileDir: state, engine: 'firefox' });
  assert.equal(readRegistry().length, 1, 'the browser was not recorded');
  recordBrowser({ pid: process.pid, port: 9007, profileDir: state, engine: 'firefox' });
  assert.equal(readRegistry().length, 1, 'the same port was recorded twice');
  forgetBrowser(9007);
  assert.equal(readRegistry().length, 0, 'the browser was not forgotten');
});


// ---------------------------------------------------------------------------
// Throwaway directories
//
// A browser profile made for one test run is a few hundred megabytes in a
// tmpfs, which is to say in memory. A run killed outright leaves it there, so
// the next run sweeps it — and the whole safety of that rests on never
// deleting a directory whose owner might still be running.

const sweepRoot = fs.mkdtempSync(path.join(os.tmpdir(), tempName('tweb-sweeproot-')));
test.after(() => fs.rmSync(sweepRoot, { recursive: true, force: true }));

// A directory named the way tempDir names one, but owned by whoever we say.
function dirOwnedBy(pid, label = 'tweb-fake-') {
  const dir = path.join(sweepRoot, `${label}${pid}-abcDEF`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'something-big'), 'x'.repeat(1024));
  return dir;
}

const DEAD = 0x7ffffffe;

test('a directory carries its owner in its name, and hands back nothing else', () => {
  assert.equal(tempName('tweb-views-'), `tweb-views-${process.pid}-`);
  assert.equal(ownerOfTempDir(`tweb-views-${process.pid}-abcDEF`), process.pid);
  assert.equal(ownerOfTempDir('tweb-tabs-state-99-xyz123'), 99);
});

test('a directory that is not one of ours is never swept', () => {
  // No pid in the name: somebody else's, however much it looks like ours.
  for (const name of ['tweb-foo', 'tweb-views-abc-abcDEF', 'notours-123-abcDEF', 'tmp']) {
    assert.equal(ownerOfTempDir(name), null, `${name} was claimed as ours`);
  }
  const theirs = path.join(sweepRoot, 'tweb-someones-own-profile');
  fs.mkdirSync(theirs, { recursive: true });
  sweepStaleProfiles({ dir: sweepRoot });
  assert.ok(fs.existsSync(theirs), "a directory tweb did not create was deleted");
  fs.rmSync(theirs, { recursive: true, force: true });
});

test('a directory whose owner has gone is swept', () => {
  const stale = dirOwnedBy(DEAD);
  assert.equal(sweepStaleProfiles({ dir: sweepRoot }), 1, 'the stale directory was left behind');
  assert.equal(fs.existsSync(stale), false, 'the stale directory is still there');
});

test('a directory whose owner is still running is left alone', () => {
  const live = dirOwnedBy(process.pid);
  assert.equal(sweepStaleProfiles({ dir: sweepRoot }), 0, 'a running test lost its directory');
  assert.ok(fs.existsSync(live), 'a running test lost its directory');
  fs.rmSync(live, { recursive: true, force: true });
});

test('a browser still holding an abandoned profile is taken down with it', async () => {
  // The case that would otherwise never be cleared. A test file that points
  // XDG_DATA_HOME at a directory of its own records the browser it starts in a
  // registry inside that directory, so when the run is killed and the
  // directory goes, the browser cannot be found through the registry at all.
  // It is reachable only through the profile it is still holding.
  const abandoned = dirOwnedBy(DEAD, 'tweb-held-');
  const browser = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${abandoned}`],
    { stdio: 'ignore', detached: true });
  browser.unref();
  strays.push(browser.pid);
  // Give it a moment to exist with that command line.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(sweepStaleProfiles({ dir: sweepRoot }), 1, 'the abandoned profile was left behind');
  assert.equal(fs.existsSync(abandoned), false, 'the abandoned profile is still there');
  assert.ok(await goneWithin(browser.pid), 'the browser holding it was left running');
});

test('a profile whose owner is alive is left alone even while a browser holds it', async () => {
  // The same shape, but the run that made it is still going: this is every
  // browser test file while it is running, and nothing about it is reclaimable.
  const busy = dirOwnedBy(process.pid, 'tweb-busy-');
  const browser = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${busy}`],
    { stdio: 'ignore', detached: true });
  browser.unref();
  strays.push(browser.pid);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(sweepStaleProfiles({ dir: sweepRoot }), 0, 'a running test lost its profile');
  assert.ok(fs.existsSync(busy), 'a running test lost its profile');
  assert.ok(processAlive(browser.pid), 'a running test lost its browser');

  killProcessGroup(browser.pid, 'SIGKILL');
  await goneWithin(browser.pid);
  fs.rmSync(busy, { recursive: true, force: true });
});

test('what is on disk can be listed without deleting any of it', () => {
  const stale = dirOwnedBy(DEAD);
  const live = dirOwnedBy(process.pid);
  const listed = tempProfiles({ dir: sweepRoot });
  assert.equal(listed.length, 2, 'the listing missed a directory');
  assert.equal(listed.filter((e) => e.alive).length, 1, 'the listing got the owners wrong');
  assert.ok(fs.existsSync(stale) && fs.existsSync(live), 'listing deleted something');
  sweepStaleProfiles({ dir: sweepRoot });
  fs.rmSync(live, { recursive: true, force: true });
});
