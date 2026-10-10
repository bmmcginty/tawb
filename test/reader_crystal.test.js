'use strict';

// The reader's terminal drawing, differenced between the JavaScript original
// and the Crystal port: which rows were written, what they said, and — the
// behaviour the whole design exists for — which rows were left alone because
// they already said it.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');
const index = require('../src/index');
const { Keymap } = require('../src/keys');

const implementations = readerImplementations(index, { Keymap });
// Every case here is a differential: without the Crystal runtime there is
// nothing to difference, which is a skip and not a failure.
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const LINK = { role: 'link', name: 'one', href: 'https://example.test/about' };
const PAGE_URL = 'https://example.test/index.html';
const HERE = 'https://example.test/a/b/c';
const HINT = 'j/k line  h/l/f/b/n/p nav  / find  m click  \\ view  ^L address  c changes  q quit';

function stateFor(overrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse',
    cursor: 0, col: 0, scroll: 0,
    lines: [
      { text: 'Before', blockIndex: 0 },
      { text: 'one', blockIndex: 1 },
      { text: 'after', blockIndex: 2 },
    ],
    core: { source: 'ax', blocks: [
      { item: { role: 'text', name: 'Before' } },
      { item: LINK },
      { item: { role: 'text', name: 'after' } },
    ] },
    statusMsg: '', drawn: {}, linkAddress: true,
    ...overrides,
  };
}

function run(implementation, state, actions, page = { url: PAGE_URL }) {
  return implementation.draw({ state, actions, page });
}

function both(name, state, actions, page) {
  // Each runtime gets its own copy: the drawn-row caches are mutable state,
  // and the first run must not pre-fill them for the second.
  const results = implementations.map((implementation) =>
    run(implementation, JSON.parse(JSON.stringify(state)), actions, page));
  assert.deepEqual(results[1], results[0], name);
  return results[0];
}

// The value the single action answered, both runtimes agreeing.
function valueOf(name, state, actions, page) {
  return both(name, state, actions, page).results[0].value;
}

// A row rewrite is a move and then the erase-and-write; the transaction
// arrives as two writes on both runtimes.
function row(row_, text) {
  return [`\x1b[${row_};1H`, `\x1b[2K${text}`];
}

test('the title, address and hint each take their own row once', { skip: needsCrystal }, () => {
  const { results } = both('banner rows', stateFor({ title: 'Example Domain' }), [
    { op: 'drawTitle' },
    { op: 'drawAddress' },
    { op: 'drawHint' },
  ]);
  assert.deepEqual(results.map((result) => result.writes), [
    row(1, 'Example Domain'),
    row(2, '[AX] https://example.test/index.html'),
    row(3, HINT.slice(0, 80)),
  ]);
});

test('an unchanged row is not rewritten, but a forced paint is', { skip: needsCrystal }, () => {
  const { results } = both('title cache', stateFor({ title: 'Example Domain' }), [
    { op: 'drawTitle' },
    { op: 'drawTitle' },
    { op: 'drawTitle', force: true },
  ]);
  assert.deepEqual(results[1].writes, [], 'the same title was drawn twice');
  assert.deepEqual(results[2].writes, row(1, 'Example Domain'), 'a forced redraw was skipped');

  const changed = both('title change', stateFor({ title: 'Somewhere Else' }), [
    { op: 'drawTitle' },
  ]);
  assert.deepEqual(changed.results[0].writes, row(1, 'Somewhere Else'));
});

test('a page title is escaped before it is cut to the terminal width', { skip: needsCrystal }, () => {
  const escaped = both('escaped title', stateFor({
    title: '中文 😀', escapeUnicode: true,
  }), [{ op: 'drawTitle' }]);
  assert.deepEqual(escaped.results[0].writes, row(1, '\\u4E2D\\u6587 \\U0001F600'));

  const long = both('cut title', stateFor({ title: 'x'.repeat(500) }), [{ op: 'drawTitle' }]);
  const written = long.results[0].writes[1].replace('\x1b[2K', '');
  assert.equal(written.length, 80, 'the title row ran past the edge of the window');
});

