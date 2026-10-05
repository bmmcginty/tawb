'use strict';

// Reading a browser's own windows, against a tree we control.
//
// The shape being tested is the one a real install prompt has: a dialog
// beside the window rather than inside it, a heading repeated by every panel
// that wraps it, a line of permissions, and two buttons. What matters is that
// a reader gets those few lines and not the forty empty containers they are
// nested in, and that the right application is picked when a desktop has more
// than one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { Accessibility, openAccessibility } = require('../src/atspi');
const { startSessionBus, serveAccessibilityBus, A11Y_NAME } = require('../src/a11y_bus');
const { connect } = require('../src/dbus');

// The accessibility tree of a machine with two applications open, one of
// which is a browser showing Chrome's install confirmation.
const ROOT = '/org/a11y/atspi/accessible/root';
const TREE = {
  [`:1.1|${ROOT}`]: {
    role: 'application', name: 'Chromium', children: [[':1.1', '/window'], [':1.1', '/dialog']],
  },
  [`:1.7|${ROOT}`]: { role: 'application', name: 'Text Editor', children: [] },
  ':1.1|/window': { role: 'frame', name: 'uBlock Origin Lite - Chrome Web Store - Chromium', children: [] },
  ':1.1|/dialog': { role: 'alert', name: 'Add "uBlock Origin Lite"?', children: [[':1.1', '/dialog/panel']] },
  // The panels a views dialog nests, each answering with the name of what is
  // inside it. Reading them all out would say the heading four times.
  ':1.1|/dialog/panel': {
    role: 'panel',
    name: 'Add "uBlock Origin Lite"?',
    children: [
      [':1.1', '/dialog/heading'], [':1.1', '/dialog/perms'],
      [':1.1', '/dialog/option'], [':1.1', '/dialog/who'], [':1.1', '/dialog/secret'],
      [':1.1', '/dialog/buttons'],
    ],
  },
  ':1.1|/dialog/heading': { role: 'heading', name: 'Add "uBlock Origin Lite"?', children: [] },
  ':1.1|/dialog/perms': {
    role: 'panel', name: '', children: [[':1.1', '/dialog/perms/lead'], [':1.1', '/dialog/perms/one']],
  },
  ':1.1|/dialog/perms/lead': { role: 'static', name: 'It can:', children: [] },
  ':1.1|/dialog/perms/one': {
    role: 'static', name: 'Read and change all your data on all websites', children: [],
  },
  // Firefox's option, wrapped in a list item that answers with the same name
  // as the check box inside it.
  ':1.1|/dialog/option': {
    role: 'list item', name: 'Allow it in private windows', children: [[':1.1', '/dialog/check']],
  },
  ':1.1|/dialog/check': { role: 'check box', name: 'Allow it in private windows', children: [] },
  ':1.1|/dialog/buttons': {
    role: 'panel', name: '', children: [[':1.1', '/dialog/cancel'], [':1.1', '/dialog/add']],
  },
  // What a "Save password?" prompt is actually about: two entries holding the
  // credential, the password already masked by the browser itself.
  ':1.1|/dialog/who': { role: 'entry', name: 'Username', value: 'reader', children: [] },
  ':1.1|/dialog/secret': {
    role: 'password text', name: 'Password', value: '••••••••', children: [],
  },
  // Cancel is the button a views dialog is focused on and marks as its
  // default, which is AT-SPI state word bits 12 and 39. Add extension has
  // neither.
  ':1.1|/dialog/cancel': {
    role: 'push button', name: 'Cancel', children: [], state: [1 << 12, 1 << 7],
  },
  ':1.1|/dialog/add': { role: 'push button', name: 'Add extension', children: [] },
};

function fakeBus({
  pids = { ':1.1': 4242, ':1.7': 99 }, gone = new Set(), childless = new Set(),
} = {}) {
  const pressed = [];
  const connection = {
    pressed,
    // Our own connection, which every listing has to leave out.
    name: ':1.9',
    async processIdOf(name) {
      if (!(name in pids)) throw new Error('no such name');
      return pids[name];
    },
    async call({ destination, path, iface, member, body = [] }) {
      if (member === 'ListNames') {
        return [['org.freedesktop.DBus', ':1.1', ':1.7', ':1.9']];
      }
      const key = `${destination}|${path}`;
      if (gone.has(key)) throw new Error('object gone');
      const node = TREE[key];
      if (!node) throw new Error(`no node at ${key}`);
      if (member === 'GetChildren') {
        // A subtree that has gone away since it was described: the node still
        // answers for itself, but its children do not.
        if (childless.has(key)) throw new Error('children gone');
        return [node.children];
      }
      if (member === 'GetRoleName') return [node.role];
      if (iface === 'org.freedesktop.DBus.Properties' && member === 'Get') {
        assert.deepEqual(body, ['org.a11y.atspi.Accessible', 'Name']);
        return [node.name];
      }
      if (member === 'GetText') return [node.value || ''];
      if (member === 'GetState') return [node.state || [0, 0]];
      if (member === 'DoAction') {
        pressed.push(key);
        return [node.press !== false];
      }
      throw new Error(`unexpected ${iface}.${member}`);
    },
    close() { connection.closed = true; },
  };
  return connection;
}

