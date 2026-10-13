'use strict';

// Noticing that the browser has asked something, and answering it,
// differenced between the JavaScript original and the Crystal port.
//
// The rules worth holding onto are about restraint: one question at a time,
// each question asked once, and a dialog that goes away on its own is
// forgotten rather than answered. A reader has one terminal, and a prompt that
// arrives while they are in the middle of another is not a prompt, it is an
// interruption they cannot untangle.
//
// Both implementations watch one accessibility bus served over a real socket,
// and the tree is changed through that bus's own control interface rather than
// on a clock: a step adds the dialog, the next step waits for the watch to
// have offered it, and the step after that answers it. So nothing here races —
// except the one assertion that is about nothing happening, where the watch is
// held inside the handler and therefore cannot look again at all.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const nativePrompt = require('../src/native_prompt');
const atspi = require('../src/atspi');
const { serveTree, ROOT } = require('./atspi_bus');
const { nativePromptImplementations } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

const implementations = nativePromptImplementations({ nativePrompt, atspi });

const BUS = ':1.1';
const APPLICATION = `${BUS}|${ROOT}`;

// AT-SPI state words, by the bit AT-SPI defines. Bit 12 is focused and bit 39
// is the dialog's own default, which lands in the second word.
const FOCUSED = [1 << 12, 0];
const FOCUSED_DEFAULT = [1 << 12, 1 << 7];

// A tree with one application, one window, and whatever dialogs are asked for.
// Written as nodes a real bus can serve, because the reading being compared is
// a real reading: a dialog's own name becomes the first line it says, and a
// child repeating that name is dropped.
function treeWith({ beside = [], inside = [] } = {}) {
  const tree = {
    [APPLICATION]: {
      role: 'application',
      name: 'Chromium',
      children: [[BUS, '/window'], ...beside.map((dialog) => [BUS, dialog.path])],
    },
    [`${BUS}|/window`]: {
      role: 'frame',
      name: 'A page',
      children: inside.map((dialog) => [BUS, dialog.path]),
    },
  };
  for (const dialog of [...beside, ...inside]) addDialog(tree, dialog);
  return tree;
}

function addDialog(tree, {
  path: dialogPath, role = 'alert', name = '', lines = [], buttons = [], toggles = [], fields = [],
}) {
  const children = [];
  const add = (suffix, node) => {
    const childPath = `${dialogPath}/${suffix}`;
    tree[`${BUS}|${childPath}`] = { children: [], ...node };
    children.push([BUS, childPath]);
  };
  lines.forEach((line, index) => add(`line${index}`, { role: 'static', name: line }));
  fields.forEach((field, index) => add(`field${index}`, {
    role: field.role || 'entry', name: field.name, value: field.value,
  }));
  toggles.forEach((toggle, index) => add(`toggle${index}`, {
    role: 'check box', name: toggle.name, state: toggle.state,
  }));
  buttons.forEach((button, index) => add(`button${index}`, {
    role: 'push button', name: button.name, state: button.state,
  }));
  tree[`${BUS}|${dialogPath}`] = { role, name, children };
  return tree;
}

// Chrome's install confirmation. Chrome focuses Cancel and marks Cancel the
// default on its own install prompt, which is the whole reason the default is
// worth reading rather than assuming.
const INSTALL = {
  path: '/dialog/install',
  role: 'alert',
  name: 'Add "uBlock Origin Lite"?',
  lines: ['It can:', 'Read and change all your data on all websites'],
  buttons: [{ name: 'Cancel', state: FOCUSED_DEFAULT }, { name: 'Add extension' }],
};

const INSTALL_READING = {
  role: 'alert',
  title: 'Add "uBlock Origin Lite"?',
  lines: [
    'Add "uBlock Origin Lite"?',
    'It can:',
    'Read and change all your data on all websites',
  ],
  buttons: ['Cancel', 'Add extension'],
  toggles: [],
  fields: [],
  defaultButton: 'Cancel',
};

// One scenario run against every implementation, compared to the first.
async function compare(what, steps, { tree = treeWith(), pids = { [BUS]: 4242 } } = {}) {
  const answers = [];
  for (const implementation of implementations) {
    const directory = tempDir('tawb-native-');
    const socket = path.join(directory, 'bus');
    const bus = await serveTree({
      socketPath: socket,
      tree: JSON.parse(JSON.stringify(tree)),
      pids,
      names: ['org.freedesktop.DBus', BUS, ':1.9'],
    });
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
      `${other.name} watched ${what} differently from ${first.name}`,
    );
    assert.deepEqual(
      other.pressed,
      first.pressed,
      `${other.name} pressed something different from ${first.name} while watching ${what}`,
    );
  }
  return first;
}

const setTree = (payload) => ({ type: 'set_tree', payload: JSON.stringify(payload) });