test('a long address is truncated with a marker', { skip: needsCrystal }, () => {
  const longAddress = 'https://example.test/' + 'x'.repeat(100);
  const { results } = both('address', stateFor(), [
    { op: 'drawAddress' },
  ], { url: longAddress });
  const written = results[0].writes[1].replace('\x1b[2K', '');
  assert.equal(written, '[AX] ' + longAddress.slice(0, 74) + '>',
    'the address row is exactly the terminal wide and ends with the marker');
});

test('typing in the address bar rewrites its suffix like nano', { skip: needsCrystal }, () => {
  // The drawn row and caret are where the last draw left them: the buffer
  // holds one more character than the row did, typed at the caret.
  const edit = both('address typing', stateFor({
    mode: 'address',
    address: { text: 'example.xco', caret: 9, scroll: 0 },
    drawn: { address: '[SOURCE] example.co', addressCaretCol: 18 },
    core: { source: 'source' },
  }), [
    { op: 'drawAddress', edit: true },
  ], { url: 'https://old.example/' });
  assert.deepEqual(edit.results[0].writes, ['xco\x08\x08'],
    'typing was not one nano-style terminal transaction');

  // Moving left in the same buffer is a single backspace, both runtimes.
  const moved = both('address left', {
    mode: 'address',
    address: { text: 'example.co', caret: 7, scroll: 0 },
    drawn: { address: '[SOURCE] example.co', addressCaretCol: 18 },
    core: { source: 'source' },
  }, [{ op: 'drawAddress', edit: true }]);
  assert.deepEqual(moved.results[0].writes, ['\x08']);
});

test('the address scrolls around the caret while it is edited', { skip: needsCrystal }, () => {
  const { results } = both('address scroll', stateFor({
    mode: 'address',
    address: { text: 'x'.repeat(200), caret: 100, scroll: 0 },
    core: { source: 'source' },
  }), [
    { op: 'drawAddress', force: true },
    { op: 'drawAddress', edit: true },
  ]);
  const written = results[0].writes[1].replace('\x1b[2K', '');
  assert.ok(written.startsWith('[SOURCE] '), 'the address lost its source label');
  assert.equal(written.length, 80, 'the visible window is the width of the terminal');
  // The caret is marked after the row is written; the second call moves only
  // the caret, since the row already says what it should.
  assert.match(results[0].writes.at(-1), /^\x1b\[2;\d+H$/);
  assert.deepEqual(results[1].writes, [results[0].writes.at(-1)],
    'an unchanged row moved only the caret');
});

test('standing on a link names where it goes on the status row', { skip: needsCrystal }, () => {
  const { results } = both('link status', stateFor({ cursor: 1 }), [{ op: 'drawStatus' }]);
  assert.deepEqual(results[0].writes, row(24, 'https://example.test/about'));

  const { results: target } = both('link target', stateFor({ cursor: 1 }), [{ op: 'linkTarget' }]);
  assert.equal(target[0].value, 'https://example.test/about');
});

test('prose, a heading and a button go nowhere', { skip: needsCrystal }, () => {
  for (const item of [{ role: 'text', name: 'some prose' },
    { role: 'heading', name: 'Contents', level: '2' },
    { role: 'button', name: 'Play' }]) {
    const state = stateFor();
    state.core.blocks = [{ item }];
    state.lines = [{ text: 'line', blockIndex: 0 }];
    assert.equal(valueOf('not a link', state, [{ op: 'linkTarget' }]), null);
  }
  // role="link" on a div is a link to the reader and has no target at all.
  const bare = stateFor();
  bare.core.blocks = [{ item: { role: 'link', name: 'Menu' } }];
  bare.lines = [{ text: 'line', blockIndex: 0 }];
  assert.equal(valueOf('bare link', bare, [{ op: 'linkTarget' }]), null);
});

test('one of the browser\'s own lists is not the page talking', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.library = { label: 'Bookmarks', blocks: [{ item: { role: 'link', name: 'A bookmark', href: 'https://saved.test/' } }] };
  state.lines = [{ text: 'A bookmark', blockIndex: 0 }];
  assert.equal(valueOf('library link', state, [{ op: 'linkTarget' }]), null);
});

