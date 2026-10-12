'use strict';

// Reading a browser's own windows, differenced between the JavaScript original
// and the Crystal port.
//
// Both implementations are pointed at one accessibility bus, served over a
// real unix socket by `atspi_bus.js`, and both are walked through the same
// steps. The tree is the shape a real install prompt has: a dialog beside the
// window rather than inside it, a heading that every panel wrapping it repeats,
// a line of permissions, two buttons, an option to tick, and the two entries a
// save-password prompt is actually about.
//
// What is compared is what a reader would be told, not how either
// implementation asked. The JavaScript walk asks for a role and a name
// together through `Promise.all` and the Crystal walk asks for them one after
// the other, so the number of round trips differs by design; the lines, the
// controls, the states and the presses must not.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const atspi = require('../src/atspi');
const { serveTree } = require('./atspi_bus');
const { atspiImplementations } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

const implementations = atspiImplementations(atspi);

// One scenario run against every implementation, compared to the first. Every
// comparison in this file goes through here, so a difference is reported as a
// difference between two named implementations rather than as a failed
// assertion about one.
async function compare(what, serve, steps) {
  const answers = [];
  for (const implementation of implementations) {
    const directory = tempDir('tawb-atspi-');
    const socket = path.join(directory, 'bus');
    const bus = await serve(socket);
    try {
      answers.push({
        name: implementation.name,
        outcome: await implementation.scenario(socket, steps),
        pressed: bus.pressed.slice(),
      });
    } finally {
      bus.close();
      removeTempDir(directory);
    }
  }
  const first = answers[0];
  for (const other of answers.slice(1)) {
    assert.deepEqual(
      other.outcome,
      first.outcome,
      `${other.name} read ${what} differently from ${first.name}`,
    );
    assert.deepEqual(
      other.pressed,
      first.pressed,
      `${other.name} pressed something different from ${first.name} while reading ${what}`,
    );
  }
  return first;
}

const plainBus = (socket) => serveTree({ socketPath: socket });

test('the browser is picked out by its process, not by its name', async () => {
  const { outcome } = await compare('a desktop with two applications on it', plainBus, [
    { type: 'connections' },
    { type: 'application_for', pid: 4242 },
    // A pid nobody on the bus belongs to falls through to the name, which is
    // all there is to go on for a browser reached with --connect.
    { type: 'application_for', pid: 5555, names: ['Chrome', 'Chromium'] },
    // And with neither a matching pid nor a matching name, nothing is claimed.
    { type: 'application_for', pid: 5555 },
    { type: 'application_for', names: ['Firefox'] },
  ]);
  assert.deepEqual(outcome.results[0], [':1.1', ':1.7']);
  assert.equal(outcome.results[1].name, 'Chromium');
  assert.equal(outcome.results[1].bus, ':1.1');
  assert.equal(outcome.results[2].bus, ':1.1');
  assert.equal(outcome.results[3], null);
  assert.equal(outcome.results[4], null);
});

test('a native dialog is a top-level of the application, beside its window', async () => {
  const { outcome } = await compare('an application with a window and a dialog', plainBus, [
    { type: 'application_for', pid: 4242 },
    { type: 'top_levels' },
  ]);
  assert.deepEqual(outcome.results[1].map((top) => top.role), ['frame', 'alert']);
  assert.equal(outcome.results[1][1].name, 'Add "uBlock Origin Lite"?');
});

