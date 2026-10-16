'use strict';

// An open popup is a mode of its own, and the reader-level refresh every
// page-touching keystroke ends in: both differenced between the JavaScript
// original and the Crystal port.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/page.html';

const POPUP_BLOCKS = [
  { text: '[*Account]', item: { name: 'Account', controls: 'menu' } },
  { text: 'page text', item: { name: 'page text', role: 'text' } },
  { text: '[*Profile]', item: { name: 'Profile', popup: 'menu' } },
];

function stateFor(overrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 2, col: 0, scroll: 0, title: 'Example',
    lines: [
      { text: '[*Account]', blockIndex: 0 },
      { text: 'page text', blockIndex: 1 },
      { text: '[*Profile]', blockIndex: 2 },
    ],
    core: {
      source: 'ax', blocks: POPUP_BLOCKS,
      popup: { controls: 'menu' }, popupAt: 0,
    },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

async function runBoth(name, state, actions, title = '') {
  const spec = { state: JSON.parse(JSON.stringify(state)), actions,
    page: { url: PAGE_URL, title } };
  const results = [];
  for (const implementation of implementations) {
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

function runSync(name, state, actions) {
  const spec = { state: JSON.parse(JSON.stringify(state)), actions, page: { url: PAGE_URL } };
  const results = implementations.map((implementation) => implementation.draw(spec));
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('the popup keys close it, and only Ctrl+C gets out of the program', { skip: needsCrystal }, () => {
  const cases = [
    [{ action: 'close-popup', chunk: '\x1b', contextAction: null, escape: false }, 'close'],
    [{ action: null, chunk: '\x1b[D', contextAction: 'cancel', escape: false }, 'close'],
    [{ action: 'quit', chunk: 'q', contextAction: null, escape: false }, 'close'],
    [{ action: 'quit', chunk: '\x03', contextAction: null, escape: false }, 'quit'],
    [{ action: 'next-line', chunk: 'j', contextAction: 'next', escape: false }, null],
    [{ action: null, chunk: 'x', contextAction: null, escape: false }, null],
    [{ action: null, chunk: '\x1b', contextAction: null, escape: true }, 'close'],
  ];
  for (const [given, expected] of cases) {
    const result = runSync(`popup key ${JSON.stringify(given)}`, stateFor(), [
      { op: 'popupKey', ...given },
    ]);
    assert.equal(result.results[0].value, expected, JSON.stringify(given));
  }
});

test('a popup is open only while the core remembers it and its entries stand', { skip: needsCrystal }, () => {
  const open = runSync('open', stateFor(), [{ op: 'popupIsOpen' }]);
  assert.equal(open.results[0].value, true);
  const forgotten = runSync('forgotten', stateFor({
    core: { source: 'ax', blocks: POPUP_BLOCKS, popup: null, popupAt: -1 },
  }), [{ op: 'popupIsOpen' }]);
  assert.equal(forgotten.results[0].value, false);
});

test('closing a popup activates the control that opened it and says so', { skip: needsCrystal }, async () => {
  const state = stateFor();
  const result = await runBoth('close the popup', state, [
    { op: 'closePopup' },
  ]);
  assert.equal(result.state.popup, null);
  assert.equal(result.state.statusMsg, 'Closed "Account".');
});

test('closing a popup whose control is gone still rebuilds', { skip: needsCrystal }, async () => {
  const state = stateFor();
  state.core.blocks = [{ text: 'page text', item: { name: 'page text', role: 'text' } }];
  state.core.rescanBlocks = [{ text: 'page text', item: { name: 'page text', role: 'text' } }];
  const result = await runBoth('control gone', state, [{ op: 'closePopup' }]);
  assert.equal(result.state.popup, null);
});

test('a popup move lands the reader on the control that opened it', { skip: needsCrystal }, () => {
  const state = stateFor();
  const result = runSync('move to popup', state, [
    { op: 'moveToPopup', item: { name: 'Account', controls: 'menu' } },
  ]);
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.statusMsg, '"Account" opened — q or Esc closes it.');
});

test('refresh rescans, reads the title, and records the visit', { skip: needsCrystal }, async () => {
  const state = stateFor();
  state.core.blocks = [{ text: 'before', item: { role: 'text' } }];
  state.core.rescanBlocks = [
    { text: 'first paragraph of the new page', item: { role: 'text' } },
    { text: 'second', item: { role: 'text' } },
  ];
  state.core.rescanCost = 42;
  state.core.live = { enabled: true, dirty: false, snapshotCostMs: 0 };
  const result = await runBoth('refresh', state, [
    { op: 'refresh' },
  ], 'Example  page ');
  assert.equal(result.state.title, 'Example page', 'the title was flattened from the page');
  assert.deepEqual(result.state.pageLog, [{ url: PAGE_URL, title: 'Example page' }]);
  assert.deepEqual(result.state.live, { enabled: true, dirty: false, snapshotCostMs: 42 });
  assert.equal(result.state.lines[0].text, 'first paragraph of the new page');
});

test('refresh keeps the reader on their block through an anchor', { skip: needsCrystal }, async () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ text: `line ${i}`, item: { role: 'text' } }));
  const state = stateFor({ lines, core: { blocks } });
  state.cursor = 9;
  state.core.rescanBlocks = blocks;
  state.core.restoreBlock = 10;
  const result = await runBoth('anchored refresh', state, [
    { op: 'refresh', anchor: { block: 9, name: 'line 9' } },
  ]);
  assert.equal(result.state.cursor, 10);
});

test('a refresh that resets the cursor starts from the top', { skip: needsCrystal }, async () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ text: `line ${i}`, blockIndex: i }));
  const blocks = lines.map((_, i) => ({ text: `line ${i}`, item: { role: 'text' } }));
  const state = stateFor({ lines, cursor: 9, core: { blocks } });
  state.core.rescanBlocks = blocks;
  const result = await runBoth('reset refresh', state, [
    { op: 'refresh', resetCursor: true },
  ]);
  assert.equal(result.state.cursor, 0);
  assert.equal(result.state.scroll, 0);
});

test('a resetting Lynx refresh starts on the first control, not the first row',
  { skip: needsCrystal }, async () => {
    const blocks = [
      { text: 'Page heading', item: { role: 'heading', name: 'Page heading' } },
      { text: 'Introduction', item: { role: 'text', name: 'Introduction' } },
      { text: 'Contact', item: { role: 'link', name: 'Contact', href: 'mailto:hello@example.test' } },
      { text: 'Cart', item: { role: 'button', name: 'Cart' } },
    ];
    const state = stateFor({
      interface: 'lynx', cursor: 3,
      keys: { profile: 'lynx', preferences: { numberLinks: true, numberFields: true } },
      core: { blocks },
    });
    state.core.rescanBlocks = blocks;
    const result = await runBoth('Lynx reset refresh', state, [
      { op: 'refresh', resetCursor: true },
    ]);
    assert.equal(result.state.lines[result.state.cursor].text, 'Contact');
    assert.equal(result.state.col, 0);
    assert.equal(result.state.scroll, 0);
  });
