'use strict';

// Activation, field-typing entry, and the chooser/file/slider paths,
// differenced between the JavaScript original and the Crystal port: what
// Enter does depends on what is under the cursor, and every one of those
// paths has to land the reader in the same mode, on the same line, with the
// same words on the status row.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/page.html';

// One line per block, so a block index is a line index and the item under
// the cursor is the line's own.
function linesFor(blocks) {
  return blocks.map((block, index) => ({ text: block.text, blockIndex: index }));
}

function stateFor(blocks, overrides = {}, coreOverrides = {}) {
  const core = {
    source: 'ax', blocks, popup: null, popupAt: -1,
    ...coreOverrides,
  };
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines: linesFor(blocks),
    core,
    driver: { name: 'firefox' },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

// The scripted core's block list is mutated in place by the chooser's
// splice, so every implementation runs against its own copy of the whole
// scenario — otherwise the first run's residue would be the second run's
// starting point.
async function runBoth(name, state, actions, page = {}) {
  const results = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state, actions, page }));
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('activation refuses politely where there is nothing to activate', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'plain text', item: { role: 'text', name: 'plain text' } },
    { text: 'more text', item: { role: 'text', name: 'more text' } },
    { text: 'third line', item: { role: 'text', name: 'third line' } },
  ];
  const result = await runBoth('text under the cursor', stateFor(blocks), [
    { op: 'activate' },
  ]);
  assert.equal(result.state.statusMsg, 'Nothing to activate on this line.');
  assert.equal(result.state.mode, 'browse');
  assert.deepEqual(result.state.attachments, []);
});

test('a button press reports what the page said, and what it changed', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Save]', item: { role: 'button', name: 'Save' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('button with a status', stateFor(blocks, {}, {
    activatedStatus: { status: 'Saved.' },
    changes: [{ block: 0, size: 1 }],
  }), [{ op: 'activate' }], { url: PAGE_URL, title: 'Example' });
  assert.equal(result.state.statusMsg, 'Saved. — 1 area changed, press c to jump.');
  assert.deepEqual(result.state.activated, [{ role: 'button', name: 'Save' }]);
});

test('an activation the page says nothing about is still said', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Press]', item: { role: 'button', name: 'Press' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('plain activation', stateFor(blocks), [
    { op: 'activate' },
  ]);
  assert.equal(result.state.statusMsg, 'Activated: Press — no visible change.');
});

test('a control that opens something takes the reader to it', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'page text', item: { role: 'text' } },
    { text: '[*Account]', item: { name: 'Account', controls: 'menu' } },
    { text: 'more text', item: { role: 'text' } },
  ];
  const result = await runBoth('activation opens a menu', stateFor(blocks, {}, {
    popupAt: 2,
  }), [{ op: 'activate' }], { url: PAGE_URL, title: 'Example' });
  assert.deepEqual(result.state.popup, { controls: 'menu' });
  assert.equal(result.state.cursor, 2, 'the reader is moved to where the popup starts');
  assert.equal(result.state.statusMsg, '"Account" opened — q or Esc closes it.');
});

test('a failed activation is an error with the page\'s own words', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Broken]', item: { role: 'button', name: 'Broken' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('error', stateFor(blocks, {}, {
    activationFailure: { message: 'element is not attached\ndetails follow' },
  }), [{ op: 'activate' }], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Error activating "Broken": element is not attached');
  assert.equal(result.state.mode, 'browse');
});

test('a timed-out activation says how long was given', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Slow]', item: { role: 'button', name: 'Slow' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('timeout', stateFor(blocks, {}, {
    activationFailure: { timeout: true },
    watchFocus: true,
  }), [{ op: 'activate' }], { url: PAGE_URL });
  assert.equal(result.state.statusMsg,
    'Gave up activating "Slow" after 6s — it may be inside a bot check or an unreachable frame.');
});

test('a slider press hands the arrow keys to the control', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Volume 40%]', item: { role: 'slider', name: 'Volume' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('slider', stateFor(blocks), [
    { op: 'activate' },
  ]);
  assert.equal(result.state.mode, 'control');
  assert.deepEqual(result.state.controlling, { item: { role: 'slider', name: 'Volume' } });
  assert.equal(result.state.statusMsg,
    'Controlling "Volume" — use arrows, Home or End; Esc to stop.');
});

