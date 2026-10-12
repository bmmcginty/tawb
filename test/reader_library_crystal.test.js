'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { readerImplementations } = require('./crystal_impl');
const implementations = readerImplementations(require('../src/index'), require('../src/keys'));
const skip = implementations.length < 2 ? 'the Crystal runtime is not enabled' : false;
const PAGE = 'https://example.test/page';
const blocks = [{ text: 'page text', item: { role: 'text' } }];

function state(overrides = {}, provider = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default', title: 'Example',
    cursor: 0, col: 0, scroll: 0, statusMsg: '', drawn: {}, linkAddress: false,
    lines: [{ text: 'page text', blockIndex: 0 }],
    keys: { bindings: { bookmarks: ['B'], history: ['H'], downloads: ['D'],
      'add-bookmark': ['A'] } },
    core: { source: 'ax', blocks, popup: null, popupAt: -1,
      live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 } },
    browserLibrary: provider,
    ...overrides,
  };
}

async function both(name, initial, actions, compareResults = true,
  page = { url: PAGE, title: 'Example' }) {
  const out = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state: initial, actions, page }));
    out.push(await (implementation.drawAsync ? implementation.drawAsync(spec) : implementation.draw(spec)));
  }
  assert.deepEqual(out[1].state, out[0].state, name);
  if (compareResults) assert.deepEqual(out[1].results, out[0].results, name);
  return out[0];
}

test('browser bookmarks open, filter, and close back at the page', { skip }, async () => {
  const result = await both('bookmark list', state({}, {
    bookmarks: [
      { title: 'Crystal', url: 'https://crystal-lang.org/', folder: 'Tools' },
      { title: 'Braille', url: 'https://example.test/braille', folder: 'Reading' },
    ],
  }), [
    { op: 'browseKey', chunk: 'B' },
    { op: 'libraryKey', chunk: 'c' },
    { op: 'libraryKey', chunk: '\x1b' },
  ], false);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.title, 'Example');
  assert.equal(result.state.lines[0].text, 'page text');
  assert.equal(result.state.statusMsg, 'Closed bookmarks.');
});

test('browser library failures are spoken without leaving the page', { skip }, async () => {
  const result = await both('library failure', state({}, { failure: 'agent unavailable' }), [
    { op: 'browseKey', chunk: 'H' },
  ]);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'Could not read history: agent unavailable');
});

test('back and forward restore the place held for each history entry', { skip }, async () => {
  const history = [
    { url: 'https://example.test/one', title: 'One',
      blocks: [{ text: 'one top', item: { role: 'text' } }, { text: 'one place', item: { role: 'text' } }] },
    { url: PAGE, title: 'Example', blocks },
  ];
  const initial = state({
    cursor: 0,
    keys: { bindings: { 'history-back': ['K'], 'history-forward': ['J'] } },
  });
  const result = await both('page history', initial, [
    { op: 'browseKey', chunk: 'K' },
    { op: 'moveSelection', cursor: 1 },
    { op: 'browseKey', chunk: 'J' },
    { op: 'browseKey', chunk: 'K' },
  ], false, { url: PAGE, title: 'Example', history, historyIndex: 1 });
  assert.equal(result.state.title, 'One');
  assert.equal(result.state.lines[1].text, 'one place');
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.statusMsg, 'Went back to https://example.test/one');
});

// Every deliberate move files the place the entry is being left at, not just
// a step through history: a link followed, a form submitted, an address
// loaded, a real click. Back then returns to the line that was being read.
test('a link followed files the place its entry is left at', { skip }, async () => {
  const pageBlocks = [
    { text: 'page text', item: { role: 'text' } },
    { text: '[Go]', item: { role: 'link', name: 'Go', href: '/elsewhere' } },
  ];
  const history = [
    { url: 'https://example.test/one', title: 'One',
      blocks: [{ text: 'one top', item: { role: 'text' } }] },
    { url: PAGE, title: 'Example', blocks: pageBlocks },
  ];
  const initial = state({
    cursor: 1,
    lines: pageBlocks.map((block, index) => ({ text: block.text, blockIndex: index })),
    keys: { bindings: { 'history-back': ['K'], 'history-forward': ['J'] } },
    core: { source: 'ax', blocks: pageBlocks, popup: null, popupAt: -1,
      live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 } },
  });
  const result = await both('place filed by a link', initial, [
    { op: 'browseKey', chunk: '\r' },
    { op: 'browseKey', chunk: 'K' },
    { op: 'browseKey', chunk: 'J' },
  ], false, { url: PAGE, title: 'Example', history, historyIndex: 1 });
  assert.equal(result.state.title, 'Example', 'forward came back to the page');
  assert.equal(result.state.cursor, 1, 'and to the line the link was followed from');
});

test('the current page can be bookmarked through the browser agent', { skip }, async () => {
  const saved = await both('save bookmark', state(), [
    { op: 'browseKey', chunk: 'A', keys: ['\r'] },
  ], false);
  assert.equal(saved.state.statusMsg, 'Bookmarked "Example".');
  const failed = await both('save failed', state({}, { saveFailure: 'read only' }), [
    { op: 'browseKey', chunk: 'A', keys: ['\r'] },
  ], false);
  assert.equal(failed.state.statusMsg, 'Could not bookmark it: read only');
});