test('a row that already says it is not written again', { skip: needsCrystal }, () => {
  const state = stateFor({ cursor: 1 });
  state.drawn.status = 'https://example.test/about';
  const { results } = both('status cache', state, [
    { op: 'drawStatus' },
    { op: 'drawStatus' },
  ]);
  assert.deepEqual(results[0].writes, []);
  assert.deepEqual(results[1].writes, []);
});

test('a prompt owns the status row while it is up', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.mode = 'find';
  const { results } = both('prompt owns status', state, [{ op: 'drawStatus' }]);
  assert.deepEqual(results[0].writes, []);
});

test('a reader who does not want the row to speak can switch it off', { skip: needsCrystal }, () => {
  const state = stateFor();
  state.linkAddress = false;
  state.statusMsg = 'Loaded https://example.test/index.html';
  state.drawn.status = state.statusMsg;
  const { results } = both('switched off', state, [
    { op: 'linkTarget' },
    { op: 'drawStatus' },
  ]);
  assert.equal(results[0].value, null);
  assert.deepEqual(results[1].writes, []);
});

test('the short form is off until it is asked for', { skip: needsCrystal }, () => {
  const state = stateFor({ cursor: 1 });
  state.shortLinks = true;
  assert.equal(valueOf('short links', state, [{ op: 'linkTarget' }]), '/about');
});

test('short targets are said the way a person would say them', { skip: needsCrystal }, () => {
  const cases = [
    ['https://example.test/b', HERE, '/b'],
    ['https://example.test/a/b/d?q=1', HERE, '/a/b/d?q=1'],
    ['https://example.test/', HERE, '/'],
    ['https://example.test', HERE, '/'],
    ['https://other.test/b', HERE, 'https://other.test/b'],
    ['http://example.test/b', HERE, 'http://example.test/b'],
    ['https://example.test:8443/b', HERE, 'https://example.test:8443/b'],
    ['mailto:someone@example.test', HERE, 'mailto:someone@example.test'],
    ['https://example.test/a/b/c#notes', HERE, '#notes'],
    ['https://example.test/a/b/c', HERE, '/a/b/c'],
    ['not an address', HERE, 'not an address'],
    // A different kind of page is a different place, whatever it shares.
    ['https://example.test/b', 'about:blank', 'https://example.test/b'],
  ];
  for (const [href, here, expected] of cases) {
    assert.equal(valueOf(`short ${href}`, {}, [{ op: 'shortTarget', href, here }]),
      expected, `${href} against ${here}`);
  }
});

test('every mode is answered by its own hint', { skip: needsCrystal }, () => {
  const modes = ['browse', 'address', 'type', 'field-command', 'forms', 'control',
    'page', 'find', 'number', 'choose', 'library', 'line', 'files', 'dialog', 'auth'];
  for (const mode of modes) {
    const state = stateFor({ mode });
    if (mode === 'page') {
      state.keys = { profile: 'default', bindings: { 'page-keyboard': ['Alt+K'] } };
    }
    if (mode === 'library') state.library = { label: 'Bookmarks' };
    if (mode === 'line') state.line = { label: 'Bookmark this page' };
    if (mode === 'files') state.files = { chosen: [], multiple: false };
    if (mode === 'auth') {
      state.auth = { challenge: { origin: 'https://example.test', realm: 'Secrets', scheme: 'Basic' } };
    }
    const hint = valueOf(`hint ${mode}`, state, [{ op: 'hintText' }]);
    assert.ok(hint && hint.length > 0, `no hint for ${mode}`);
  }
  // The Lynx profile has its own copy to say.
  const lynx = stateFor({ mode: 'type', interface: 'lynx' });
  assert.match(valueOf('lynx typing hint', lynx, [{ op: 'hintText' }]),
    /arrows or Tab to move off of field/);
});

test('the webpage-keyboard hint names the key that leaves it', { skip: needsCrystal }, () => {
  const state = stateFor({ mode: 'page', keys: { profile: 'default', bindings: { 'page-keyboard': ['Alt+K'] } } });
  assert.match(valueOf('page hint', state, [{ op: 'hintText' }]), /Alt\+K: stop/);
});

