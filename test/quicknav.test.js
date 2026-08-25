'use strict';

// Tab and Shift+Tab, which move between the things you can interact with.
//
// The single-letter jumps ask for one kind at a time — l for a link, b for a
// button, f for a form field. Tab asks for whichever comes next, which is
// what it does in a graphical browser and what a reader coming from one
// expects it to do.

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { QUICK_ACTIONS, findQuickNav } = require('../src/index');
const { FOCUSABLE_ROLES, LINK_ROLES, BUTTON_ROLES, FIELD_ROLES } = require('../src/aria');

// A page as the reader moves over it: one line per block, no wrapping.
function pageOf(...roles) {
  return {
    cursor: 0,
    lines: roles.map((_, i) => ({ blockIndex: i })),
    core: { blocks: roles.map((role) => ({ item: { role } })) },
  };
}

function walk(state, action) {
  const spec = QUICK_ACTIONS[action];
  const seen = [];
  for (;;) {
    const found = findQuickNav(state, spec.match, spec.direction);
    if (!found) return seen;
    state.cursor = found.line;
    seen.push(found.line);
  }
}

test('Tab and Shift+Tab are bound out of the box', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(keys.actionFor('\t'), 'next-focusable', 'Tab moves to the next control');
  assert.equal(keys.actionFor('\x1b[Z'), 'previous-focusable', 'Shift+Tab moves back');
  // Named, so the wizard shows "Tab" rather than the Ctrl+I it shares a byte with.
  assert.equal(keys.nameForSequence('\t'), 'Tab');
  assert.equal(keys.nameForSequence('\x1b[Z'), 'Shift+Tab');
});

test('Shift+Tab prefers the terminal\'s own back-tab', () => {
  const keys = new Keymap({ terminfo: { 'Shift+Tab': '\x1b[27;2;9~' }, load: false });
  assert.equal(keys.actionFor('\x1b[27;2;9~'), 'previous-focusable', 'terminfo back-tab was ignored');
  assert.equal(keys.actionFor('\x1b[Z'), 'previous-focusable', 'the usual sequence stopped working');
});

test('every kind of control is one Tab stops on, and nothing else is', () => {
  for (const role of [...LINK_ROLES, ...BUTTON_ROLES, ...FIELD_ROLES]) {
    assert.ok(FOCUSABLE_ROLES.has(role), `${role} is a control Tab should stop on`);
  }
  for (const role of ['text', 'heading', 'img', 'listitem']) {
    assert.equal(FOCUSABLE_ROLES.has(role), false, `Tab should not stop on ${role}`);
  }
});

test('Tab walks links, buttons and fields together, in document order', () => {
  //            0       1       2         3         4       5
  const state = pageOf('text', 'link', 'heading', 'button', 'text', 'textbox');
  assert.deepEqual(walk(state, 'next-focusable'), [1, 3, 5],
    'Tab skipped a control, or stopped on something that is not one');
});

test('Shift+Tab walks the same stops backwards', () => {
  const state = pageOf('text', 'link', 'heading', 'button', 'text', 'textbox');
  state.cursor = 5;
  assert.deepEqual(walk(state, 'previous-focusable'), [3, 1],
    'Shift+Tab did not retrace the forward order');
});

test('Tab is not the single-kind jumps, which still ask for one kind', () => {
  const roles = ['link', 'button', 'textbox'];
  assert.deepEqual(walk(pageOf(...roles), 'next-link'), [],
    'starting on the only link, l should find no other');
  assert.deepEqual(walk(pageOf(...roles), 'next-button'), [1], 'b found more than the button');
  assert.deepEqual(walk(pageOf(...roles), 'next-field'), [2], 'f found more than the field');
  assert.deepEqual(walk(pageOf(...roles), 'next-focusable'), [1, 2],
    'Tab should find the button and the field ahead of it');
});

test('a page with nothing to interact with reports no next control', () => {
  const state = pageOf('text', 'heading', 'text');
  assert.equal(findQuickNav(state, QUICK_ACTIONS['next-focusable'].match, 1), null);
  assert.equal(QUICK_ACTIONS['next-focusable'].label, 'control',
    'the label is what "No next ..." is built from');
});