test('a dialog reads as the lines it says and the controls it offers', async () => {
  const { outcome, pressed } = await compare('an install confirmation', plainBus, [
    { type: 'application_for', pid: 4242 },
    { type: 'top_levels' },
    { type: 'read', index: 1 },
    { type: 'press', name: 'Add extension' },
  ]);
  const reading = outcome.results[2];

  // The heading once, not once per panel that repeats it, and the permission
  // exactly as the browser worded it.
  assert.deepEqual(reading.lines, [
    'Add "uBlock Origin Lite"?',
    'It can:',
    'Read and change all your data on all websites',
  ]);
  assert.deepEqual(reading.buttons.map((button) => button.name), ['Cancel', 'Add extension']);
  // An option the dialog offers is a control to answer with, not prose — and
  // the option is not read out twice because the option's wrapper repeats the
  // option's name.
  assert.deepEqual(reading.toggles.map((toggle) => toggle.name), ['Allow it in private windows']);
  assert.equal(reading.lines.filter((line) => /private windows/.test(line)).length, 0);
  assert.equal(reading.truncated, false);

  // A control that holds a value is read for the value, not just for the label
  // — otherwise a save-password prompt says "Username" twice and never says
  // whose password it is about to keep. The password arrives already masked,
  // because the browser masks the password.
  assert.deepEqual(reading.fields.map((field) => `${field.name}: ${field.value}`), [
    'Username: reader',
    'Password: ••••••••',
  ]);

  // The dialog's own default button is read from the dialog's state, not
  // assumed: for an install prompt the default is Cancel.
  const cancel = reading.buttons.find((button) => button.name === 'Cancel');
  const add = reading.buttons.find((button) => button.name === 'Add extension');
  assert.equal(cancel.focused, true);
  assert.equal(cancel.isDefault, true);
  assert.equal(add.focused, false);
  assert.equal(add.isDefault, false);

  assert.equal(outcome.results[3], true);
  assert.deepEqual(pressed, [':1.1|/dialog/add']);
});

test('AT-SPI state words are decoded by the bit AT-SPI defines', async () => {
  const { outcome } = await compare('two buttons in different states', plainBus, [
    { type: 'states', bus: ':1.1', path: '/dialog/cancel' },
    { type: 'states', bus: ':1.1', path: '/dialog/add' },
  ]);
  assert.deepEqual(outcome.results[0], { checked: false, focused: true, isDefault: true });
  assert.deepEqual(outcome.results[1], { checked: false, focused: false, isDefault: false });
});

test('a window that closes while it is being read does not take the read with it', async () => {
  // The permissions panel vanishes mid-walk, which is what a dialog dismissed
  // by somebody else looks like from here.
  const { outcome } = await compare(
    'a dialog whose permissions panel vanished',
    (socket) => serveTree({ socketPath: socket, gone: new Set([':1.1|/dialog/perms']) }),
    [
      { type: 'application_for', pid: 4242 },
      { type: 'top_levels' },
      { type: 'read', index: 1 },
    ],
  );
  assert.deepEqual(outcome.results[2].lines, ['Add "uBlock Origin Lite"?']);
  assert.deepEqual(
    outcome.results[2].buttons.map((button) => button.name),
    ['Cancel', 'Add extension'],
  );
});

test('a subtree whose children cannot be read does not take its siblings with it', async () => {
  // A panel that has gone away since it was described refuses its children.
  // The walk must carry on past the panel rather than ending the read.
  const { outcome } = await compare(
    'a dialog with one unreadable subtree',
    (socket) => serveTree({ socketPath: socket, childless: new Set([':1.1|/dialog/perms']) }),
    [
      { type: 'application_for', pid: 4242 },
      { type: 'top_levels' },
      { type: 'read', index: 1 },
    ],
  );
  const reading = outcome.results[2];
  assert.ok(reading.lines.includes('Add "uBlock Origin Lite"?'), 'the heading was lost');
  assert.ok(
    !reading.lines.includes('Read and change all your data on all websites'),
    'a permission inside the unreadable subtree appeared anyway',
  );
  // Everything after the broken subtree in the same parent is still read.
  assert.deepEqual(reading.toggles.map((toggle) => toggle.name), ['Allow it in private windows']);
  assert.deepEqual(reading.buttons.map((button) => button.name), ['Cancel', 'Add extension']);
});

test('a top-level that vanishes while it is listed is skipped, not fatal', async () => {
  const { outcome } = await compare(
    'an application whose window closed mid-listing',
    (socket) => serveTree({ socketPath: socket, gone: new Set([':1.1|/window']) }),
    [
      { type: 'application_for', pid: 4242 },
      { type: 'top_levels' },
    ],
  );
  assert.deepEqual(outcome.results[1].map((top) => top.role), ['alert']);
});

