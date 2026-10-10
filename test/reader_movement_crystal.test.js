'use strict';

// The reader's selection movement, differenced between the JavaScript
// original and the Crystal port: where the cursor lands, what was repainted,
// and — the part a screen reader feels — what was scrolled rather than
// redrawn.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/index.html';

function stateFor(overrides = {}) {
  const blocks = (overrides.core?.blocks) ?? [
    { item: { role: 'text', name: 'first' } },
    { item: { role: 'link', name: 'one', href: 'https://example.test/a' } },
    { item: { role: 'text', name: 'after' } },
  ];
  return {
    rows: 24, cols: 80, mode: 'browse',
    cursor: 0, col: 0, scroll: 0,
    lines: overrides.lines ?? [
      { text: 'first', blockIndex: 0 },
      { text: 'one', blockIndex: 1 },
      { text: 'after', blockIndex: 2 },
    ],
    core: { source: 'ax', blocks },
    statusMsg: '', drawn: {}, linkAddress: true,
    ...overrides,
    core: { source: 'ax', blocks, ...(overrides.core ?? {}) },
  };
}

function run(name, state, actions) {
  const results = implementations.map((implementation) =>
    implementation.draw({ state: JSON.parse(JSON.stringify(state)), actions,
      page: { url: PAGE_URL } }));
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('a selection move clamps to the buffer and repaints the status row', { skip: needsCrystal }, () => {
  const state = stateFor();
  const result = run('move past the end', state, [
    { op: 'moveSelection', cursor: 99 },
  ]);
  assert.equal(result.state.cursor, 2);
});

test('a one-line scroll uses the terminal scroll rather than a repaint', { skip: needsCrystal }, () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ item: { role: 'text' } }));
  const state = stateFor({ lines, core: { blocks } });
  // The 18-row viewport shows lines 0..17; moving to line 18 scrolls once.
  const result = run('one-line scroll', state, [{ op: 'moveSelection', cursor: 18 }]);
  const writes = result.results.flatMap((entry) => entry.writes);
  // One IND scroll, one rewritten row, one cursor move: not a list repaint.
  assert.ok(writes.includes('\x1bD'), `no scroll region write in ${writes}`);
  assert.ok(!writes.includes('\x1b[r'), 'a one-line scroll repainted the list');
});

test('a multi-line scroll repaints the whole list', { skip: needsCrystal }, () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ item: { role: 'text' } }));
  const result = run('multi-line scroll', stateFor({ lines, core: { blocks } }), [
    { op: 'moveSelection', cursor: 20 },
  ]);
  const writes = result.results.flatMap((entry) => entry.writes);
  assert.ok(writes.includes('\x1b[r'), 'the scroll region was not reset for the repaint');
});

test('the caret walks between rows through their joins', { skip: needsCrystal }, () => {
  const state = stateFor();
  const left = run('caret left at column 0 joins the previous line', state, [
    { op: 'moveSelection', cursor: 2, col: 0 },
    { op: 'moveCaretLeft' },
  ]);
  assert.equal(left.state.cursor, 1);
  assert.equal(left.state.col, 2, 'the caret took the previous line last column');

  const right = run('caret right past the end joins the next line', stateFor(), [
    { op: 'moveSelection', cursor: 1, col: 2 },
    { op: 'moveCaretRight' },
  ]);
  assert.equal(right.state.cursor, 2, 'the caret took the next line first column');
  assert.equal(right.state.col, 0);
});

test('position for a block answers the line and the span column', { skip: needsCrystal }, () => {
  const lines = [
    { text: 'a paragraph that wraps onto', blockIndex: 0, spans: [
      { start: 0, end: 27, blockIndex: 0 },
      { start: 28, end: 40, blockIndex: 1 },
    ] },
    { text: 'two', blockIndex: 1, continuation: true },
  ];
  const state = stateFor({ lines, core: { blocks: [
    { item: { role: 'text' } }, { item: { role: 'link', name: 'two' } },
  ] } });
  const first = run('first block', state, [{ op: 'positionForBlock', blockIndex: 0 }]);
  assert.deepEqual(first.results[0].value, { line: 0, col: 0 });
  const second = run('second block', state, [{ op: 'positionForBlock', blockIndex: 1 }]);
  assert.deepEqual(second.results[0].value, { line: 0, col: 28 });
});

test('the first and last focusable items include spans and skip continuations', { skip: needsCrystal }, () => {
  const lines = [
    { text: 'one two', blockIndex: 0, spans: [
      { start: 0, end: 3, blockIndex: 0 },
      { start: 4, end: 7, blockIndex: 1 },
    ] },
    { text: 'carried', blockIndex: 1, continuation: true },
    { text: 'tail', blockIndex: 2 },
  ];
  const state = stateFor({ lines, core: { blocks: [
    { item: { role: 'text' } },
    { item: { role: 'link', name: 'two' } },
    { item: { role: 'link', name: 'tail' } },
  ] } });
  const forward = run('first focusable', state, [{ op: 'focusableEdge', direction: 1 }]);
  assert.deepEqual(forward.results[0].value, { line: 0, col: 4 });
  const backward = run('last focusable', state, [{ op: 'focusableEdge', direction: -1 }]);
  assert.deepEqual(backward.results[0].value, { line: 2, col: 0 });
});

test('a Lynx move repaints the highlight rows instead of the whole list', { skip: needsCrystal }, () => {
  const lines = Array.from({ length: 6 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ item: { role: 'link', name: `l${i}` } }));
  const state = stateFor({ lines, core: { blocks }, interface: 'lynx' });
  const result = run('lynx selection', state, [{ op: 'moveSelection', cursor: 3 }]);
  const writes = result.results.flatMap((entry) => entry.writes);
  assert.ok(!writes.includes('\x1b[r'), 'a same-screen Lynx move repainted the list');
});
