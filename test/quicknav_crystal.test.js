'use strict';

// Quick navigation, differenced between the JavaScript original and the
// Crystal port: which line and column each kind of jump lands on, which
// jumps find nothing, and the words that say so.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/';

function pageOf(...roles) {
  return {
    rows: 24, cols: 80, mode: 'browse',
    cursor: 0, col: 0, scroll: 0,
    lines: roles.map((_, i) => ({ text: `line ${i}`, blockIndex: i })),
    core: { source: 'ax', blocks: roles.map((role) => ({ item: { role } })) },
    statusMsg: '', drawn: {}, linkAddress: true,
  };
}

function rowsState() {
  return {
    rows: 24, cols: 80, mode: 'browse',
    cursor: 0, col: 0, scroll: 0,
    lines: [
      { text: '[A] [B]', blockIndex: 0, spans: [
        { blockIndex: 0, start: 0, end: 3 }, { blockIndex: 1, start: 4, end: 7 },
      ] },
      { text: '[ ] [C]', blockIndex: 0, spans: [
        { blockIndex: 2, start: 0, end: 3 }, { blockIndex: 3, start: 4, end: 7 },
      ] },
      { text: '[D]', blockIndex: 0, spans: [
        { blockIndex: 4, start: 0, end: 3 },
      ] },
    ],
    core: { source: 'ax', blocks: [
      { item: { role: 'link' } },
      { item: { role: 'link' } },
      { item: { role: 'textbox' } },
      { item: { role: 'link' } },
      { item: { role: 'link' } },
    ] },
    statusMsg: '', drawn: {}, linkAddress: true,
  };
}

function walk(name, state, action, expected) {
  const result = implementations.map((implementation) =>
    implementation.draw({ state: JSON.parse(JSON.stringify(state)),
      page: { url: PAGE_URL },
      actions: [{ op: 'quickWalk', action }] }));
  assert.deepEqual(result[1].results, result[0].results, name);
  assert.deepEqual(result[0].results[0].value, expected, name);
  return result[0];
}

test('Tab walks links, buttons and fields together, in document order', { skip: needsCrystal }, () => {
  walk('tab forward', pageOf('text', 'link', 'heading', 'button', 'text', 'textbox'),
    'next-focusable', [
      { line: 1, col: 0 }, { line: 3, col: 0 }, { line: 5, col: 0 },
    ]);
});

test('Shift+Tab walks the same stops backwards', { skip: needsCrystal }, () => {
  const state = pageOf('text', 'link', 'heading', 'button', 'text', 'textbox');
  state.cursor = 5;
  walk('tab backward', state, 'previous-focusable', [
    { line: 3, col: 0 }, { line: 1, col: 0 },
  ]);
});

test('the single-kind jumps ask for one kind only', { skip: needsCrystal }, () => {
  const state = pageOf('link', 'button', 'textbox');
  walk('next link from the only link', state, 'next-link', []);
  walk('next button', state, 'next-button', [{ line: 1, col: 0 }]);
  walk('next field', state, 'next-field', [{ line: 2, col: 0 }]);
});

test('Lynx walks the links and fields of the current row before other rows', { skip: needsCrystal }, () => {
  const state = rowsState();
  walk('same line first', state, 'next-focusable', [
    { line: 0, col: 4 }, { line: 1, col: 4 }, { line: 2, col: 0 },
  ]);
});

test('Lynx walks backwards along the current row by column', { skip: needsCrystal }, () => {
  const state = rowsState();
  state.cursor = 1;
  state.col = 7;
  const result = implementations.map((implementation) =>
    implementation.draw({ state: JSON.parse(JSON.stringify(state)),
      page: { url: PAGE_URL },
      actions: [{ op: 'findQuickNav', action: 'previous-focusable' }] }));
  assert.deepEqual(result[1].results, result[0].results);
  assert.deepEqual(result[0].results[0].value, { line: 1, col: 4 });
});

test('paragraphs are the starts of block-level text runs', { skip: needsCrystal }, () => {
  const state = pageOf('text', 'text', 'heading', 'text');
  state.core.blocks[1].startsBlock = true;
  state.core.blocks[3].isParagraph = true;
  const result = implementations.map((implementation) =>
    implementation.draw({ state: JSON.parse(JSON.stringify(state)),
      page: { url: PAGE_URL },
      actions: [{ op: 'findParagraph', direction: 1 }] }));
  assert.deepEqual(result[1].results, result[0].results);
  assert.deepEqual(result[0].results[0].value, { line: 1, col: 0 });
});

test('a jump with nothing ahead says so, and a hit lands and names itself', { skip: needsCrystal }, () => {
  const state = pageOf('text', 'link');
  const result = implementations.map((implementation) =>
    implementation.draw({ state: JSON.parse(JSON.stringify(state)),
      page: { url: PAGE_URL },
      actions: [
        { op: 'jumpTo', found: null, label: 'heading', direction: 1 },
        { op: 'jumpTo', found: { line: 1, col: 0 }, label: 'link', direction: 1 },
      ] }));
  assert.deepEqual(result[1].results, result[0].results);
  assert.deepEqual(result[1].state.statusMsg, result[0].state.statusMsg);
  assert.deepEqual(result[0].state.statusMsg, 'No next heading.');
  assert.equal(result[0].state.cursor, 1);
});