test('the auth hint names the origin that is asking', { skip: needsCrystal }, () => {
  const state = stateFor({ mode: 'auth', auth: {
    challenge: { origin: 'https://example.test', realm: 'Secrets', scheme: 'Basic' },
  } });
  assert.match(valueOf('auth hint', state, [{ op: 'hintText' }]),
    /Sign in to https:\/\/example\.test — "Secrets" \(Basic\)/);
});

test('a proxy challenge does not pretend to be the site', { skip: needsCrystal }, () => {
  const state = stateFor({ mode: 'auth', auth: {
    challenge: { origin: 'https://proxy.test:3128', source: 'proxy' },
  } });
  assert.match(valueOf('proxy hint', state, [{ op: 'hintText' }]),
    /the proxy at https:\/\/proxy\.test:3128/);
});

test('the cursor parks on the reader, wherever the reader is', { skip: needsCrystal }, () => {
  const parked = both('park browse', stateFor({ cursor: 2, col: 3 }), [
    { op: 'parkCursor' },
  ]);
  assert.deepEqual(parked.results[0].writes, ['\x1b[7;4H']);

  // The first line of the list is row 5: four header rows above it.
  assert.equal(valueOf('line row', stateFor({ cursor: 2, scroll: 1 }), [
    { op: 'lineRow', lineIndex: 3 },
  ]), 7);

  const typed = both('park typing', stateFor({
    mode: 'type',
    typing: { item: { role: 'textbox', name: 'Search' }, text: 'hello', caret: 3 },
  }), [{ op: 'parkCursor' }, { op: 'typingText' }]);
  assert.deepEqual(typed.results[0].writes, ['\x1b[5;13H']);
  assert.deepEqual(typed.results[1].value, { text: '[Search: hello]', caretCol: 13 });
  // Both runtimes, same answer (the both() above already agreed).

  const find = both('park find', stateFor({ mode: 'find', find: { direction: 1, text: 'ab', caret: 1 } }), [
    { op: 'drawFind' },
  ]);
  assert.deepEqual(find.results[0].writes, [...row(24, '/ab'), '\x1b[24;3H']);

  const auth = both('park auth', stateFor({ mode: 'auth', auth: {
    challenge: { origin: 'https://example.test' },
    stage: 'password', password: { text: 'secret', caret: 4 },
  } }), [{ op: 'drawAuthPrompt' }]);
  assert.deepEqual(auth.results[0].writes, [...row(24, 'password: ******'), '\x1b[24;15H']);

  const line = both('park line', stateFor({ mode: 'line', line: {
    label: 'Name', buffer: { text: 'tawb', caret: 2 },
  } }), [{ op: 'drawLinePrompt' }]);
  assert.deepEqual(line.results[0].writes, [...row(24, 'Name: tawb'), '\x1b[24;9H']);
});

test('Lynx hides its cursor at the bottom-right unless asked not to', { skip: needsCrystal }, () => {
  const hidden = both('lynx hides', stateFor({
    interface: 'lynx', keys: { profile: 'lynx', preferences: {} },
  }), [{ op: 'parkCursor' }, { op: 'lynxHidesCursor' }]);
  assert.deepEqual(hidden.results[0].writes, ['\x1b[24;80H']);
  assert.equal(hidden.results[1].value, true);

  const shown = both('lynx shows', stateFor({
    interface: 'lynx', keys: { profile: 'lynx', preferences: { showCursor: true } },
  }), [{ op: 'parkCursor' }, { op: 'lynxHidesCursor' }]);
  assert.deepEqual(shown.results[0].writes, ['\x1b[5;1H']);
  assert.equal(shown.results[1].value, false);

  // The default interface never hides the cursor, whatever its preferences.
  const tawb = both('tawb shows', stateFor({
    interface: 'tawb', keys: { profile: 'default', preferences: {} },
  }), [{ op: 'parkCursor' }]);
  assert.deepEqual(tawb.results[0].writes, ['\x1b[5;1H']);
});