test('a slider the browser cannot focus is an error, not silence', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Volume]', item: { role: 'slider', name: 'Volume' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('unfocusable slider', stateFor(blocks, {}, {
    focusOk: false,
  }), [{ op: 'activate' }], { url: PAGE_URL });
  assert.equal(result.state.statusMsg,
    'Error activating "Volume": the browser could not focus that control');
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.controlling, null);
});

test('a file input with no path prompt answered attaches nothing', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[Photo]', item: { role: 'button', name: 'Photo', file: { accept: 'image/*' } } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('file input, no keyboard', stateFor(blocks), [
    { op: 'activate' },
  ]);
  assert.equal(result.state.statusMsg, 'Nothing attached to "Photo".');
  assert.deepEqual(result.state.attachments, []);
});

test('following a fragment link moves to the text it points at', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Skip to content', item: { role: 'link', name: 'Skip to content', href: '#main' } },
    { text: 'header', item: { role: 'text' } },
    { text: 'Welcome to the main content', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, { cursor: 0 }, { fragment: 'main', fragmentBlock: 2 });
  const result = await runBoth('fragment link', state, [
    { op: 'activate' },
  ], { url: PAGE_URL, title: 'Example' });
  assert.equal(result.state.cursor, 2);
  assert.equal(result.state.statusMsg, 'Moved to main.');
  assert.deepEqual(result.state.visitedLinks, [
    { name: 'Skip to content', href: '#main' },
  ], 'the link was noted for VLINKS');
});

test('a fragment the view does not hold is said, not guessed at', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Skip to content', item: { role: 'link', name: 'Skip to content', href: '#missing' } },
    { text: 'header', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, { cursor: 0 }, { fragment: 'missing', fragmentBlock: -1 });
  const result = await runBoth('missing fragment', state, [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.statusMsg,
    '"Skip to content" points at missing, which is not in this view.');
});

test('focus a page moved is followed onto its own line', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Skip to banking', item: { role: 'link', name: 'Skip to banking', href: '#banking' } },
    { text: 'header', item: { role: 'text' } },
    { text: '[Accounts]', item: { role: 'link', name: 'Accounts', href: '/accounts' } },
  ];
  const state = stateFor(blocks, { cursor: 0 }, {
    fragment: 'banking', watchFocus: true, focusFound: true, focusBlock: 2,
  });
  const result = await runBoth('focus followed', state, [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 2);
  assert.equal(result.state.statusMsg, 'Focus moved to "Accounts".');
});

test('focus that landed somewhere this view does not show is not followed', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Skip to banking', item: { role: 'link', name: 'Skip to banking', href: '#banking' } },
    { text: 'header', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, { cursor: 0 }, {
    fragment: 'banking', watchFocus: true, focusFound: true, focusBlock: -1,
  });
  const result = await runBoth('focus not in view', state, [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.statusMsg,
    '"Skip to banking" points at banking, which is not in this view.');
});

test('entering an editable field reads what is already in it', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[Search]', item: { role: 'searchbox', name: 'Search' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('typing entry', stateFor(blocks, {}, {
    field: { text: 'hello', caret: 5, native: true },
  }), [{ op: 'activate' }], { url: PAGE_URL });
  assert.equal(result.state.mode, 'type');
  assert.deepEqual(result.state.typing, { text: 'hello', caret: 5 });
  assert.ok(result.state.drawn.hint.startsWith('Typing —'),
    'the hint names the typing mode');
});

test('entering a field the browser refuses leaves the mode alone', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[Search]', item: { role: 'searchbox', name: 'Search' } },
  ];
  const result = await runBoth('refused field', stateFor(blocks, {}, {
    field: null,
  }), [{ op: 'activate' }], { url: PAGE_URL });
  // A field the browser refuses to make editable falls through to
  // ordinary activation, which is the only thing left that pressing it
  // could mean.
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.typing, null);
  assert.equal(result.state.statusMsg, 'Activated: Search — no visible change.');
  assert.deepEqual(result.state.activated, [{ role: 'searchbox', name: 'Search' }]);
});

test('a combobox that is really a pressed widget is activated, not typed into', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[*Pick one]', item: { role: 'combobox', name: 'Pick one' } },
    { text: 'after', item: { role: 'text' } },
  ];
  const result = await runBoth('select-only combobox', stateFor(blocks), [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'Activated: Pick one — no visible change.');
});

test('a native select opens the chooser on its own entries', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
    { text: 'footer', item: { role: 'text' } },
  ];
  const listing = {
    multiple: false,
    options: [
      { text: 'North', selected: true, disabled: false },
      { text: 'South', selected: false, disabled: false },
      { text: 'Unavailable', selected: false, disabled: true },
    ],
  };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('chooser opens', state, [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'choose');
  assert.equal(result.state.chooserMode.item.name, 'Region');
  assert.equal(result.state.chooserMode.from, 1);
  assert.equal(result.state.chooser.count, 3);
  assert.deepEqual(result.state.chooser.shown, [0, 1, 2]);
  assert.equal(result.state.live.refreshing, true, 'live rebuilds are held mid-choice');
  assert.equal(result.state.lines[2].text, '(*) North');
  assert.equal(result.state.lines[4].text, '( ) Unavailable — unavailable');
  assert.equal(result.state.cursor, 2, 'the reader lands on the chosen entry');
  assert.equal(result.state.statusMsg,
    '3 choices for "Region" — type to filter, Enter to choose, Esc to cancel.');
});

test('a chooser in a table row lands after the whole row', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'row cell one', item: { role: 'text' } },
    { text: 'row cell two', item: { role: 'combobox', name: 'Row select' } },
  ];
  const listing = { multiple: false, options: [{ text: 'A' }, { text: 'B' }] };
  const state = stateFor(blocks, { cursor: 1, col: 26 }, { listing });
  state.lines[1] = {
    text: 'row cell one row cell two [*Row select]', blockIndex: 0,
    spans: [
      { start: 0, end: 12, blockIndex: 0 },
      { start: 13, end: 25, blockIndex: 1 },
      { start: 26, end: 40, blockIndex: 1 },
    ],
  };
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('chooser after the row', state, [
    { op: 'activate' },
  ], { url: PAGE_URL });
  assert.equal(result.state.chooserMode.from, 0, 'the row line the control sits on');
  assert.equal(result.state.chooser.at, 2, 'the entries splice in after the control\'s block');
});

test('choosing an entry reports it and releases live rebuilds', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = {
    multiple: false,
    options: [
      { text: 'North', selected: true },
      { text: 'South', selected: false },
    ],
  };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('choose south', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.chooserMode, null);
  assert.equal(result.state.chooserMode, null);
  assert.equal(result.state.live.refreshing, false);
  assert.deepEqual(result.state.activated, [], 'the control itself is never pressed');
  assert.equal(result.state.statusMsg, 'Chose "South".');
});

test('choosing the already-chosen entry is said as such', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'North', selected: true }] };
  const state = stateFor(blocks, { cursor: 1 }, {
    listing, chooseOutcome: { changed: false },
  });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('already chosen', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, '"North" was already chosen.');
});

test('a disabled entry is named and refused', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = {
    multiple: false,
    options: [{ text: 'North', selected: true }, { text: 'Gone', disabled: true }],
  };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('disabled entry', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, '"Gone" is not available.');
  assert.equal(result.state.mode, 'choose');
});

test('enter before reaching a choice asks the reader to move first', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'North', selected: true }] };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('not on a choice', state, [
    { op: 'openChooser', item: blocks[1].item, listing },
    { op: 'moveSelection', cursor: 0 },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Move to a choice first.');
});

test('escape leaves the dropdown exactly as it was', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'North', selected: true }] };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('escape the chooser', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.chooserMode, null);
  assert.equal(result.state.cursor, 1, 'back on the control');
  assert.equal(result.state.statusMsg, 'Left "Region" as it was.');
});

test('a choice that cannot be made closes the list and says why', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'North', selected: true }] };
  const state = stateFor(blocks, { cursor: 1 }, {
    listing, chooseFailure: { message: 'option is gone' },
  });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('failed choice', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'Could not choose "North": option is gone');
});

test('typing filters the dropdown\'s own lines', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = {
    multiple: false,
    options: [
      { text: 'North', selected: true },
      { text: 'South', selected: false },
      { text: 'Northwest', selected: false },
      { text: 'East', selected: false },
    ],
  };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('filter', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: 'n' },
    { op: 'chooseKey', chunk: 'o' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.chooser.shown, [0, 2]);
  assert.deepEqual(result.state.chooser.filter, 'no');
  assert.equal(result.state.lines[2].text, '(*) North');
  assert.equal(result.state.lines[3].text, '( ) Northwest');
  assert.equal(result.state.lines.length, 4, 'the hidden entries are gone from the buffer');
  assert.equal(result.state.cursor, 2);
  assert.equal(result.state.statusMsg, '2 of 4 matching "no".');
});

test('backspace widens the filter again', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'North' }, { text: 'South' }] };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('backspace', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: 's' },
    { op: 'chooseKey', chunk: '\x7f' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.chooser.filter, '');
  assert.equal(result.state.statusMsg, '2 choices.');
});

test('movement inside the dropdown cannot wander out of it', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = {
    multiple: false,
    options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
  };
  const state = stateFor(blocks, { cursor: 1 }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('movement', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooserLines' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 5, 'the last entry is the furthest down it goes');
  assert.deepEqual(result.results[5].value, { first: 2, last: 5 });
});

test('lynx keys move through and out of the chooser', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'Region', item: { role: 'text' } },
    { text: '[*North]', item: { role: 'combobox', name: 'Region' } },
  ];
  const listing = { multiple: false, options: [{ text: 'A' }, { text: 'B' }] };
  const state = stateFor(blocks, { cursor: 1, interface: 'lynx', keys: { profile: 'lynx' } }, { listing });
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('lynx chooser', state, [
    { op: 'activate' },
    { op: 'chooseKey', chunk: '\x1b[B' },
    { op: 'chooseKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Chose "B".');
});

test('the file prompt completes a sole match all the way to the file', { skip: needsCrystal }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-files-'));
  const photo = path.join(directory, 'alpha.txt');
  fs.writeFileSync(photo, 'x'.repeat(4096));
  try {
    const blocks = [
      { text: 'before', item: { role: 'text' } },
      { text: '[Photo]', item: { role: 'button', name: 'Photo', file: { accept: 'image/*' } } },
      { text: 'after', item: { role: 'text' } },
    ];
    const state = stateFor(blocks);
    const result = await runBoth('attach one file', state, [
      { op: 'activate', keys: [...`${directory}/al`, '\t', '\r'] },
    ], { url: PAGE_URL });
    assert.deepEqual(result.state.attachments, [{
      item: blocks[1].item,
      paths: [photo],
    }]);
    assert.equal(result.state.statusMsg, 'Attached alpha.txt (4.0KB) to "Photo".');
    assert.equal(result.state.mode, 'browse');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('several matches complete to their common prefix and say so', { skip: needsCrystal }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-files-'));
  fs.writeFileSync(path.join(directory, 'alpha.txt'), 'a');
  fs.writeFileSync(path.join(directory, 'alphabet.txt'), 'b');
  try {
    const blocks = [
      { text: 'before', item: { role: 'text' } },
      { text: '[Photo]', item: { role: 'button', name: 'Photo', file: {} } },
    ];
    const state = stateFor(blocks);
    const result = await runBoth('common prefix', state, [
      { op: 'completePath', text: `${directory}/al` },
      { op: 'activate', keys: [...`${directory}/alphabet.txt`, '\r'] },
    ], { url: PAGE_URL });
    assert.deepEqual(result.results[0].value, {
      text: `${directory}/alpha`,
      note: `2 match: alpha.txt  alphabet.txt`,
    });
    assert.equal(result.state.statusMsg, 'Attached alphabet.txt (1 bytes) to "Photo".');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a directory completes with its separator and refuses to attach', { skip: needsCrystal }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-files-'));
  fs.mkdirSync(path.join(directory, 'subdir'));
  try {
    const blocks = [
      { text: 'before', item: { role: 'text' } },
      { text: '[Photo]', item: { role: 'button', name: 'Photo', file: {} } },
    ];
    const state = stateFor(blocks);
    const result = await runBoth('directory', state, [
      { op: 'completePath', text: `${directory}/sub` },
      { op: 'askFiles', asking: 'Photo', keys: [...`${directory}/subdir`, '\r', '\x1b'] },
    ], { url: PAGE_URL });
    assert.deepEqual(result.results[0].value, {
      text: `${directory}/subdir/`,
      note: null,
    }, 'a sole directory match completes with its separator');

  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the file prompt holds several files until the reader is done', { skip: needsCrystal }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-files-'));
  const first = path.join(directory, 'one.txt');
  const second = path.join(directory, 'two.txt');
  fs.writeFileSync(first, 'one');
  fs.writeFileSync(second, 'two');
  try {
    const blocks = [
      { text: 'before', item: { role: 'text' } },
      { text: '[Photos]', item: { role: 'button', name: 'Photos', file: { multiple: true } } },
    ];
    const state = stateFor(blocks);
    const result = await runBoth('multiple', state, [
      { op: 'askFiles', asking: 'Photos', multiple: true, keys: [
        ...`${first}`, '\r', ...`${second}`, '\r', '\r',
      ] },
      { op: 'activate', keys: [...`${first}`, '\r', ...`${second}`, '\r', '\r'] },
    ], { url: PAGE_URL });
    assert.deepEqual(result.results[0].value, [
      { path: first, name: 'one.txt', size: 3 },
      { path: second, name: 'two.txt', size: 3 },
    ]);
    assert.deepEqual(result.state.attachments, [{
      item: blocks[1].item,
      paths: [first, second],
    }]);
    assert.equal(result.state.statusMsg,
      'Attached 2 files to "Photos": one.txt, two.txt');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the file prompt can be declined, abandoned, and left empty', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[Photo]', item: { role: 'button', name: 'Photo', file: {} } },
  ];
  const state = stateFor(blocks);
  const declined = await runBoth('declined', state, [
    { op: 'askFiles', asking: 'Photo', keys: ['\x1b'] },
  ], { url: PAGE_URL });
  assert.equal(declined.results[0].value, null);
  const abandoned = await runBoth('abandoned', state, [
    { op: 'askFiles', asking: 'Photo', keys: ['<eof>'] },
  ], { url: PAGE_URL });
  assert.equal(abandoned.results[0].value, null);
  const empty = await runBoth('empty', state, [
    { op: 'askFiles', asking: 'Photo', keys: ['\r'] },
  ], { url: PAGE_URL });
  assert.equal(empty.results[0].value, null);
});

test('a path nobody can find is refused in the prompt\'s own words', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'before', item: { role: 'text' } },
    { text: '[Photo]', item: { role: 'button', name: 'Photo', file: {} } },
  ];
  const state = stateFor(blocks);
  const result = await runBoth('missing file', state, [
    { op: 'fileToAttach', text: '/definitely/not/here.txt' },
    { op: 'askFiles', asking: 'Photo', keys: [...'/definitely/not/here.txt', '\r', '\x1b'] },
  ], { url: PAGE_URL });
  assert.deepEqual(result.results[0].value, {
    error: 'there is no /definitely/not/here.txt',
  });
  assert.equal(result.state.mode, 'browse', 'the final Escape left the prompt');
});

test('a tilde path is expanded against the reader\'s home', { skip: needsCrystal }, async () => {
  const home = os.homedir();
  const result = await runBoth('home path', stateFor([
    { text: 'before', item: { role: 'text' } },
  ]), [
    { op: 'fileToAttach', text: '~/no/such/file' },
    { op: 'fileToAttach', text: '~' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.results[0].value, {
    error: `there is no ${home}/no/such/file`,
  });
  assert.deepEqual(result.results[1].value, {
    error: `${home} is a directory`,
  });
});

test('a navigate-then-report action starts the new page at the top', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'old page', item: { role: 'text' } },
  ];
  const fresh = [{ text: 'brand new page', item: { role: 'text' } }];
  const state = stateFor(blocks, { statusMsg: 'Activated: Follow' }, {
    rescanBlocks: fresh,
  });
  const result = await runBoth('navigated', state, [
    { op: 'reportAfterAction', previousTexts: ['old page'],
      previousUrl: 'https://example.test/other.html', focused: null },
  ], { url: PAGE_URL, title: 'New' });
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.lines[0].text, 'brand new page');
  assert.equal(result.state.statusMsg, 'Activated: Follow');
  assert.equal(result.state.title, 'New');
});

test('reporting after a same-page action keeps the reader where they were', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'first', item: { role: 'text' } },
    { text: '[*Press]', item: { role: 'button', name: 'Press' } },
    { text: 'third', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, { cursor: 1, statusMsg: 'Activated: Press' }, {});
  const result = await runBoth('same page', state, [
    { op: 'reportAfterAction', previousTexts: ['first', '[*Press]', 'third'],
      previousUrl: PAGE_URL, anchor: { block: 1 }, focused: null },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.statusMsg, 'Activated: Press — no visible change.');
});

test('a same-page action stays on the control whose own label changed',
  { skip: needsCrystal }, async () => {
    const blocks = [
      { text: 'first', item: { role: 'text' } },
      { text: '[*Play]', item: { role: 'button', name: 'Play' } },
      { text: 'third', item: { role: 'text' } },
      { text: '[*Embed Player]', item: { role: 'tab', name: 'Embed Player' } },
    ];
    const fresh = [
      { text: 'first', item: { role: 'text' } },
      { text: '[*Pause]', item: { role: 'button', name: 'Pause' } },
      { text: 'third', item: { role: 'text' } },
      { text: '[*Embed Player]', item: { role: 'tab', name: 'Embed Player' } },
    ];
    const state = stateFor(blocks, { cursor: 1, statusMsg: 'Activated: Play' }, {
      rescanBlocks: fresh,
      // The old path searched the whole buffer for the name "Play" and landed
      // on the "Embed Player" tab; the new one keeps the control itself.
      restoreBlock: 3,
      reanchorBlock: 1,
      reanchorExact: true,
      reanchored: { block: 1, exact: true },
    });
    const anchor = {
      text: '[*Play]', name: 'Play', identity: null, block: 1,
      context: ['first', '[*Play]', 'third'], ratio: 0.25,
    };
    const result = await runBoth('changed label', state, [
      { op: 'reportAfterAction', previousTexts: ['first', '[*Play]', 'third', '[*Embed Player]'],
        previousUrl: PAGE_URL, anchor, focused: null },
    ], { url: PAGE_URL });
    assert.equal(result.state.cursor, 1);
    assert.equal(result.state.lines[1].text, '[*Pause]');
  });

test('reporting after a navigation disposes of the watched focus', { skip: needsCrystal }, async () => {
  const blocks = [{ text: 'old page', item: { role: 'text' } }];
  const fresh = [{ text: 'new page', item: { role: 'text' } }];
  const state = stateFor(blocks, { statusMsg: 'Activated: Follow' }, {
    rescanBlocks: fresh,
  });
  const result = await runBoth('navigated with focus', state, [
    { op: 'reportAfterAction', previousTexts: ['old page'],
      previousUrl: 'https://example.test/other.html',
      focused: { found: true } },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Activated: Follow');
});

test('following focus after an action moves onto it and says so', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'first', item: { role: 'text' } },
    { text: '[*Press]', item: { role: 'button', name: 'Press' } },
    { text: '[Dest]', item: { role: 'link', name: 'Dest' } },
  ];
  const state = stateFor(blocks, { cursor: 1, statusMsg: 'Activated: Press' }, {
    focusBlock: 2,
  });
  const result = await runBoth('focus after action', state, [
    { op: 'reportAfterAction', previousTexts: ['first', '[*Press]', '[Dest]'],
      previousUrl: PAGE_URL, anchor: null, focused: { found: true } },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 2);
  assert.equal(result.state.statusMsg, 'Activated: Press — focus moved to "Dest".');
});
