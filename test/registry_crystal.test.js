'use strict';

// Sweeping up the browser a session that is no longer running left behind,
// differenced between the JavaScript original and the Crystal port.
//
// The sweep signals a whole process group by a pid out of a file, which is a
// large thing to be wrong about. So most of what is compared here is what the
// sweep refuses to touch: a live session's browser, a browser another reader
// is in, one left running on purpose, and a pid that has since been reused by
// something else.
//
// Each implementation gets its own state directory and its own stand-in
// browser, because a sweep takes one down and there is nothing left to
// compare afterwards. What is compared is therefore the answers — how many
// were swept, what the registry holds, and whether the stand-in survived —
// rather than the pids, which are each run's own.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { tempDir, removeTempDir } = require('./tmpdir');
const { registryImplementations } = require('./crystal_impl');
const { killProcessGroup } = require('../src/proc');

const implementations = registryImplementations(require('../src/registry'));

// A pid nothing is running under, which is what a session killed outright
// leaves as the owner of its browser.
const DEAD_OWNER = 0x7ffffffe;

const strays = [];

test.after(() => {
  for (const pid of strays) killProcessGroup(pid, 'SIGKILL');
});

// A stand-in for a browser: a process group whose command line names the
// profile directory it was started with, which is what the sweep checks.
function fakeBrowser(profileDir) {
  // A loop rather than a single command, because a shell given one command
  // may exec into it and lose the argv this is all about. The extra arguments
  // land in the process's own argv, the way --user-data-dir does on a real
  // Chromium.
  const child = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${profileDir}`], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  strays.push(child.pid);
  return child.pid;
}

// One situation, set up and walked once per implementation. `steps` is built
// from the pids this run made, so each implementation signals only its own.
async function compare(what, build) {
  const answers = [];
  for (const implementation of implementations) {
    const state = tempDir('tawb-registry-crystal-');
    try {
      const spec = build({ state });
      // eslint-disable-next-line no-await-in-loop
      const outcome = await implementation.scenario({ state, steps: spec.steps });
      answers.push({ name: implementation.name, answers: outcome.answers });
    } finally {
      removeTempDir(state);
    }
  }
  const first = answers[0];
  for (const other of answers.slice(1)) {
    assert.deepEqual(other.answers, first.answers, `${other.name} swept ${what} differently`);
  }
  return first.answers;
}

test('a browser whose session has gone is taken down', async () => {
  const answers = await compare('a stranded browser', ({ state }) => {
    const profileDir = path.join(state, 'gone');
    const pid = fakeBrowser(profileDir);
    return {
      steps: [
        // Recorded against an owner that is not running: what a session
        // killed outright leaves behind.
        {
          type: 'write',
          entries: [{
            pid, port: 9001, profileDir, engine: 'chromium', owner: DEAD_OWNER, keep: false,
          }],
        },
        { type: 'sweep' },
        { type: 'gone_within', pid, ms: 5000 },
        { type: 'read' },
      ],
    };
  });
  assert.equal(answers[1], 1, 'the stranded browser was left alone');
  assert.equal(answers[2], true, 'the browser outlived the sweep');
  assert.deepEqual(answers[3], [], 'the swept entry was kept');
});

test('a browser whose session is still running is left alone', async () => {
  const answers = await compare('a live session\'s browser', ({ state }) => {
    const profileDir = path.join(state, 'live');
    const pid = fakeBrowser(profileDir);
    return {
      steps: [
        // Recorded by the process doing the sweeping, which is what a live
        // session looks like.
        { type: 'record', pid, port: 9002, profileDir, engine: 'chromium' },
        { type: 'sweep' },
        { type: 'alive', pid },
        { type: 'read' },
      ],
    };
  });
  assert.equal(answers[1], 0, 'a live session lost its browser');
  assert.equal(answers[2], true, 'a live session lost its browser');
  assert.deepEqual(answers[3], [{
    port: 9002, engine: 'chromium', keep: false, hasA11y: false, ownedHere: true,
  }]);
});

test('a browser another reader is still in is left alone', async () => {
  const answers = await compare('a browser with a reader in it', ({ state }) => {
    const profileDir = path.join(state, 'shared');
    const pid = fakeBrowser(profileDir);
    // A tab claim from a reader that is running. It has to be some other
    // process: a claim of the sweeper's own is not what "another reader"
    // means.
    const reader = spawn('sh', ['-c', 'while :; do sleep 1; done'], {
      stdio: 'ignore', detached: true,
    });
    reader.unref();
    strays.push(reader.pid);
    return {
      steps: [
        {
          type: 'write',
          entries: [{
            pid, port: 9003, profileDir, engine: 'chromium', owner: DEAD_OWNER, keep: false,
          }],
        },
        { type: 'claim', port: 9003, pid: reader.pid },
        { type: 'sweep' },
        { type: 'alive', pid },
        { type: 'release_claims', port: 9003 },
      ],
    };
  });
  assert.equal(answers[2], 0, 'a browser with a reader in it was killed');
  assert.equal(answers[3], true, 'a browser with a reader in it was killed');
});

test('a browser left running on purpose is left alone', async () => {
  const answers = await compare('a kept browser', ({ state }) => {
    const profileDir = path.join(state, 'kept');
    const pid = fakeBrowser(profileDir);
    return {
      steps: [
        { type: 'record', pid, port: 9004, profileDir, engine: 'firefox' },
        { type: 'mark_kept', port: 9004 },
        // The session that kept it has since gone, which is exactly the
        // situation --keep-browser is for.
        { type: 'disown', port: 9004, owner: DEAD_OWNER },
        { type: 'sweep' },
        { type: 'alive', pid },
        { type: 'read' },
      ],
    };
  });
  assert.equal(answers[3], 0, '--keep-browser lost its browser');
  assert.equal(answers[4], true, '--keep-browser lost its browser');
  assert.equal(answers[5][0].keep, true, 'the keep mark was lost');
});

test('a pid that now belongs to something else is not signalled', async () => {
  const answers = await compare('a reused pid', ({ state }) => {
    const profileDir = path.join(state, 'reused');
    // Alive, but its command line does not name the profile: the number was
    // reused by a process that has nothing to do with this program.
    const pid = fakeBrowser(path.join(state, 'somebody-else'));
    return {
      steps: [
        {
          type: 'write',
          entries: [{
            pid, port: 9005, profileDir, engine: 'chromium', owner: DEAD_OWNER, keep: false,
          }],
        },
        { type: 'ours', pid, profileDir },
        { type: 'sweep' },
        { type: 'alive', pid },
        { type: 'read' },
      ],
    };
  });
  assert.equal(answers[1], false, 'an unrelated process was claimed as ours');
  assert.equal(answers[2], 0, 'an unrelated process group was signalled');
  assert.equal(answers[3], true, 'an unrelated process was killed');
  assert.deepEqual(answers[4], [], 'a stale entry was kept');
});

test('an entry whose process has gone is forgotten without being signalled', async () => {
  const answers = await compare('an entry with nothing behind it', ({ state }) => ({
    steps: [
      {
        type: 'write',
        entries: [{
          pid: DEAD_OWNER,
          port: 9006,
          profileDir: path.join(state, 'vanished'),
          engine: 'chromium',
          owner: DEAD_OWNER,
          keep: false,
        }],
      },
      { type: 'sweep' },
      { type: 'read' },
    ],
  }));
  // Nothing was swept, because there was nothing to signal — but the entry is
  // gone, because the browser it named is.
  assert.equal(answers[1], 0);
  assert.deepEqual(answers[2], []);
});

test('forgetting a browser takes its private bus with it', async () => {
  // A private accessibility bus belongs to the browser that was started on
  // it, and the pair were recorded together. The daemon is only signalled
  // when its command line still says it is that daemon, because a pid is
  // reused freely and stopping an unrelated desktop bus would be far worse
  // than leaking one of this program's.
  const answers = await compare('a browser with a companion bus', ({ state }) => {
    const profileDir = path.join(state, 'with-bus');
    const pid = fakeBrowser(profileDir);
    const socket = path.join(state, 'bus.sock');
    const fs = require('node:fs');
    fs.writeFileSync(socket, '');
    fs.writeFileSync(`${socket}.conf`, '<busconfig/>');
    // A stand-in for the daemon, whose argv says what the real one's says.
    const daemon = spawn('sh', [
      '-c', 'while :; do sleep 1; done', 'dbus-daemon', '--nofork',
      `--address=unix:path=${socket}`,
    ], { stdio: 'ignore', detached: true });
    daemon.unref();
    strays.push(daemon.pid);
    return {
      steps: [
        {
          type: 'record',
          pid,
          port: 9007,
          profileDir,
          engine: 'chromium',
          a11yPid: daemon.pid,
          a11yAddress: `unix:path=${socket}`,
        },
        { type: 'read' },
        { type: 'forget', port: 9007 },
        { type: 'gone_within', pid: daemon.pid, ms: 5000 },
        { type: 'companion_files', socket },
        { type: 'read' },
      ],
    };
  });
  assert.equal(answers[1][0].hasA11y, true, 'the companion was not recorded');
  assert.equal(answers[3], true, 'the companion daemon outlived the browser');
  assert.deepEqual(answers[4], { socket: false, config: false },
    'the bus left its socket or its configuration behind');
  assert.deepEqual(answers[5], []);
});

test('a companion whose command line says otherwise is not signalled', async () => {
  const answers = await compare('a reused companion pid', ({ state }) => {
    const socket = path.join(state, 'other.sock');
    // Alive, but not a dbus-daemon on that socket: the number was reused.
    const other = spawn('sh', ['-c', 'while :; do sleep 1; done'], {
      stdio: 'ignore', detached: true,
    });
    other.unref();
    strays.push(other.pid);
    return {
      steps: [
        {
          type: 'record',
          pid: DEAD_OWNER,
          port: 9008,
          profileDir: path.join(state, 'gone'),
          engine: 'chromium',
          a11yPid: other.pid,
          a11yAddress: `unix:path=${socket}`,
        },
        { type: 'forget', port: 9008 },
        { type: 'alive', pid: other.pid },
      ],
    };
  });
  assert.equal(answers[2], true, 'an unrelated process was stopped as a companion bus');
});
