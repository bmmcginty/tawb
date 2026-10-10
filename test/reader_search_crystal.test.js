'use strict';

// In-buffer search and the find prompt, differenced between the JavaScript
// original and the Crystal port: where a match lands, what the status line
// says about it, and what each keystroke does to the prompt.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/';

function stateFor(overrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse',
    cursor: 0, col: 0, scroll: 0,
    lines: overrides.lines ?? [
      { text: 'alpha bravo', blockIndex: 0 },
      { text: 'charlie delta', blockIndex: 1 },
      { text: 'bravo echo', blockIndex: 2 },
    ],
    core: { source: 'ax', blocks: [] },
    statusMsg: '', drawn: {}, linkAddress: true,
    ...overrides,
  };
}

function run(name, state, actions, keys) {
  const spec = { state: JSON.parse(JSON.stringify(state)), actions, page: { url: PAGE_URL } };
  if (keys) spec.state.keys = keys;
  const results = implementations.map((implementation) => implementation.draw(spec));
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('a search lands on the matching text itself', { skip: needsCrystal }, () => {
  const state = stateFor();
  const result = run('forward search', state, [
    { op: 'findText', needle: 'bravo', direction: 1 },
  ]);
  assert.deepEqual(result.results[0].value, { line: 0, col: 6, wrapped: false });

  // Backward from column 0 skips the line the reader is standing on and
  // wraps to the earlier match.
  const backward = run('backward search', stateFor({ cursor: 2 }), [
    { op: 'findText', needle: 'bravo', direction: -1 },
  ]);
  assert.deepEqual(backward.results[0].value, { line: 0, col: 6, wrapped: false });
});

test('a lowercase search ignores case, one with a capital does not', { skip: needsCrystal }, () => {
  const lines = [{ text: 'BRAVO bravo', blockIndex: 0 }];
  const state = stateFor({ lines, core: { blocks: [] } });
  const lower = run('lowercase needle', state, [
    { op: 'findText', needle: 'bravo', direction: 1 },
  ]);
  // Searching from just past the cursor finds the second occurrence.
  assert.deepEqual(lower.results[0].value, { line: 0, col: 6, wrapped: false });

  const mixed = run('mixed-case needle', stateFor({ lines, cursor: 0, col: 0 }), [
    { op: 'findText', needle: 'Bravo', direction: 1 },
  ]);
  assert.equal(mixed.results[0].value, null);
});

test('the Lynx Searching Type option decides case outright', { skip: needsCrystal }, () => {
  const lines = [{ text: 'BRAVO', blockIndex: 0 }];
  const keys = { profile: 'lynx', load: false, terminfo: {},
    preferences: { searchCase: 'CASE_SENSITIVE' } };
  const result = run('lynx sensitive', stateFor({ lines, interface: 'lynx' }), [
    { op: 'findText', needle: 'bravo', direction: 1 },
  ], keys);
  assert.equal(result.results[0].value, null);
});

test('a search that passes the end of the page wraps and says so', { skip: needsCrystal }, () => {
  const lines = [
    { text: 'b here', blockIndex: 0 },
    { text: 'nothing to find', blockIndex: 1 },
  ];
  const state = stateFor({ lines, cursor: 1, col: 0 });
  const result = run('wrapped search', state, [
    { op: 'runSearch', needle: 'b', direction: 1 },
  ]);
  assert.equal(result.state.statusMsg, '"b" — line 1 of 2, wrapped.');
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.col, 0);
});

test('a search with no match leaves the reader where they were', { skip: needsCrystal }, () => {
  const state = stateFor();
  const result = run('no match', state, [
    { op: 'runSearch', needle: 'zebra', direction: 1 },
  ]);
  assert.equal(result.state.statusMsg, '"zebra" not found.');
  assert.equal(result.state.cursor, 0);
});

test('the find prompt takes the keyboard and redraws itself', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.mode = 'find';
  state.find = { direction: 1, text: '', caret: 0 };
  const result = run('typing into the prompt', state, [
    { op: 'findKey', chunk: 'b' },
    { op: 'findKey', chunk: 'r' },
  ]);
  assert.deepEqual(result.state.find, { direction: 1, text: 'br', caret: 2 });
  // The prompt row shows what is typed; the cursor follows the caret.
  const writes = result.results.flatMap((entry) => entry.writes);
  assert.deepEqual(writes[writes.length - 3], '\x1b[24;1H');
  assert.equal(writes[writes.length - 2], '\x1b[2K/br');
  assert.equal(writes[writes.length - 1], '\x1b[24;4H', 'the cursor follows the caret');
});

test('editing keys work in the find prompt', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.mode = 'find';
  state.find = { direction: 1, text: 'brxvo', caret: 3 };
  const result = run('edit the needle', state, [
    { op: 'findKey', chunk: '\x7f' }, // Backspace
    { op: 'findKey', chunk: 'a' },
  ]);
  assert.deepEqual(result.state.find, { direction: 1, text: 'bravo', caret: 3 });
});

test('Enter searches, returns to browse, and remembers the needle', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.mode = 'find';
  state.find = { direction: 1, text: 'delta', caret: 5 };
  const result = run('enter searches', state, [
    { op: 'findKey', chunk: '\r' },
  ]);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.cursor, 1);
  assert.deepEqual(result.state.lastFind, { direction: 1, text: 'delta' });
});

test('Enter on an empty prompt repeats the last search', { skip: needsCrystal }, () => {
  const state = stateFor({ cursor: 1 });
  state.mode = 'find';
  state.find = { direction: 1, text: '', caret: 0 };
  state.lastFind = { direction: 1, text: 'bravo' };
  const result = run('repeat search', state, [
    { op: 'findKey', chunk: '\r' },
  ]);
  assert.equal(result.state.mode, 'browse');
  assert.deepEqual(result.state.lastFind, { direction: 1, text: 'bravo' });
  assert.equal(result.state.cursor, 2);
});

test('Enter on an empty prompt with nothing searched for says so', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.mode = 'find';
  state.find = { direction: 1, text: '', caret: 0 };
  const result = run('empty repeat', state, [
    { op: 'findKey', chunk: '\r' },
  ]);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'Nothing searched for yet — type what to find.');
  assert.equal(result.state.lastFind, null);
});

test('Escape and Ctrl+C cancel the prompt without searching', { skip: needsCrystal }, () => {
  for (const key of ['\x1b', '\x03']) {
    const state = stateFor();
    state.mode = 'find';
    state.find = { direction: 1, text: 'delta', caret: 5 };
    const result = run('cancel', state, [{ op: 'findKey', chunk: key }]);
    assert.equal(result.state.mode, 'browse');
    assert.equal(result.state.statusMsg, 'Search cancelled.');
    assert.equal(result.state.cursor, 0);
  }
});
