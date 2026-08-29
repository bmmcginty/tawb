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

const { Accessibility } = require('../src/atspi');

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
      [':1.1', '/dialog/option'], [':1.1', '/dialog/buttons'],
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
  ':1.1|/dialog/cancel': { role: 'push button', name: 'Cancel', children: [] },
  ':1.1|/dialog/add': { role: 'push button', name: 'Add extension', children: [] },
};

function fakeBus({ pids = { ':1.1': 4242, ':1.7': 99 }, gone = new Set() } = {}) {
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
      if (member === 'GetChildren') return [node.children];
      if (member === 'GetRoleName') return [node.role];
      if (iface === 'org.freedesktop.DBus.Properties' && member === 'Get') {
        assert.deepEqual(body, ['org.a11y.atspi.Accessible', 'Name']);
        return [node.name];
      }
      if (member === 'DoAction') {
        pressed.push(key);
        return [true];
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