test('the browser asking something reaches the reader once, with its own words', async () => {
  const { outcome } = await compare('an install confirmation appearing', [
    { type: 'arm', pid: 4242 },
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
    // Asked once, not once per look. The window that was already there raised
    // nothing: a window is not a question.
    { type: 'settle', ms: 80 },
  ]);
  assert.equal(outcome.results[0], 'Chromium');
  assert.equal(outcome.results[2], 1);
  assert.deepEqual(outcome.results[3], INSTALL_READING);
  assert.equal(outcome.results[4], 1, 'the same question was asked more than once');
});

test('a doorhanger inside the window is found as well as a dialog beside it', async () => {
  // Firefox hangs its install prompt off the browser window; Chromium hangs
  // its confirmation off the application. Both have to be noticed, and neither
  // is worth a search of a whole browser's chrome to find.
  const { outcome } = await compare('a doorhanger inside the window', [
    { type: 'arm', pid: 4242 },
    setTree({
      tree: treeWith({
        inside: [{
          path: '/window/doorhanger',
          role: 'alert',
          name: '',
          lines: ['Add uBlock Origin', 'Required permissions:', 'Access your data for all websites'],
          buttons: [{ name: 'Cancel' }, { name: 'Add' }],
        }],
      }),
    }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
  ]);
  // Unnamed in the tree, so the first thing the doorhanger says is what the
  // doorhanger is called.
  assert.equal(outcome.results[3].title, 'Add uBlock Origin');
  assert.deepEqual(outcome.results[3].buttons, ['Cancel', 'Add']);
  // Nothing in the tree has a default, so there is none to report rather than
  // a guess to make.
  assert.equal(outcome.results[3].defaultButton, null);
});

test('a question can be read again, in case it has changed', async () => {
  const save = {
    path: '/dialog/save',
    role: 'alert',
    name: 'Save password?',
    buttons: [{ name: 'Never' }, { name: 'Save', state: FOCUSED_DEFAULT }],
    fields: [{ name: 'Username', value: 'reader' }],
  };
  const changed = { ...save, fields: [{ name: 'Username', value: 'someone else' }] };
  const { outcome } = await compare('a save-password prompt that changed', [
    { type: 'arm', pid: 4242 },
    setTree({ tree: treeWith({ beside: [save] }) }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
    // The reader stepped away; meanwhile the browser changed what it says.
    setTree({ tree: treeWith({ beside: [changed] }) }),
    { type: 'reread', index: 0 },
    // And the reread is still a question that can be answered.
    { type: 'press', index: 0, name: 'Never' },
  ]);
  assert.deepEqual(outcome.results[3].fields, ['Username: reader']);
  assert.equal(outcome.results[3].defaultButton, 'Save');
  assert.deepEqual(outcome.results[5].fields, ['Username: someone else']);
  assert.equal(outcome.results[6], true);
});

test('nothing else is asked while a reader is answering', async () => {
  const second = {
    path: '/dialog/second',
    role: 'alert',
    name: 'Something else?',
    buttons: [{ name: 'OK' }],
  };
  const { outcome } = await compare('a second question arriving mid-answer', [
    { type: 'arm', pid: 4242, hold: true },
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 1 },
    // A second dialog arrives while the first is still on the terminal. The
    // watch is inside the handler and cannot look again, so the wait here is
    // not a race: nothing can happen during it.
    setTree({ tree: treeWith({ beside: [INSTALL, second] }) }),
    { type: 'settle', ms: 100 },
    { type: 'release' },
    { type: 'await', count: 2 },
    { type: 'dialog', index: 1 },
    { type: 'release' },
  ]);
  assert.equal(outcome.results[2], 1);
  assert.equal(outcome.results[4], 1, 'the second question did not wait its turn');
  assert.equal(outcome.results[6], 2);
  assert.equal(outcome.results[7].title, 'Something else?');
});

test('a dialog answered in the browser is forgotten rather than pressed', async () => {
  const { outcome, pressed } = await compare('a dialog dismissed in the browser', [
    { type: 'arm', pid: 4242 },
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 1 },
    { type: 'still_open', index: 0 },
    // The dialog goes away on its own — dismissed in the browser, or the
    // extension installed by somebody else's hand.
    setTree({ tree: treeWith() }),
    { type: 'settle', ms: 60 },
    { type: 'still_open', index: 0 },
    // And if the same dialog comes back it is a new question, not a repeat.
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 2 },
  ]);
  assert.equal(outcome.results[3], true);
  assert.equal(outcome.results[6], false, 'a dialog that has gone still answered "still open"');
  assert.equal(outcome.results[8], 2);
  assert.deepEqual(pressed, [], 'something was pressed that the reader did not choose');
});