test('the list repaints only its own rows, in place', { skip: needsCrystal }, () => {
  const { results } = both('draw list', stateFor(), [{ op: 'drawList' }]);
  // The region reset, eighteen viewport rows written as a move and an
  // erase-and-write each, and the region re-armed.
  assert.equal(results[0].writes.length, 1 + 18 * 2 + 1);
  assert.equal(results[0].writes[0], '\x1b[r', 'the scroll region was not reset first');
  assert.deepEqual(results[0].writes.slice(1, 5), [
    '\x1b[5;1H', '\x1b[2KBefore', '\x1b[6;1H', '\x1b[2Kone',
  ]);
  assert.deepEqual(results[0].writes.slice(-3), [
    '\x1b[22;1H', '\x1b[2K', '\x1b[5;22r',
  ], 'the last row is erased, not skipped, and the region is re-armed');
});

test('Lynx marks the current link with reverse video, and headings with bold', { skip: needsCrystal }, () => {
  const state = stateFor({
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: { numberLinks: true } },
    cursor: 1,
  });
  const { results } = both('lynx rows', state, [
    { op: 'renderRow', lineIndex: 0 },
    { op: 'renderRow', lineIndex: 1 },
  ]);
  assert.equal(results[0].value, 'Before');
  assert.equal(results[1].value, '\x1b[7mone\x1b[0m');

  const heading = stateFor({
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: { numberLinks: true } },
  });
  heading.core.blocks = [{ item: { role: 'heading', name: 'Contents', level: '2' } }];
  heading.lines = [{ text: 'Contents', blockIndex: 0 }];
  const { results: headingRows } = both('heading row', heading, [
    { op: 'renderRow', lineIndex: 0 },
  ]);
  assert.equal(headingRows[0].value, '\x1b[1mContents\x1b[0m');
});

test('a full render clamps the scroll, repaints, and tells the core where the reader is', { skip: needsCrystal }, () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ item: { role: 'text', name: `line ${i}` } }));
  const { results, state } = both('render', stateFor({
    lines, cursor: 29, core: { source: 'ax', blocks },
  }), [{ op: 'render' }]);

  assert.equal(state.scroll, 30 - 18, 'the scroll did not follow the cursor');
  assert.equal(state.atCalls.at(-1), 29, 'the core was not told where the reader is');
  // An empty title is still a change from nothing drawn, but it says nothing.
  assert.deepEqual(results[0].writes.slice(0, 2), ['\x1b[1;1H', '\x1b[2K']);
  assert.match(results[0].writes.at(-1), /^\x1b\[22;1H$/,
    'the cursor was parked on the last line of the list');
  assert.ok(results[0].writes.some((write) => write.includes('line 29')),
    'the line the reader is on was not drawn');
});

test('clampScroll keeps the cursor inside the window and says where they are', { skip: needsCrystal }, () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ item: { role: 'text', name: `line ${i}` } }));
  const { state } = both('clamp', stateFor({
    lines, cursor: 2, scroll: 10, core: { source: 'ax', blocks },
  }), [{ op: 'clampScroll' }]);
  assert.equal(state.scroll, 2);
  assert.deepEqual(state.atCalls, [2]);

  // While one of the browser's own lists is open, the buffer is not the
  // page, and the core is told nothing at all.
  const library = stateFor({
    lines, cursor: 2, scroll: 10,
    library: { label: 'Bookmarks', blocks },
  });
  const { state: libraryState } = both('clamp library', library, [{ op: 'clampScroll' }]);
  assert.equal(libraryState.scroll, 2);
  assert.deepEqual(libraryState.atCalls, []);
});

test('setStatus writes the row at once and leaves the cursor on the reader', { skip: needsCrystal }, () => {
  const { results } = both('set status', stateFor(), [
    { op: 'setStatus', msg: 'Loading https://example.test…' },
  ]);
  assert.deepEqual(results[0].writes, [
    ...row(24, 'Loading https://example.test…'), '\x1b[5;1H',
  ]);
});

test('the viewport is what is left after the banner and the status row', { skip: needsCrystal }, () => {
  assert.equal(valueOf('viewport', stateFor({ rows: 30, cols: 100 }), [
    { op: 'viewportHeight' },
  ]), 24);
});

