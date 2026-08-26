'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { openNewTab } = require('../src/index');

test('opening a new tab follows it immediately', async () => {
  const page = {};
  const state = {
    core: {
      newTab: async () => page,
    },
  };
  const switched = [];

  await openNewTab(state, async (...args) => switched.push(args));

  assert.deepEqual(switched, [[state, page, { note: 'Opened a new tab' }]]);
});
