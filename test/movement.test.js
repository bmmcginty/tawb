'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  moveScreen, preserveViewportRow, markInput, keepLivePlace,
} = require('../src/index');

// Plain prose, so the status row has no link target to announce and the
// screen movement being measured is the only thing happening.
function movementState(length, cursor, scroll) {
  const blocks = Array.from({ length }, (_, i) => ({ item: { role: 'text', name: `line ${i}` } }));
  return {
    mode: 'browse',
    lines: Array.from({ length }, (_, i) => ({ text: `line ${i}`, blockIndex: i })),
    cursor,
    scroll,
    col: 0,
    statusMsg: '',
    drawn: {},
    core: { at() {}, source: 'ax', blocks },
  };
}

const PAGE = { url: () => 'https://example.test/' };

function withoutTerminalOutput(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}

test('screen movement keeps one context line and preserves the cursor row', () => {
  const state = movementState(30, 3, 0);

  withoutTerminalOutput(() => moveScreen(state, 1, PAGE, 5));

  // The old screen was 0..4 and the new one is 4..8: line 4 is the join.
  assert.equal(state.scroll, 4);
  assert.equal(state.cursor, 7);
  assert.equal(state.cursor - state.scroll, 3);

  withoutTerminalOutput(() => moveScreen(state, -1, PAGE, 5));
  assert.equal(state.scroll, 0);
  assert.equal(state.cursor, 3);
});

test('screen movement clamps the final partial screen and reaches its end', () => {
  const state = movementState(12, 7, 4);

  withoutTerminalOutput(() => moveScreen(state, 1, PAGE, 5));

  assert.equal(state.scroll, 7);
  assert.equal(state.cursor, 11);
});

test('switching to a much longer view preserves the cursor row', () => {
  const state = movementState(1000, 700, 0);

  preserveViewportRow(state, 2, 20);

  assert.equal(state.scroll, 698);
  assert.equal(state.cursor - state.scroll, 2);
});

test('startup refreshes stay at the top until the reader chooses a place', () => {
  let marked = 0;
  const state = { inputSeen: false, core: { markInput: () => { marked += 1; } } };

  assert.equal(keepLivePlace(state, false), false);
  markInput(state);
  assert.equal(marked, 1);
  assert.equal(keepLivePlace(state, false), true);
  assert.equal(keepLivePlace(state, true), false);
});