// ---------------------------------------------------------------------------
// Row-level damage: repaint only what changed, in place.
// ---------------------------------------------------------------------------

function pageRows(count) {
  return Array.from({ length: count }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
}

test('visibleRowsNow is sparse and only as wide as the viewport', { skip: needsCrystal }, () => {
  const { results } = both('visible rows', stateFor({
    lines: pageRows(30), scroll: 2,
  }), [{ op: 'visibleRowsNow' }, { op: 'screenBefore' }]);
  const rows = results[0].value;
  assert.equal(rows.length, 2 + 18, 'the answer is not wider than scroll plus viewport');
  assert.equal(rows[0], null, 'the rows above the window are holes');
  assert.equal(rows[1], null);
  assert.equal(rows[2], 'line 2');
  assert.equal(rows.at(-1), 'line 19');
  assert.deepEqual(results[1].value, {
    rows, scroll: 2, height: 18,
  });
});

test('a repaint after a change rewrites only the rows that changed', { skip: needsCrystal }, () => {
  const lines = pageRows(30).map((line, i) => (
    i === 4 ? { text: 'line 4, changed', blockIndex: i } : line
  ));
  const before = both('screen before', stateFor({
    lines: pageRows(30), cursor: 4,
  }), [{ op: 'screenBefore' }]).results[0].value;

  const { results } = both('patch rows', stateFor({
    lines, cursor: 4,
    drawn: { title: 'Example Domain', address: '[AX] https://example.test/index.html', hint: HINT.slice(0, 80) },
    title: 'Example Domain',
  }), [{ op: 'repaintList', before }]);
  assert.equal(results[0].value, 1, 'one row changed, so one row was rewritten');
  assert.deepEqual(results[0].writes, [...row(9, 'line 4, changed'), '\x1b[9;1H'],
    'the changed row was rewritten in place and the cursor parked on the reader');
});

test('a repaint with nothing changed writes nothing but the cursor', { skip: needsCrystal }, () => {
  const before = both('before unchanged', stateFor({ lines: pageRows(6) }), [
    { op: 'screenBefore' },
  ]).results[0].value;
  const { results } = both('patch nothing', stateFor({
    lines: pageRows(6),
    drawn: { title: 'Example Domain', address: '[AX] https://example.test/index.html', hint: HINT.slice(0, 80) },
    title: 'Example Domain',
  }), [{ op: 'repaintList', before }]);
  assert.equal(results[0].value, 0);
  assert.deepEqual(results[0].writes, ['\x1b[5;1H']);
});

test('a scrolled view cannot be patched row by row, so it is redrawn', { skip: needsCrystal }, () => {
  const before = both('before scrolled', stateFor({
    lines: pageRows(30), cursor: 2,
  }), [{ op: 'screenBefore' }]).results[0].value;
  const { results } = both('repaint scrolled', stateFor({
    lines: pageRows(30), cursor: 10, scroll: 10,
    drawn: { title: 'Example Domain', address: '[AX] https://example.test/index.html', hint: HINT.slice(0, 80) },
    title: 'Example Domain',
  }), [{ op: 'repaintList', before }]);
  assert.equal(results[0].value, null, 'a scrolled repaint is a full repaint');
  assert.equal(results[0].writes[0], '\x1b[r', 'the full repaint re-arms its scroll region');
  assert.equal(results[0].writes.filter((write) => write.startsWith('\x1b[')).length > 20,
    true, 'every viewport row was written');
});

test('a repaint with no record of the screen falls back to a full repaint', { skip: needsCrystal }, () => {
  const { results } = both('repaint blind', stateFor({
    lines: pageRows(6),
    drawn: { title: 'Example Domain', address: '[AX] https://example.test/index.html', hint: HINT.slice(0, 80) },
    title: 'Example Domain',
  }), [{ op: 'repaintList', before: null }]);
  assert.equal(results[0].value, null);
  assert.equal(results[0].writes[0], '\x1b[r');
});

test('a resized terminal cannot be patched row by row either', { skip: needsCrystal }, () => {
  const before = both('before resized', stateFor({
    lines: pageRows(30), rows: 24, cols: 80,
  }), [{ op: 'screenBefore' }]).results[0].value;
  const { results } = both('repaint resized', stateFor({
    lines: pageRows(30), rows: 30, cols: 100,
    drawn: { title: 'Example Domain', address: '[AX] https://example.test/index.html', hint: HINT.slice(0, 80) },
    title: 'Example Domain',
  }), [{ op: 'repaintList', before }]);
  assert.equal(results[0].value, null, 'a different height is a full repaint');
});

test('the Lynx selection repaints the rows it leaves and lands on', { skip: needsCrystal }, () => {
  const base = {
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: {} },
    lines: [
      { text: 'one', blockIndex: 0 },
      { text: 'two', blockIndex: 1 },
      { text: 'prose', blockIndex: 2 },
    ],
    core: { source: 'ax', blocks: [
      { item: { role: 'link', name: 'one', href: 'https://example.test/1' } },
      { item: { role: 'link', name: 'two', href: 'https://example.test/2' } },
      { item: { role: 'text', name: 'prose' } },
    ] },
  };

  const moved = both('lynx selection', stateFor({ ...base, cursor: 1 }), [
    { op: 'repaintLynxSelection', oldCursor: 0 },
  ]);
  assert.deepEqual(moved.results[0].writes, [
    ...row(5, 'one'), ...row(6, '\x1b[7mtwo\x1b[0m'),
  ], 'the row left was unmarked and the row landed on was marked');

  const unmoved = both('lynx selection unmoved', stateFor({ ...base, cursor: 0 }), [
    { op: 'repaintLynxSelection', oldCursor: 0 },
  ]);
  assert.deepEqual(unmoved.results[0].writes, [], 'no move, no repaint');
});