test('the browser we started is picked out by its process, not its name', async () => {
  const a11y = new Accessibility(fakeBus());
  const byPid = await a11y.applicationFor({ pid: 4242 });
  assert.equal(byPid.name, 'Chromium');
  assert.equal(byPid.bus, ':1.1');

  // A pid nobody on the bus belongs to falls through to the name, which is
  // all there is to go on for a browser reached with --connect.
  const byName = await a11y.applicationFor({ pid: 5555, names: ['Chrome', 'Chromium'] });
  assert.equal(byName.bus, ':1.1');

  // And with neither, nothing is claimed.
  assert.equal(await a11y.applicationFor({ pid: 5555 }), null);
  assert.equal(await a11y.applicationFor({ names: ['Firefox'] }), null);
});

test('a native dialog is a top-level of the application, beside its window', async () => {
  const a11y = new Accessibility(fakeBus());
  const application = await a11y.applicationFor({ pid: 4242 });
  const tops = await a11y.topLevels(application);
  assert.deepEqual(tops.map((top) => top.role), ['frame', 'alert']);
  assert.equal(tops[1].name, 'Add "uBlock Origin Lite"?');
});

test('a dialog reads as the lines it says and the buttons it offers', async () => {
  const a11y = new Accessibility(fakeBus());
  const application = await a11y.applicationFor({ pid: 4242 });
  const [, dialog] = await a11y.topLevels(application);
  const read = await a11y.read(dialog);

  // The heading once, not once per panel that repeats it, and the permission
  // exactly as the browser worded it.
  assert.deepEqual(read.lines, [
    'Add "uBlock Origin Lite"?',
    'It can:',
    'Read and change all your data on all websites',
  ]);
  assert.deepEqual(read.buttons.map((button) => button.name), ['Cancel', 'Add extension']);
  // An option the dialog offers is a control to answer with, not prose — and
  // it is not read out twice because its wrapper repeats its name.
  assert.deepEqual(read.toggles.map((toggle) => toggle.name), ['Allow it in private windows']);
  assert.equal(read.lines.filter((line) => /private windows/.test(line)).length, 0);
  assert.equal(read.truncated, false);

  // A control that holds a value is read for the value, not just the label —
  // otherwise a save-password prompt says "Username" twice and never says
  // whose password it is about to keep. The password arrives already masked,
  // because the browser masks it.
  assert.deepEqual(read.fields.map((field) => `${field.name}: ${field.value}`), [
    'Username: reader',
    'Password: ••••••••',
  ]);

  const add = read.buttons.find((button) => button.name === 'Add extension');
  assert.equal(await a11y.press(add), true);
  assert.deepEqual(a11y.connection.pressed, [':1.1|/dialog/add']);
});

test('a window that closes while it is being read does not take the read with it', async () => {
  // The permissions panel vanishes mid-walk, which is what a dialog dismissed
  // by someone else looks like from here.
  const a11y = new Accessibility(fakeBus({ gone: new Set([':1.1|/dialog/perms']) }));
  const application = await a11y.applicationFor({ pid: 4242 });
  const [, dialog] = await a11y.topLevels(application);
  const read = await a11y.read(dialog);
  assert.deepEqual(read.lines, ['Add "uBlock Origin Lite"?']);
  assert.deepEqual(read.buttons.map((button) => button.name), ['Cancel', 'Add extension']);
});

test('a walk stops rather than following a tree without end', async () => {
  const a11y = new Accessibility(fakeBus());
  const application = await a11y.applicationFor({ pid: 4242 });
  const [, dialog] = await a11y.topLevels(application);
  const read = await a11y.read(dialog, { maxNodes: 3 });
  assert.equal(read.truncated, true);
  assert.ok(read.lines.length <= 3);
});

test('a subtree whose children cannot be read does not take its siblings with it', async () => {
  // A panel that has gone away since it was described refuses its children.
  // The walk must carry on past it rather than ending the read.
  const a11y = new Accessibility(fakeBus({ childless: new Set([':1.1|/dialog/perms']) }));
  const application = await a11y.applicationFor({ pid: 4242 });
  const [, dialog] = await a11y.topLevels(application);
  const read = await a11y.read(dialog);
  assert.ok(read.lines.includes('Add "uBlock Origin Lite"?'), 'the heading was lost');
  assert.ok(!read.lines.includes('Read and change all your data on all websites'),
    'a permission inside the unreadable subtree appeared anyway');
  // Everything after the broken subtree in the same parent is still read.
  assert.deepEqual(read.toggles.map((toggle) => toggle.name), ['Allow it in private windows']);
  assert.deepEqual(read.buttons.map((button) => button.name), ['Cancel', 'Add extension']);
});

