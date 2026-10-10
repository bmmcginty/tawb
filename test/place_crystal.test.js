'use strict';

// The line-space half of the place-keeping policy, differenced between the
// JavaScript original and the Crystal port: the same wrapped views, the same
// places, the same landings. Where the cursor comes down after a view switch
// must not depend on the runtime, and the guesses that policy makes when a
// text match is only approximate must at least be the same guesses.

const test = require('node:test');
const assert = require('node:assert');

const placeModule = require('../src/place');
const { placeImplementations } = require('./crystal_impl');

const SPAN_BLOCKS = [
  { text: 'x', item: { name: 'x', axIndex: 0 } },
  { text: 'wrap word', item: { role: 'text', name: '' } },
  { text: 'y', item: { name: 'y', axIndex: 2 } },
  { text: 'solo', item: { name: 'solo', axIndex: 3 } },
];
const SPAN_LINES = [
  { text: 'x y', blockIndex: 0, spans: [
    { start: 0, end: 1, blockIndex: 0 }, { start: 2, end: 3, blockIndex: 2 },
  ] },
  { text: 'wrap', blockIndex: 1 },
  { text: 'word', blockIndex: 1, continuation: true },
  { text: 'solo', blockIndex: 3 },
];

const PAGE_BLOCKS = [
  { text: 'Top story', item: { name: 'Top story', axIndex: 0 } },
  { text: 'A paragraph that runs on and on', item: { role: 'text', name: '' } },
  { text: 'Second story', item: { name: 'Second story', axIndex: 2 } },
  { text: 'more prose', item: { role: 'text', name: '' } },
];
const PAGE_LINES = [
  { text: 'Top story', blockIndex: 0 },
  { text: 'A paragraph that', blockIndex: 1 },
  { text: 'runs on and on', blockIndex: 1, continuation: true },
  { text: 'Second story', blockIndex: 2 },
  { text: 'more prose', blockIndex: 3 },
];

const REPEAT_BLOCKS = [
  { text: 'far', item: { name: 'far', axIndex: 0 } },
  { text: 'same', item: { role: 'text', name: '' } },
  { text: 'same', item: { name: 'same', axIndex: 2 } },
  { text: 'near page', item: { name: 'near page', axIndex: 3 } },
];
const REPEAT_LINES = [
  { text: 'far', blockIndex: 0 },
  { text: 'same', blockIndex: 1 },
  { text: 'same', blockIndex: 2 },
  { text: 'near page', blockIndex: 3 },
];