test('a composite row repaints every fragment of the blocks it touches', { skip: needsCrystal }, () => {
  const state = stateFor({
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: {} },
    cursor: 0, col: 8,
    lines: [
      { text: 'Before one after', blockIndex: 0, spans: [
        { start: 0, end: 6, blockIndex: 0 },
        { start: 7, end: 10, blockIndex: 1 },
        { start: 11, end: 16, blockIndex: 2 },
      ] },
      { text: 'Second two', blockIndex: 3, spans: [
        { start: 0, end: 6, blockIndex: 3 },
        { start: 7, end: 10, blockIndex: 1 },
      ] },
    ],
    core: { source: 'ax', blocks: [
      { item: { role: 'text', name: 'Before' } },
      { item: { role: 'link', name: 'one', href: 'https://example.test/1' } },
      { item: { role: 'text', name: 'after' } },
      { item: { role: 'text', name: 'Second' } },
    ] },
  });
  const { results } = both('lynx composite', state, [
    { op: 'repaintLynxSelection', oldCursor: 1, oldCol: 8 },
  ]);
  // The cursor was on the link inside line 1 and moved to the link inside
  // line 0; both lines carry a fragment of block 1, so both are repainted,
  // each with its own fragment marked.
  assert.deepEqual(results[0].writes, [
    ...row(5, 'Before \x1b[7mone\x1b[0m after'),
    ...row(6, 'Second \x1b[7mtwo\x1b[0m'),
  ]);
});

// ---------------------------------------------------------------------------
// Wrapping, page scrolling, and the redraw a resize owes the reader.
// ---------------------------------------------------------------------------

function blockOf(text, extra = {}) {
  return { item: { role: 'text', name: text }, text, ...extra };
}

test('long prose wraps, and the wrap remembers which block it came from', { skip: needsCrystal }, () => {
  const words = 'word '.repeat(30).trim();
  const { results, state } = both('wrap', stateFor({
    lines: [],
    core: { source: 'ax', blocks: [blockOf(words), blockOf('Second')] },
    cursor: 0,
  }), [{ op: 'relayout' }]);
  const lines = results[0].value;
  assert.ok(lines.length >= 3, 'the prose did not wrap');
  assert.equal(lines.slice(0, -1).every((line) => line.blockIndex === 0), true,
    'every wrapped row names the block it came from');
  assert.equal(lines.at(-1).blockIndex, 1, 'the second block keeps its own index');
  assert.deepEqual(lines.map((line) => line.continuation), [false, true, false],
    'only the first row of a block leads it');
  assert.equal(state.atCalls.at(-1), 0, 'the core was told where the reader is');
});