test('a connection that will not answer for a pid is passed over, not fatal', async () => {
  // ':1.1' is missing from the pid map, so asking the bus about ':1.1' is
  // refused. ':1.7' answers, and ':1.7' is the one the pid belongs to. A
  // browser on a desktop shares the accessibility bus with whatever else is
  // running, so one uncooperative name must not stop the search.
  const { outcome } = await compare(
    'a bus with one uncooperative name on it',
    (socket) => serveTree({ socketPath: socket, pids: { ':1.7': 99 } }),
    [{ type: 'application_for', pid: 99 }],
  );
  assert.equal(outcome.results[0].name, 'Text Editor');
  assert.equal(outcome.results[0].bus, ':1.7');
});

test('a walk stops rather than following a tree without end', async () => {
  const { outcome } = await compare('a dialog read under a node limit', plainBus, [
    { type: 'application_for', pid: 4242 },
    { type: 'top_levels' },
    { type: 'read', index: 1, maxNodes: 3 },
  ]);
  assert.equal(outcome.results[2].truncated, true);
  assert.ok(outcome.results[2].lines.length <= 3);
});

test('a walk stops at the depth it was given', async () => {
  const { outcome } = await compare('a dialog read under a depth limit', plainBus, [
    { type: 'application_for', pid: 4242 },
    { type: 'top_levels' },
    { type: 'read', index: 1, maxDepth: 1 },
  ]);
  // Depth 1 reaches the dialog and the panel inside it, and the panel repeats
  // the dialog's own heading, so one line is all there is.
  assert.deepEqual(outcome.results[2].lines, ['Add "uBlock Origin Lite"?']);
  assert.deepEqual(outcome.results[2].buttons, []);
});

test('a press the browser refuses is reported rather than hidden', async () => {
  const { outcome } = await compare(
    'a button that refuses its own action',
    (socket) => {
      const tree = require('./atspi_bus').defaultTree();
      tree[':1.1|/dialog/cancel'] = { ...tree[':1.1|/dialog/cancel'], press: false };
      return serveTree({ socketPath: socket, tree });
    },
    [{ type: 'press_path', bus: ':1.1', path: '/dialog/cancel' }],
  );
  assert.equal(outcome.results[0], false);
});

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('a process group is read from the process the kernel reports', async (t) => {
    // With no display the browser runs under xvfb-run, so the pid this session
    // holds is the group leader and the pid on the bus is a child of the group
    // leader. The two are matched through the process group, and only a real
    // group tests it.
    const leader = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore', detached: true });
    leader.unref();
    try {
      let childPid = null;
      for (let attempt = 0; attempt < 50 && !childPid; attempt += 1) {
        try {
          const text = fs
            .readFileSync(`/proc/${leader.pid}/task/${leader.pid}/children`, 'utf8')
            .trim();
          if (text) childPid = Number(text.split(/\s+/)[0]);
        } catch { /* the child is not there yet */ }
        if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!childPid) {
        t.skip('could not observe a child process to place in the group');
        return;
      }
      assert.equal(await implementation.processGroupOf(childPid), leader.pid);
      assert.equal(await implementation.processGroupOf(leader.pid), leader.pid);
      // A pid with no process behind it is nothing, not a crash.
      assert.equal(await implementation.processGroupOf(0x7ffffff), null);
    } finally {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
}

test('the browser is found when the bus names a child of the process group', async (t) => {
  // The pid on the bus is a child of the group this session started, which is
  // what xvfb-run makes of a launch. Only a real process group tests it, so
  // the group is made here and both implementations are pointed at it.
  const leader = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore', detached: true });
  leader.unref();
  try {
    let childPid = null;
    for (let attempt = 0; attempt < 50 && !childPid; attempt += 1) {
      try {
        const text = fs
          .readFileSync(`/proc/${leader.pid}/task/${leader.pid}/children`, 'utf8')
          .trim();
        if (text) childPid = Number(text.split(/\s+/)[0]);
      } catch { /* the child is not there yet */ }
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!childPid) {
      t.skip('could not observe a child process to place in the group');
      return;
    }
    const { outcome } = await compare(
      'a browser whose bus connection is a child of the group',
      (socket) => serveTree({ socketPath: socket, pids: { ':1.1': childPid } }),
      [{ type: 'application_for', pid: leader.pid }],
    );
    assert.equal(outcome.results[0].name, 'Chromium');
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
