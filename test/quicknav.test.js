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

// Lynx splits movement more finely than "next focusable", and the split is
// visible exactly where TAWB's own presentation puts several items on one
// display row: a reflowed paragraph or a table row.
function rowsState() {
  return {
    cursor: 0,
    col: 0,
    lines: [
      { text: '[A] [B]', spans: [
        { blockIndex: 0, start: 0, end: 3 }, { blockIndex: 1, start: 4, end: 7 },
      ] },
      { text: '[ ] [C]', spans: [
        { blockIndex: 2, start: 0, end: 3 }, { blockIndex: 3, start: 4, end: 7 },
      ] },
      { text: '[D]', spans: [{ blockIndex: 4, start: 0, end: 3 }] },
    ],
    core: {
      blocks: [
        { item: { role: 'link' } },
        { item: { role: 'link' } },
        { item: { role: 'textbox' } },
        { item: { role: 'link' } },
        { item: { role: 'link' } },
      ],
    },
  };
}

function moveTo(state, action, options) {
  const spec = QUICK_ACTIONS[action];
  return findQuickNav(state, spec.match, spec.direction,
    options || { sameLine: spec.sameLine });
}

test('NEXT_LINK walks the links on the row before leaving it', () => {
  const state = rowsState();
  assert.deepEqual(moveTo(state, 'next-focusable'), { line: 0, col: 4 },
    'the second link on the row was skipped');
  state.col = 5;
  assert.deepEqual(moveTo(state, 'next-focusable'), { line: 1, col: 0 },
    'the movement did not reach the next row');
});

test('DOWN_LINK leaves the row it is on, which is what distinguishes it', () => {
  const state = rowsState();
  assert.deepEqual(moveTo(state, 'down-link'), { line: 1, col: 0 },
    'DOWN_LINK stopped on the row the reader was already on');
  state.cursor = 2;
  assert.equal(moveTo(state, 'down-link'), null, 'there is no row below the last one');
});

test('FASTFORW_LINK stops only on things that are activated', () => {
  const state = rowsState();
  assert.deepEqual(moveTo(state, 'fast-forward-link'), { line: 0, col: 4 });
  state.col = 5;
  assert.deepEqual(moveTo(state, 'fast-forward-link'), { line: 1, col: 4 },
    'the fast movement stopped on the text field');
  state.cursor = 1; state.col = 5;
  assert.deepEqual(moveTo(state, 'fast-forward-link'), { line: 2, col: 0 });
});

test('UP_LINK and FASTBACKW_LINK move back the same two ways', () => {
  const state = rowsState();
  state.cursor = 2;
  assert.deepEqual(moveTo(state, 'up-link'), { line: 1, col: 0 },
    'the row above, at the reader\'s own column');
  // FASTBACKW_LINK walks back over the row it is on before leaving it.
  state.cursor = 1; state.col = 5;
  assert.deepEqual(moveTo(state, 'fast-backward-link'), { line: 1, col: 4 });
  state.col = 0;
  assert.deepEqual(moveTo(state, 'fast-backward-link'), { line: 0, col: 0 });
});

test('an ordinary line still moves one line at a time', () => {
  // The two readings agree wherever a row holds one item, which is every row
  // of the ordinary interface.
  const state = pageOf('text', 'link', 'text', 'button');
  assert.deepEqual(moveTo(state, 'next-focusable'), { line: 1, col: 0 });
  assert.deepEqual(moveTo(state, 'down-link'), { line: 1, col: 0 });
  assert.deepEqual(moveTo(state, 'fast-forward-link'), { line: 1, col: 0 });
});

test('half a screen is a step of half the viewport', () => {
  const { moveScreen, relayout } = require('../src/index');
  const state = {
    cursor: 0, col: 0, scroll: 0, lines: [], drawn: {},
    core: { blocks: [], at() {}, live: { refreshing: false } },
  };
  state.core.blocks = Array.from({ length: 100 }, (_, i) => ({ text: `line ${i}`, item: null }));
  relayout(state);
  state.lines = state.core.blocks.map((_, i) => ({ blockIndex: i, text: `line ${i}` }));
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    moveScreen(state, 1, { url: () => 'https://example.test/' }, 20, 10);
  } finally { process.stdout.write = write; }
  assert.equal(state.cursor, 10, 'a half screen moved by half, not by a whole one');
});