test('an escaped page wraps its escaped text while Core keeps the original', { skip: needsCrystal }, () => {
  const { results } = both('escaped wrap', stateFor({
    escapeUnicode: true,
    lines: [],
    core: { source: 'ax', blocks: [blockOf('中文 😀')] },
  }), [{ op: 'relayout' }]);
  assert.deepEqual(results[0].value.map((line) => line.text), ['\\u4E2D\\u6587 \\U0001F600']);
});

test('the Lynx display wraps with its numbering outside the span', { skip: needsCrystal }, () => {
  const { results } = both('lynx wrap', stateFor({
    interface: 'lynx',
    keys: { profile: 'lynx', preferences: { numberLinks: true } },
    lines: [],
    core: { source: 'ax', blocks: [
      { item: { role: 'link', name: 'one', href: 'https://example.test/' }, text: 'one' },
      { item: { role: 'link', name: 'two', href: 'https://example.test/2' }, text: 'two' },
    ] },
  }), [{ op: 'relayout' }]);
  const lines = results[0].value;
  assert.deepEqual(lines.map((line) => line.displayPrefix), ['[1]', '[2]'],
    'each link is numbered in its own margin');
  // A whole-line link is its own span; the number is the block's own, not
  // the margin text.
  assert.deepEqual(lines.map((line) => line.displayNumber), [1, 2]);
});

test('a screen at a time moves the reader and repaints what moved', { skip: needsCrystal }, () => {
  const lines = pageRows(40);
  const blocks = lines.map((_, i) => ({ item: { role: 'text', name: `line ${i}` } }));
  const { results, state } = both('page down', stateFor({
    lines, cursor: 5, scroll: 5, core: { source: 'ax', blocks },
  }), [{ op: 'moveScreen', direction: 1 }]);
  assert.equal(state.cursor, 22, 'a screen is the viewport less the overlap row');
  assert.equal(state.scroll, 22);
  assert.deepEqual(state.atCalls, [22]);
  assert.equal(results[0].writes[0], '\x1b[24;1H', 'the status row was drawn first');
  assert.equal(results[0].writes.filter((write) => write.startsWith('\x1b[')).length > 20,
    true, 'the moved rows were written');
  assert.match(results[0].writes.at(-1), /^\x1b\[\d+;\d+H$/);

  const top = both('page up at top', stateFor({ lines, cursor: 0, scroll: 0 }), [
    { op: 'moveScreen', direction: -1 },
  ]);
  assert.deepEqual(top.results[0].writes, [], 'at the top there is nothing to move');
});

test('a view switch keeps the reader on the same screen row', { skip: needsCrystal }, () => {
  const lines = pageRows(40);
  const { state } = both('preserve row', stateFor({
    lines, cursor: 15, scroll: 15,
  }), [{ op: 'preserveViewportRow', row: 0 }]);
  assert.equal(state.scroll, 15, 'the item the reader is on stays where it was on screen');
});

test('a resize relayouts, clears, and paints everything again', { skip: needsCrystal }, () => {
  const long = 'word '.repeat(30).trim();
  const { results, state } = both('resize', stateFor({
    lines: [], title: 'Example Domain',
    core: { source: 'ax', blocks: [blockOf(long), blockOf('Second')] },
  }), [{ op: 'redrawAfterResize' }]);
  assert.equal(results[0].writes[0], '\x1b[2J', 'the screen was cleared before repainting');
  const joined = results[0].writes.join('');
  assert.ok(joined.includes('\x1b[1;1H'), 'the title row was written again');
  assert.ok(joined.includes('Example Domain'), 'the title survived the resize');
  assert.ok(joined.includes('\x1b[2;1H'), 'the address row was written again');
  assert.ok(state.lines.length >= 3, 'the buffer was relaid out to the width');
});
