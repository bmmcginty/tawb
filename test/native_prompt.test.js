'use strict';

// Noticing that the browser has asked something, and answering it.
//
// The rules worth holding onto are about restraint: one question at a time,
// each question asked once, and a dialog that goes away on its own is
// forgotten rather than answered. A reader has one terminal, and a prompt
// that arrives while they are in the middle of another is not a prompt, it is
// an interruption they cannot untangle.

const test = require('node:test');
const assert = require('node:assert');

const { watchNativeDialogs, defaultButton } = require('../src/native_prompt');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An application whose windows a test can change from underneath the watch.
function fakeApplication(windows = []) {
  const pressed = [];
  const state = { windows, pressed };
  const a11y = {
    async childrenOf() {
      if (state.fail) throw new Error('the browser has gone');
      return state.windows.map((window) => ({ bus: ':1.1', path: window.path }));
    },
    async describeNode(node) {
      const window = state.windows.find((each) => each.path === node.path);
      if (!window) throw new Error('gone');
      return { ...node, role: window.role, name: window.name };
    },
    async read(node) {
      const window = state.windows.find((each) => each.path === node.path);
      return { lines: window.lines || [], buttons: window.buttons || [], truncated: false };
    },
    async press(button) {
      pressed.push(button.name);
      return true;
    },
  };
  return { a11y, state };
}

const INSTALL_PROMPT = {
  path: '/dialog/install',
  role: 'alert',
  name: 'Add "uBlock Origin Lite"?',
  lines: ['Add "uBlock Origin Lite"?', 'It can:', 'Read and change all your data on all websites'],
  // Chrome focuses Cancel and marks it the default on its own install prompt,
  // which is the whole reason the default is worth reading rather than
  // assuming.
  buttons: [{ name: 'Cancel', isDefault: true, focused: true }, { name: 'Add extension' }],
};

test('the browser asking something reaches the reader once, with its own words', async () => {
  const { a11y, state } = fakeApplication([{ path: '/window', role: 'frame', name: 'A page' }]);
  const asked = [];
  const watch = watchNativeDialogs({
    a11y,
    application: { bus: ':1.1', path: '/root' },
    interval: 10,
    onDialog: async (dialog) => { asked.push(dialog); },
  });
  try {
    state.windows.push(INSTALL_PROMPT);
    await sleep(120);
    assert.equal(asked.length, 1, 'asked once, not once per tick');
    assert.equal(asked[0].title, 'Add "uBlock Origin Lite"?');
    assert.deepEqual(asked[0].lines, INSTALL_PROMPT.lines);
    assert.deepEqual(asked[0].buttons.map((button) => button.name), ['Cancel', 'Add extension']);
    // A window is not a question: the frame that was already there raised
    // nothing.
    assert.equal(asked.length, 1);
  } finally {
    watch.stop();
  }
});

test('the button the dialog would press itself is the one Escape gets', () => {
  assert.equal(defaultButton(INSTALL_PROMPT.buttons).name, 'Cancel');
  assert.equal(defaultButton([{ name: 'OK', focused: true }]).name, 'OK');
  assert.equal(defaultButton([{ name: 'OK' }]), null);
});

test('nothing else is asked while a reader is answering', async () => {
  const { a11y, state } = fakeApplication([]);
  const asked = [];
  let answering = null;
  const watch = watchNativeDialogs({
    a11y,
    application: { bus: ':1.1', path: '/root' },
    interval: 10,
    onDialog: async (dialog) => {
      asked.push(dialog.title);
      // A second dialog arrives while the first is still on the terminal.
      state.windows.push({
        path: '/dialog/second', role: 'alert', name: 'Something else?', buttons: [{ name: 'OK' }],
      });
      answering = new Promise((resolve) => setTimeout(resolve, 80));
      await answering;
    },
  });
  try {
    state.windows.push(INSTALL_PROMPT);
    await sleep(60);
    assert.deepEqual(asked, ['Add "uBlock Origin Lite"?'], 'the second question waits its turn');
    await sleep(150);
    assert.deepEqual(asked, ['Add "uBlock Origin Lite"?', 'Something else?']);
  } finally {
    watch.stop();
  }
});

test('a dialog answered in the browser is forgotten rather than pressed', async () => {
  const { a11y, state } = fakeApplication([]);
  const asked = [];
  const watch = watchNativeDialogs({
    a11y,
    application: { bus: ':1.1', path: '/root' },
    interval: 10,
    onDialog: async (dialog) => {
      asked.push(await dialog.stillOpen());
    },
  });
  try {
    state.windows.push(INSTALL_PROMPT);
    await sleep(60);
    assert.deepEqual(asked, [true]);
    // It goes away on its own — dismissed in the browser, or the extension
    // installed by somebody else's hand.
    state.windows.length = 0;
    await sleep(60);
    // And if the same dialog comes back it is a new question, not a repeat.
    state.windows.push(INSTALL_PROMPT);
    await sleep(60);
    assert.equal(asked.length, 2);
  } finally {
    watch.stop();
  }
});

test('a browser that stops answering ends the watch instead of spinning', async () => {
  const { a11y, state } = fakeApplication([]);
  let notices = 0;
  const watch = watchNativeDialogs({
    a11y,
    application: { bus: ':1.1', path: '/root' },
    interval: 5,
    onDialog: async () => { notices += 1; },
    log: () => {},
  });
  try {
    state.fail = true;
    await sleep(120);
    // Whatever happens, nothing was pressed and nothing was announced.
    assert.equal(notices, 0);
    state.fail = false;
    state.windows.push(INSTALL_PROMPT);
    await sleep(60);
    // The watch gave up after five refusals rather than asking for ever.
    assert.equal(notices, 0);
  } finally {
    watch.stop();
  }
});
