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
    { op: 'libraryKey', chunk: '/' },
    { op: 'libraryKey', chunk: 'c' },
    { op: 'libraryKey', chunk: '\x1b' },
    { op: 'libraryKey', chunk: '\x1b' },
  ], false);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.title, 'Example');
  assert.equal(result.state.lines[0].text, 'page text');
  assert.equal(result.state.statusMsg, 'Closed bookmarks.');
});

test('a narrower filter keeps the native cursor on the same entry', { skip }, async () => {
  const result = await both('filter keeps place', state({}, {
    history: [
      { title: 'Braille', url: 'https://example.test/braille' },
      { title: 'Politics', url: 'https://example.test/politics' },
      { title: 'Louis Braille', url: 'https://example.test/louis' },
    ],
  }), [
    { op: 'browseKey', chunk: 'H' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '/' },
    { op: 'libraryKey', chunk: 'b' },
  ], false);
  assert.equal(result.state.cursor, 1);
  assert.match(result.state.lines[1].text, /^Louis Braille/);
  assert.equal(result.state.lines.length, 2);
});

test('Alt+D removes the selected bookmark from the bookmarks list', { skip }, async () => {
  const result = await both('delete bookmark', state({}, {
    bookmarks: [
      { title: 'Crystal', url: 'https://crystal-lang.org/', folder: 'Tools' },
      { title: 'Braille', url: 'https://example.test/braille', folder: 'Reading' },
    ],
  }), [
    { op: 'browseKey', chunk: 'B' },
    { op: 'libraryKey', chunk: '\x1bd', keys: ['y'] },
  ], false);
  assert.equal(result.state.mode, 'library', 'removal leaves the list open');
  assert.deepEqual(result.state.library.rows, ['Braille — https://example.test/braille — in Reading']);
  assert.equal(result.state.statusMsg, 'Removed bookmark "Crystal".');
});

// The entry that takes the removed one's place is where the cursor belongs;
// the last entry has nothing below it, so the nearest place is above.
test('removing a bookmark keeps the native cursor in the list', { skip }, async () => {
  const bookmarks = ['One', 'Two', 'Three', 'Four', 'Five'].map((title, index) => ({
    bookmarkId: String(index + 1),
    title,
    url: `https://example.test/${title.toLowerCase()}`,
  }));

  const below = await both('delete keeps place', state({}, { bookmarks }), [
    { op: 'browseKey', chunk: 'B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1bd', keys: ['y'] },
  ], false);
  assert.equal(below.state.cursor, 3);
  assert.equal(below.state.library.rows[3], 'Five — https://example.test/five');

  const last = await both('delete last keeps place', state({}, { bookmarks }), [
    { op: 'browseKey', chunk: 'B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1b[B' },
    { op: 'libraryKey', chunk: '\x1bd', keys: ['y'] },
  ], false);
  assert.equal(last.state.cursor, 3);
  assert.equal(last.state.library.rows[3], 'Four — https://example.test/four');
});

test('a printable letter filters a Lynx list instead of quitting', { skip }, async () => {
  const result = await both('lynx list filter', state({
    interface: 'lynx',
    keys: { profile: 'lynx', bindings: { bookmarks: ['v'] } },
  }, {
    bookmarks: [{ title: 'Crystal', url: 'https://crystal-lang.org/', folder: 'Tools' }],
  }), [
    { op: 'browseKey', chunk: 'v' },
    { op: 'libraryKey', chunk: '/' },
    { op: 'libraryKey', chunk: 'q' },
  ], false);
  assert.equal(result.state.mode, 'library', 'q did not quit');
  assert.equal(result.state.lines[0].text, 'Nothing matching "q".');

  // Del is the filter's Backspace, not a character above space.
  const erased = await both('lynx list erase', state({
    interface: 'lynx',
    keys: { profile: 'lynx', bindings: { bookmarks: ['v'] } },
  }, {
    bookmarks: [{ title: 'Crystal', url: 'https://crystal-lang.org/', folder: 'Tools' }],
  }), [
    { op: 'browseKey', chunk: 'v' },
    { op: 'libraryKey', chunk: '/' },
    { op: 'libraryKey', chunk: 'q' },
    { op: 'libraryKey', chunk: '\x7f' },
  ], false);
  assert.equal(erased.state.library.rows.length, 1);
});

test('information moves with j instead of filtering on it', { skip }, async () => {
  const result = await both('info movement', state(), [
    { op: 'openDocumentInfo' },
    { op: 'libraryKey', chunk: 'j' },
  ], false);
  assert.equal(result.state.mode, 'library');
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.library.rows.length, 5);
  assert.equal(result.state.lines[1].text, 'Linkname: Example');
});

test('information is filtered explicitly with slash', { skip }, async () => {
  const result = await both('info explicit filter', state(), [
    { op: 'openDocumentInfo' },
    { op: 'libraryKey', chunk: '/' },
    { op: 'libraryKey', chunk: 's' },
    { op: 'libraryKey', chunk: 'i' },
    { op: 'libraryKey', chunk: 'z' },
    { op: 'libraryKey', chunk: 'e' },
    { op: 'libraryKey', chunk: '\r' },
  ], false);
  assert.equal(result.state.mode, 'library');
  assert.equal(result.state.lines[0].text.includes('size:'), true);
  assert.equal(result.state.drawn.status, '1 of 5 matching "size".');
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
