'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { browserKeyForTerminalSequence, handleBrowseKey, handlePageKey } = require('../src/index');

test('terminal keys are translated to browser key names', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(browserKeyForTerminalSequence(' ', keys), ' ');
  assert.equal(browserKeyForTerminalSequence('m', keys), 'm');
  assert.equal(browserKeyForTerminalSequence('\x1b[A', keys), 'ArrowUp');
  assert.equal(browserKeyForTerminalSequence('\x0c', keys), 'Control+L');
  assert.equal(browserKeyForTerminalSequence('\x1bq', keys), 'Alt+Q');
  assert.equal(browserKeyForTerminalSequence('\x1b[999~', keys), null);
});

test('webpage keyboard mode sends browse commands to the page', async () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  const sent = [];
  const state = {
    mode: 'page', keys, inputSeen: false,
    core: { markInput() {} },
  };
  const page = { keyboard: { press: async (key) => sent.push(key) } };

  await handlePageKey(' ', state, page);
  await handlePageKey('q', state, page);
  await handlePageKey('\x1b[A', state, page);

  assert.deepEqual(sent, [' ', 'q', 'ArrowUp']);
  assert.equal(state.mode, 'page');
  assert.equal(state.inputSeen, true);
});

test('webpage keyboard mode has a configurable toggle and a one-byte escape hatch', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(keys.actionFor('\x1bk'), 'page-keyboard');
  assert.equal(keys.actionFor('\x1c'), 'page-keyboard');
  keys.assign('page-keyboard', '\x1bz');
  assert.equal(keys.actionFor('\x1bk'), null);
  assert.equal(keys.actionFor('\x1c'), null);
  assert.equal(keys.actionFor('\x1bz'), 'page-keyboard');
});

test('leaving webpage keyboard mode is immediate and defers the rescan', async () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  const live = { enabled: true, dirty: false, lastPulseMs: 10 };
  const state = {
    mode: 'page', keys, inputSeen: false, lines: [{ text: 'page', blockIndex: 0 }],
    cursor: 0, scroll: 0, col: 0, drawn: {}, statusMsg: '',
    core: { markInput() {}, live },
  };
  const page = { keyboard: { press: async () => assert.fail('exit reached the page') } };
  const original = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await handlePageKey('\x1bk', state, page);
  } finally {
    process.stdout.write = original;
  }

  assert.equal(state.mode, 'browse');
  assert.equal(live.dirty, true);
  assert.equal(live.lastPulseMs, 0);
  assert.ok(state.pageKeyboardExitUntil > Date.now());
});

test('a repeated exit chord cannot immediately re-enter webpage mode', async () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  const state = {
    mode: 'browse', keys, pageKeyboardExitUntil: Date.now() + 1000,
    inputSeen: false, lines: [{ text: 'page', blockIndex: 0 }],
    cursor: 0, scroll: 0, col: 0, drawn: {}, statusMsg: '',
    core: { markInput() {} },
  };
  await handleBrowseKey('\x1bk', state, {});
  assert.equal(state.mode, 'browse');
});
