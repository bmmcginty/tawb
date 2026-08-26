'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { focusAddressBar, openNewTab } = require('../src/index');

test('the new-tab address bar starts empty at its first character', () => {
  const state = {
    mode: 'browse',
    address: null,
    core: { source: 'ax' },
    drawn: { address: null, hint: null },
  };
  const page = { url: () => 'about:blank' };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    focusAddressBar(state, page, '');
  } finally {
    process.stdout.write = write;
  }

  assert.equal(state.mode, 'address');
  assert.deepEqual(state.address, { text: '', caret: 0, scroll: 0 });
});

test('opening a new tab follows it with an empty address bar focused', async () => {
  const page = { url: () => 'about:blank' };
  const state = {
    core: {
      newTab: async () => page,
    },
  };
  const events = [];

  await openNewTab(
    state,
    async (...args) => events.push(['switch', ...args]),
    (...args) => events.push(['address', ...args]),
  );

  assert.deepEqual(events, [
    ['switch', state, page, { note: 'Opened a new tab' }],
    ['address', state, page, ''],
  ]);
});
