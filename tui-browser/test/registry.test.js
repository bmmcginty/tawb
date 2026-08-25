'use strict';

// Sweeping up browsers left behind by sessions that are no longer running.
//
// The sweep signals a whole process group by a pid remembered in a file, which
// is a large thing to be wrong about. Most of what is tested here is therefore
// what it refuses to touch: a live session's browser, a browser another reader
// is in, one left running on purpose, and a pid that has since been reused.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-registry-state-'));
process.env.XDG_DATA_HOME = state;

const {
  readRegistry, writeRegistry, recordBrowser, forgetBrowser, markKept,
  sweepStrandedBrowsers, stillOurBrowser,
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