test('an option is ticked and the browser’s own new state is read back', async () => {
  const withOption = {
    path: '/dialog/install',
    role: 'alert',
    name: 'Add “uBlock Origin Lite”?',
    buttons: [{ name: 'Cancel' }],
    toggles: [{ name: 'Allow it in private windows' }],
  };
  const { outcome, pressed } = await compare('an option the dialog offers', [
    { type: 'arm', pid: 4242 },
    setTree({ tree: treeWith({ beside: [withOption] }) }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
    { type: 'toggle', index: 0, name: 'Allow it in private windows' },
    // Ticking again is the browser's answer again, not a cached one.
    { type: 'toggle', index: 0, name: 'Allow it in private windows' },
  ]);
  assert.deepEqual(outcome.results[3].toggles, ['Allow it in private windows']);
  assert.equal(outcome.results[4], true, 'the read-back state is the browser’s, not assumed');
  assert.equal(outcome.results[5], false);
  assert.deepEqual(pressed, [
    `${BUS}|/dialog/install/toggle0`,
    `${BUS}|/dialog/install/toggle0`,
  ]);
});

test('a dialog whose browser has gone stops answering “still open”', async () => {
  const { outcome } = await compare('a browser that quit under the dialog', [
    { type: 'arm', pid: 4242 },
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 1 },
    { type: 'still_open', index: 0 },
    setTree({ fail: true }),
    { type: 'still_open', index: 0 },
  ]);
  assert.equal(outcome.results[3], true);
  assert.equal(outcome.results[5], false, 'a bus that has gone is not “still open”');
});

test('a file chooser is a question like any other', async () => {
  // The dialog roles are not just alert and dialog; a chooser the browser drew
  // for itself arrives the same way and is answered the same way.
  const { outcome } = await compare('a file chooser the browser drew', [
    { type: 'arm', pid: 4242 },
    setTree({
      tree: treeWith({
        beside: [{
          path: '/dialog/files',
          role: 'file chooser',
          name: 'Open File',
          buttons: [{ name: 'Cancel' }, { name: 'Open', state: FOCUSED }],
        }],
      }),
    }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
  ]);
  assert.equal(outcome.results[3].role, 'file chooser');
  assert.equal(outcome.results[3].title, 'Open File');
  // With nothing marked as the dialog's default, the focused button is what
  // the dialog has ready.
  assert.equal(outcome.results[3].defaultButton, 'Open');
});

test('a panel with nothing to say and nothing to press is not a question', async () => {
  const { outcome } = await compare('an empty dialog', [
    { type: 'arm', pid: 4242 },
    setTree({
      tree: treeWith({ beside: [{ path: '/dialog/empty', role: 'dialog', name: '' }] }),
    }),
    { type: 'settle', ms: 100 },
  ]);
  assert.equal(outcome.results[2], 0, 'an empty dialog was put in front of the reader');
});

test('a reader handler that throws does not stop the watch', async () => {
  const second = {
    path: '/dialog/second',
    role: 'alert',
    name: 'Something else?',
    buttons: [{ name: 'OK' }],
  };
  const { outcome } = await compare('a handler that threw on the first question', [
    { type: 'arm', pid: 4242, throwFirst: true },
    setTree({ tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'settle', ms: 80 },
    setTree({ tree: treeWith({ beside: [INSTALL, second] }) }),
    { type: 'await', count: 1 },
    { type: 'dialog', index: 0 },
  ]);
  // The first question was lost with the handler that threw; the watch carried
  // on and offered the next one.
  assert.equal(outcome.results[2], 0);
  assert.equal(outcome.results[4], 1, 'the watch ended with the handler');
  assert.equal(outcome.results[5].title, 'Something else?');
});

test('a browser that stops answering ends the watch instead of spinning', async () => {
  const { outcome, pressed } = await compare('a browser that quit', [
    { type: 'arm', pid: 4242, intervalMs: 5 },
    setTree({ fail: true }),
    // Long enough for five refusals in a row at a five-millisecond interval,
    // which is where the watch gives up rather than asking for ever.
    { type: 'settle', ms: 200 },
    // The browser comes back with a question on the screen. The watch gave up
    // and must not notice it.
    setTree({ fail: false, tree: treeWith({ beside: [INSTALL] }) }),
    { type: 'await', count: 1, timeoutMs: 200 },
  ]);
  assert.equal(outcome.results[2], 0);
  assert.equal(outcome.results[4], 0, 'the watch was still asking after it gave up');
  assert.deepEqual(pressed, []);
});

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('the button the dialog itself has ready is reported, not pressed', () => {
    // Reported only. Chrome's extension prompt focuses Cancel, which looks
    // like a safe thing to press when a reader walks away — until the
    // save-password prompt turns up, which focuses Save. Nothing is pressed
    // that the reader did not choose; the default is read because a dialog's
    // own idea of its default is worth knowing, not because it is an answer.
    assert.equal(implementation.defaultButton([
      { name: 'Cancel', isDefault: true, focused: true },
      { name: 'Add extension' },
    ]), 'Cancel');
    assert.equal(implementation.defaultButton([{ name: 'OK', focused: true }]), 'OK');
    assert.equal(implementation.defaultButton([{ name: 'OK' }]), null);
    // The dialog's own default outranks whatever happens to be focused.
    assert.equal(implementation.defaultButton([
      { name: 'Save', focused: true },
      { name: 'Never', isDefault: true },
    ]), 'Never');
    assert.equal(implementation.defaultButton([]), null);
  });
}
