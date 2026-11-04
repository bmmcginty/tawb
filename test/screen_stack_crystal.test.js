'use strict';

// The native screen stack, differenced against the shipping reader.

const test = require('node:test');
const assert = require('node:assert');
const { ScreenStack } = require('../src/screen_stack');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

test('native screen order matches for push, top and pop', { skip }, () => {
  const actions = [
    { op: 'push', mode: 'library', kind: 'bookmarks' },
    { op: 'push', mode: 'choose', kind: 'select' },
    { op: 'pop', mode: 'library' },
    { op: 'top' },
    { op: 'pop', mode: 'choose' },
    { op: 'pop', mode: 'library' },
    { op: 'top' },
  ];
  const stack = new ScreenStack();
  const expected = actions.map((action) => {
    if (action.op === 'push') return { pushed: stack.push(action).mode };
    if (action.op === 'pop') return { popped: stack.pop(action.mode)?.mode ?? null };
    return { top: stack.top().mode };
  });
  assert.deepEqual(call('screen_stack.scenario', { actions }), expected);
});