test('a top-level that vanishes while it is listed is skipped, not fatal', async () => {
  // The window closes between the application listing it and being asked
  // about it, which is what a dialog dismissed by somebody else looks like.
  const a11y = new Accessibility(fakeBus({ gone: new Set([':1.1|/window']) }));
  const application = await a11y.applicationFor({ pid: 4242 });
  const tops = await a11y.topLevels(application);
  assert.deepEqual(tops.map((top) => top.role), ['alert']);
});

test('a connection that will not answer for a pid is passed over, not fatal', async () => {
  // ':1.1' is missing from the pid map, so asking the bus about it throws.
  // ':1.7' answers, and it is the one the pid belongs to. A browser on a
  // desktop shares the accessibility bus with whatever else is running, so
  // one uncooperative name must not stop the search.
  const a11y = new Accessibility(fakeBus({ pids: { ':1.7': 99 } }));
  const found = await a11y.applicationFor({ pid: 99 });
  assert.equal(found.name, 'Text Editor');
  assert.equal(found.bus, ':1.7');
});

test('AT-SPI state words are decoded by the bit AT-SPI defines', async () => {
  const a11y = new Accessibility(fakeBus());
  assert.deepEqual(await a11y.statesOf({ bus: ':1.1', path: '/dialog/cancel' }), {
    checked: false, focused: true, isDefault: true,
  });
  assert.deepEqual(await a11y.statesOf({ bus: ':1.1', path: '/dialog/add' }), {
    checked: false, focused: false, isDefault: false,
  });
});

test('the dialog’s own default button is read from its state, not assumed', async () => {
  const a11y = new Accessibility(fakeBus());
  const application = await a11y.applicationFor({ pid: 4242 });
  const [, dialog] = await a11y.topLevels(application);
  const read = await a11y.read(dialog);
  const cancel = read.buttons.find((button) => button.name === 'Cancel');
  const add = read.buttons.find((button) => button.name === 'Add extension');
  assert.equal(cancel.isDefault, true);
  assert.equal(add.focused, false);
  assert.equal(add.isDefault, false);
});

test('a press that the browser refuses is reported rather than hidden', async () => {
  const a11y = new Accessibility(fakeBus());
  const refused = { bus: ':1.1', path: '/dialog/cancel', name: 'Cancel' };
  // The tree says this button refuses the action; nothing here should turn
  // that into success.
  const original = TREE[':1.1|/dialog/cancel'];
  TREE[':1.1|/dialog/cancel'] = { ...original, press: false };
  try {
    assert.equal(await a11y.press(refused), false);
  } finally {
    TREE[':1.1|/dialog/cancel'] = original;
  }
});

test('the browser is found when the bus names a child of the process group we started', async (t) => {
  // With no display the browser runs under xvfb-run, so the pid this session
  // holds is the group leader and the pid on the bus is a child of it. The
  // two are matched through the process group, and only a real group tests it.
  const leader = spawn('sh', ['-c', 'sleep 60 & wait'], { stdio: 'ignore', detached: true });
  leader.unref();
  try {
    let childPid = null;
    for (let attempt = 0; attempt < 50 && !childPid; attempt += 1) {
      try {
        const text = fs.readFileSync(`/proc/${leader.pid}/task/${leader.pid}/children`, 'utf8').trim();
        if (text) childPid = Number(text.split(/\s+/)[0]);
      } catch { /* the child is not there yet */ }
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!childPid) {
      t.skip('could not observe a child process to place in the group');
      return;
    }
    const a11y = new Accessibility(fakeBus({ pids: { ':1.1': childPid } }));
    const found = await a11y.applicationFor({ pid: leader.pid });
    assert.equal(found.name, 'Chromium');
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('the accessibility bus is reached through the session bus, or taken directly', async (t) => {
  let bus;
  try {
    bus = await startSessionBus();
  } catch (err) {
    t.skip(`no session bus available here: ${err.message}`);
    return;
  }
  let server;
  try {
    server = await connect(bus.address);
    if (await server.requestName(A11Y_NAME) !== 1) {
      t.skip('somebody else owns the accessibility bus name here');
      return;
    }
    serveAccessibilityBus(server, bus.address);

    // The ordinary route: ask org.a11y.Bus where the accessibility bus is.
    const throughSession = await openAccessibility({ sessionAddress: bus.address });
    assert.match(throughSession.connection.name, /^:/);
    throughSession.close();

    // The route a reader on a private bus takes, where the address is known.
    const direct = await openAccessibility({ address: bus.address });
    assert.match(direct.connection.name, /^:/);
    direct.close();

    // With no bus to ask and none named, it refuses rather than guessing.
    await assert.rejects(openAccessibility({ sessionAddress: null }), /no session bus/);
  } finally {
    if (server) server.close();
    bus.child.kill('SIGTERM');
  }
});