const scripts = {
  'a line knows the blocks it carries': [
    { op: 'state', source: 'ax', blocks: SPAN_BLOCKS, lines: SPAN_LINES, cursor: 0, col: 0 },
    { op: 'positions_at_line', line: 0 },
    { op: 'positions_at_line', line: 2 },
    { op: 'positions_at_line', line: 9 },
    { op: 'block_index_at_line', line: 0, col: 0 },
    { op: 'block_index_at_line', line: 0, col: 2 },
    { op: 'block_index_at_line', line: 0, col: 7 },
    { op: 'block_index_at_line', line: 2 },
    { op: 'block_index_at_line', line: 9 },
    { op: 'position_of_block', block: 2 },
    { op: 'position_of_block', block: 1 },
    { op: 'position_of_block', block: 5 },
  ],

  'an element is recognised by its index, or by role and name on the tree': [
    { op: 'state', source: 'ax', blocks: SPAN_BLOCKS, lines: SPAN_LINES, cursor: 0, col: 0 },
    { op: 'has_element', item: { name: 'x', axIndex: 3 } },
    { op: 'has_element', item: { role: 'text', name: 'prose' } },
    { op: 'has_element', item: { role: 'link', name: 'Go' } },
    { op: 'has_element', item: { role: 'link' } },
    { op: 'has_element', item: {} },
    { op: 'has_element', source: 'source', item: { name: 'x', domIndex: 1 } },
    { op: 'has_element', source: 'source', item: { name: 'x' } },
    { op: 'index_of_item', item: { axIndex: 3 } },
    { op: 'index_of_item', item: {} },
    { op: 'index_of_item', source: 'render', item: { axIndex: 3 } },
    // The nearest element at or above the cursor, prose walked past.
    { op: 'anchor', block: 3 },
    { op: 'anchor', block: 1 },
    { op: 'anchor', block: 0 },
  ],

  'the reader lands on the text they were reading': [
    { op: 'state', source: 'ax', blocks: PAGE_BLOCKS, lines: PAGE_LINES, cursor: 0, col: 0 },
    { op: 'locate_by_text', place: {
      text: 'Second story', col: 3, onElement: false, label: '', ordinal: null, total: null, ratio: 0.8,
    } },
    { op: 'cursor' },
    // The block's own text is gone, but the element's label names it still.
    { op: 'locate_by_text', place: {
      text: 'gone entirely', col: 0, onElement: false, label: 'Second story',
      ordinal: null, total: null, ratio: 0,
    } },
    { op: 'cursor' },
    // A partial match is only trusted from something long enough to mean
    // something, and lands as 'near'.
    { op: 'locate_by_text', place: {
      text: 'story', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
    { op: 'cursor' },
    // Nothing matches: the element's place in document order estimates a
    // landing rather than giving up.
    { op: 'locate_by_text', place: {
      text: 'nothing matches this at all', col: 0, onElement: false, label: '',
      ordinal: 1, total: 4, ratio: 0.9,
    } },
    { op: 'cursor' },
    // Nothing matches and there is no ordinal: no answer at all, and the
    // cursor is left where the caller's fallback put it.
    { op: 'locate_by_text', place: {
      text: 'zzz', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0.9,
    } },
    { op: 'cursor' },
  ],

  'the nearest of several identical lines wins, not the first': [
    { op: 'state', source: 'ax', blocks: REPEAT_BLOCKS, lines: REPEAT_LINES, cursor: 0, col: 0 },
    { op: 'locate_by_text', place: {
      text: 'same', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0.9,
    } },
    { op: 'cursor' },
  ],

  'landing on the element itself keeps the column within its text': [
    { op: 'state', source: 'ax', blocks: PAGE_BLOCKS, lines: PAGE_LINES, cursor: 0, col: 0 },
    { op: 'land_on', block: 2, exact: true, place: {
      text: 'Second story', col: 2, onElement: true, label: '', ordinal: null, total: null, ratio: 0,
    } },
    { op: 'cursor' },
    { op: 'land_on', block: 2, exact: false, place: {
      text: 'Second story', col: 2, onElement: true, label: '', ordinal: null, total: null, ratio: 0,
    } },
    // The reader was on prose, not the element: the landing looks down from
    // where the element sits for their own line again. A wrapped row is a
    // continuation, so the search finds the words at the head of the block
    // and gives the column where they begin.
    { op: 'land_on', block: 1, exact: false, place: {
      text: 'paragraph', col: 4, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
    { op: 'cursor' },
    { op: 'land_on', block: 5, exact: true, place: {
      text: 'anywhere', col: 0, onElement: true, label: '', ordinal: null, total: null, ratio: 0,
    } },
  ],

  'a text search runs down from the element, not from the top': [
    { op: 'state', source: 'ax', blocks: PAGE_BLOCKS, lines: PAGE_LINES, cursor: 0, col: 0 },
    { op: 'refine_to_text', from: 0, place: {
      text: 'more prose', col: 3, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
    // A substring, not a block's own text: exact stays false, and the column
    // is where the words begin.
    { op: 'refine_to_text', from: 0, place: {
      text: 'prose', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
    // Nothing to look for, nothing found.
    { op: 'refine_to_text', from: 0, place: {
      text: '', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
    { op: 'refine_to_text', from: 0, place: {
      text: 'zzz', col: 0, onElement: false, label: '', ordinal: null, total: null, ratio: 0,
    } },
  ],
};

const implementations = placeImplementations(placeModule);

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);
  const run = (name) => implementation.scenario(scripts[name]);

  check('a line knows the blocks it carries', () => {
    const seen = run('a line knows the blocks it carries');
    assert.deepEqual(seen[1], [
      { line: 0, col: 0, end: 1, blockIndex: 0 },
      { line: 0, col: 2, end: 3, blockIndex: 2 },
    ]);
    assert.deepEqual(seen[2], [], 'a continuation carries nothing of its own');
    assert.deepEqual(seen[3], []);
    assert.deepEqual(seen.slice(4, 9), [0, 2, 2, 1, -1]);
    assert.deepEqual(seen[9], { line: 0, col: 2, end: 3, blockIndex: 2 });
    assert.deepEqual(seen[10], { line: 1, col: 0, end: 4, blockIndex: 1 });
    assert.equal(seen[11], null);
  });

  check('an element is recognised, and found above prose', () => {
    const seen = run('an element is recognised by its index, or by role and name on the tree');
    assert.deepEqual(seen.slice(1, 8), [true, false, true, false, false, true, false]);
    assert.deepEqual(seen.slice(8, 11), [3, null, null]);
    assert.deepEqual(seen.slice(11), [3, 0, 0]);
  });

  check('the reader lands on the text they were reading', () => {
    const seen = run('the reader lands on the text they were reading');
    assert.equal(seen[1], 'exact');
    assert.deepEqual(seen[2], { cursor: 3, col: 3 });
    assert.equal(seen[3], 'exact', 'the label names the line the text was on');
    assert.deepEqual(seen[4], { cursor: 3, col: 0 });
    assert.equal(seen[5], 'near');
    assert.deepEqual(seen[6], { cursor: 0, col: 0 },
      'the partial lands on the first Top story, which is where the estimate put it');
    assert.equal(seen[7], 'near', 'the estimate lands rather than giving up');
    assert.deepEqual(seen[8], { cursor: 1, col: 0 });
    assert.equal(seen[9], null);
    assert.deepEqual(seen[10], { cursor: 1, col: 0 }, 'and the cursor is left alone');
  });

  check('the nearest of several identical lines wins, not the first', () => {
    const seen = run('the nearest of several identical lines wins, not the first');
    assert.equal(seen[1], 'exact');
    assert.deepEqual(seen[2], { cursor: 2, col: 0 });
  });

  check('landing on the element keeps the column, or looks down for prose', () => {
    const seen = run('landing on the element itself keeps the column within its text');
    assert.equal(seen[1], 'exact');
    assert.deepEqual(seen[2], { cursor: 3, col: 2 });
    assert.equal(seen[3], 'near');
    assert.equal(seen[4], 'near', 'the element is line three, the prose is not on it');
    assert.deepEqual(seen[5], { cursor: 1, col: 2 });
    assert.equal(seen[6], null, 'a block with no line in this view lands nowhere');
  });

  check('a text search runs down from the element, not from the top', () => {
    const seen = run('a text search runs down from the element, not from the top');
    assert.deepEqual(seen[1], { line: 4, col: 3, exact: true });
    assert.deepEqual(seen[2], { line: 4, col: 5, exact: false });
    assert.deepEqual(seen[3], { line: 0, col: 0, exact: false });
    assert.deepEqual(seen[4], { line: 0, col: 0, exact: false });
  });
}

if (implementations.length > 1) {
  const [javascript, crystal] = implementations;
  for (const [name, script] of Object.entries(scripts)) {
    test(`both runtimes agree: ${name}`, () => {
      assert.deepEqual(crystal.scenario(script), javascript.scenario(script));
    });
  }
}
