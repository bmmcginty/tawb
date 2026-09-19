'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { browserKeyForTerminalSequence, handlePageKey } = require('../src/index');

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

test('webpage keyboard mode has a configurable toggle', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(keys.actionFor('\x1bk'), 'page-keyboard');
  keys.assign('page-keyboard', '\x1bz');
  assert.equal(keys.actionFor('\x1bk'), null);
  assert.equal(keys.actionFor('\x1bz'), 'page-keyboard');
});
