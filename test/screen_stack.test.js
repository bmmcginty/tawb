'use strict';

// The screen order: the page is the base, a pushed screen owns the top, and a
// screen can only pop itself while it is there.

const test = require('node:test');
const assert = require('node:assert');
const { ScreenStack } = require('../src/screen_stack');

test('the page is the base and cannot be popped', () => {
  const stack = new ScreenStack();
  assert.equal(stack.top().mode, 'page');
  assert.equal(stack.depth(), 0);
  assert.equal(stack.pop(), null);
  assert.equal(stack.top().mode, 'page');
  assert.equal(stack.below(), null);
});

test('screens push and pop in order', () => {
  const stack = new ScreenStack();
  stack.push({ mode: 'library', kind: 'bookmarks' });
  stack.push({ mode: 'choose', kind: 'select' });
  assert.equal(stack.depth(), 2);
  assert.equal(stack.top().mode, 'choose');
  assert.equal(stack.below().mode, 'library');
  assert.equal(stack.has('library'), true);
  // A screen cannot be popped out from under another.
  assert.equal(stack.pop('library'), null);
  assert.equal(stack.pop('choose').mode, 'choose');
  assert.equal(stack.pop('library').kind, 'bookmarks');
  assert.equal(stack.top().mode, 'page');
});

test('a screen needs a mode and cannot claim the base', () => {
  const stack = new ScreenStack();
  assert.throws(() => stack.push({}), /needs a mode/);
  assert.throws(() => stack.push({ mode: 'page' }), /base/);
});
