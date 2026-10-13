'use strict';

// An accessibility bus, served over a real unix socket, so that an AT-SPI
// client can be tested without a desktop.
//
// The JavaScript AT-SPI tests hand `Accessibility` a hand-written object with
// a `call` method, which is enough to test the JavaScript walk. It is not
// enough to difference the walk against the Crystal port: the Crystal port
// runs in another process and can only be reached over a socket. So the tree
// is served here as a bus really serves it — authentication, Hello, ListNames,
// and the AT-SPI members on top — and both implementations are pointed at the
// same socket.

const net = require('node:net');
const dbus = require('../src/dbus');

const ROOT = '/org/a11y/atspi/accessible/root';

// The accessibility tree of a machine with two applications open, one of which
// is a browser showing Chrome's install confirmation. The same shape the
// JavaScript-only test uses, because the shape is what a real install prompt
// has: a dialog beside the window rather than inside it, a heading repeated by
// every panel that wraps it, a line of permissions, and two buttons.
function defaultTree() {
  return {
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
}

const UNKNOWN_METHOD = 'org.freedesktop.DBus.Error.UnknownMethod';
const FAILED = 'org.freedesktop.DBus.Error.Failed';

// Not an AT-SPI interface. A client in another process changes this bus's tree
// through it, which is what makes a watch testable at all: a watch is a thing
// that reacts to a tree changing.
const CONTROL_NAME = 'org.tawb.Control';
const CONTROL_PATH = '/org/tawb/control';
const CONTROL_INTERFACE = 'org.tawb.Control';

// Serves one tree. `pids` is what the bus says owns each connection, `gone` is
// the set of objects that have vanished entirely, and `childless` is the set
// that still answer for themselves but refuse their children — which is what a
// subtree dismissed mid-walk looks like from here.
function serveTree({
  socketPath,
  tree = defaultTree(),
  pids = { ':1.1': 4242, ':1.7': 99 },
  gone = new Set(),
  childless = new Set(),
  names = ['org.freedesktop.DBus', ':1.1', ':1.7', ':1.9'],
  ownName = ':1.9',
} = {}) {
  const pressed = [];
  const asked = [];
  // The tree as it stands, which a client can replace through the control
  // interface below. A watch is a thing that reacts to a tree changing, so a
  // test of one has to be able to change the tree — and a test running in
  // another process can only do that over the bus.
  const state = { tree, gone, childless, fail: false };

  const answer = (message) => {
    const reply = (signature, body) => dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN,
      destination: message.sender,
      replySerial: message.serial,
      signature,
      body,
    });
    const refuse = (errorName, text) => dbus.encodeMessage({
      type: dbus.MESSAGE_ERROR,
      destination: message.sender,
      replySerial: message.serial,
      errorName,
      signature: 's',
      body: [text],
    });

    asked.push(`${message.iface}.${message.member}`);
    if (message.member === 'Hello') return reply('s', [ownName]);
    if (message.member === 'ListNames') return reply('as', [names]);
    if (message.member === 'GetConnectionUnixProcessID') {
      const wanted = message.body[0];
      if (!(wanted in pids)) return refuse(FAILED, `no owner for ${wanted}`);
      return reply('u', [pids[wanted]]);
    }

    // The control interface, which is not AT-SPI and is not pretending to be.
    // It exists so that a client in another process can change the tree it is
    // watching, which is the only way to test a watch across a process
    // boundary.
    if (message.iface === CONTROL_INTERFACE) {
      if (message.member === 'SetTree') {
        const wanted = JSON.parse(message.body[0] || '{}');
        if (wanted.tree) state.tree = wanted.tree;
        if (wanted.gone) state.gone = new Set(wanted.gone);
        if (wanted.childless) state.childless = new Set(wanted.childless);
        if (wanted.fail !== undefined) state.fail = !!wanted.fail;
        return reply('s', ['ok']);
      }
      if (message.member === 'Pressed') return reply('as', [pressed]);
      return refuse(UNKNOWN_METHOD, `${message.member} is not a control member`);
    }

    // A browser that has quit, which is what a watch has to notice rather
    // than keep asking about for ever.
    if (state.fail) return refuse(FAILED, 'the browser has gone');

    const key = `${message.destination}|${message.path}`;
    if (state.gone.has(key)) return refuse(FAILED, 'object gone');
    const node = state.tree[key];
    if (!node) return refuse(FAILED, `no node at ${key}`);
    if (message.member === 'GetChildren') {
      if (state.childless.has(key)) return refuse(FAILED, 'children gone');
      return reply('a(so)', [node.children]);
    }
    if (message.member === 'GetRoleName') return reply('s', [node.role]);
    if (message.iface === 'org.freedesktop.DBus.Properties' && message.member === 'Get') {
      return reply('v', [{ signature: 's', value: node.name }]);
    }
    if (message.member === 'GetText') return reply('s', [node.value || '']);
    if (message.member === 'GetState') return reply('au', [node.state || [0, 0]]);
    if (message.member === 'DoAction') {
      pressed.push(key);
      // The browser owns a control's state, and pressing a check box is what
      // changes it. A reader that assumed the press did what the press looks
      // like it did would be wrong here as often as the browser refuses one.
      if (node.role === 'check box' || node.role === 'check menu item') {
        const words = node.state ? node.state.slice() : [0, 0];
        words[0] ^= (1 << 4); // STATE_CHECKED
        node.state = words;
      }
      return reply('b', [node.press !== false]);
    }
    return refuse(UNKNOWN_METHOD, `${message.iface}.${message.member} is not here`);
  };

  const server = net.createServer((socket) => {
    let greeted = false;
    let buffered = Buffer.alloc(0);
    socket.on('error', () => { /* a client hanging up is somebody else's test */ });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!greeted) {
        const text = buffered.toString('ascii');
        if (text.includes('AUTH EXTERNAL') && !text.includes('BEGIN')) {
          socket.write('OK 1234deadbeef\r\n');
          return;
        }
        if (!text.includes('BEGIN\r\n')) return;
        greeted = true;
        buffered = buffered.subarray(text.indexOf('BEGIN\r\n') + 7);
      }
      for (;;) {
        const length = dbus.messageLength(buffered);
        if (length == null) return;
        let message;
        try {
          message = dbus.decodeMessage(buffered.subarray(0, length));
        } catch {
          buffered = buffered.subarray(length);
          continue;
        }
        buffered = buffered.subarray(length);
        const written = answer(message);
        if (written) socket.write(written);
      }
    });
  });

  return new Promise((resolve) => server.listen(socketPath, () => resolve({
    server,
    pressed,
    asked,
    state,
    get tree() { return state.tree; },
    // What a test in this process changes the tree with; a test in another
    // process calls the control member over the bus instead.
    setTree(wanted) { Object.assign(state, wanted); },
    close() { server.close(); },
  })));
}

module.exports = {
  serveTree, defaultTree, ROOT, CONTROL_NAME, CONTROL_PATH, CONTROL_INTERFACE,
};
