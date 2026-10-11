'use strict';

// Lynx's number prompt and the address bar, differenced between the
// JavaScript original and the Crystal port — including the navigation the
// address bar starts, which runs while the reader keeps typing.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/page.html';

function numberedState(numbered, extras = [], overrides = {}) {
  const blocks = numbered.concat(extras).map((entry, index) => ({
    text: entry.text,
    item: entry.item ?? { role: 'text' },
  }));
  const lines = numbered.concat(extras).map((entry, index) => ({
    text: entry.text,
    blockIndex: index,
    displayNumber: entry.number ?? null,
  }));
  return {
    rows: 10, cols: 80, mode: 'browse', interface: 'default',
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines,
    core: { source: 'ax', blocks, popup: null, popupAt: -1 },
    driver: { name: 'firefox' },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

function plainState(overrides = {}, coreOverrides = {}) {
  const blocks = [
    { text: 'first', item: { role: 'text' } },
    { text: 'second', item: { role: 'text' } },
    { text: 'third', item: { role: 'text' } },
  ];
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines: blocks.map((block, index) => ({ text: block.text, blockIndex: index })),
    core: { source: 'ax', blocks, popup: null, popupAt: -1, ...coreOverrides },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

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

test('the number prompt numbers what is on screen', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
  ]);
  const result = await runBoth('open', state, [
    { op: 'openNumberPrompt' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'number');
  assert.equal(result.state.linkNumber.text, '');
  assert.deepEqual(result.state.linkNumber.targets, [
    { number: 1, line: 0, col: 0 },
    { number: 2, line: 1, col: 0 },
  ]);
  assert.ok(result.results[0].writes.join('').includes('Follow link (or goto link or page) number: '));
});

test('a link number with g moves and says so', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
  ]);
  const result = await runBoth('move', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '2' },
    { op: 'numberKey', chunk: 'g' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.statusMsg, 'Link 2.');
  assert.deepEqual(result.state.activated, [], 'g moves without pressing');
});

test('a link number on its own follows the link', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
  ]);
  const result = await runBoth('follow', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '1' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 0);
  assert.deepEqual(result.state.activated, [
    { role: 'link', name: 'First', href: '/first' },
  ]);
  assert.equal(result.state.statusMsg, 'Activated: First — no visible change.');
});

test('a number on a non-link moves without activating', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: 'plain', number: 2 },
  ]);
  const result = await runBoth('plain', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '2' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.statusMsg, 'Link 2.');
});

test('a relative number steps from the numbered item the reader is on', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
    { text: '[Third]', number: 3, item: { role: 'link', name: 'Third', href: '/third' } },
  ]);
  const back = await runBoth('backward', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '1' },
    { op: 'numberKey', chunk: '-' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(back.state.statusMsg, 'Activated: First — no visible change.');
  assert.equal(back.state.cursor, 0);
  const forward = await runBoth('forward', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '1' },
    { op: 'numberKey', chunk: '+' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(forward.state.statusMsg, 'Activated: Third — no visible change.');
  assert.equal(forward.state.cursor, 2);
});

test('a page number lands at the top of the page asked for', { skip: needsCrystal }, async () => {
  const numbered = Array.from({ length: 12 }, (_, index) => ({
    text: `line ${index}`,
    number: null,
  }));
  const state = numberedState(numbered);
  const result = await runBoth('page', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '2' },
    { op: 'numberKey', chunk: 'p' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 4, 'the first line of the second screen');
  assert.equal(result.state.statusMsg, 'Page 2 of 3.');
});

test('escape cancels, backspace edits, and a refused number is said', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
  ]);
  const cancelled = await runBoth('cancelled', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '2' },
    { op: 'numberKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(cancelled.state.mode, 'browse');
  assert.equal(cancelled.state.statusMsg, 'Cancelled.');
  assert.equal(cancelled.state.linkNumber, null);
  const edited = await runBoth('edited', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '1' },
    { op: 'numberKey', chunk: '\x7f' },
    { op: 'numberKey', chunk: '2' },
  ], { url: PAGE_URL });
  assert.equal(edited.state.linkNumber.text, '2');
  const refused = await runBoth('refused', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '9' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(refused.state.statusMsg, 'No link 9 on this page.');
  const invalid = await runBoth('invalid', state, [
    { op: 'openNumberPrompt' },
    { op: 'numberKey', chunk: '+' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(invalid.state.statusMsg, 'Invalid link number: +.');
});

test('prefilled digits survive the opening keystroke', { skip: needsCrystal }, async () => {
  const state = numberedState([
    { text: '[First]', number: 1, item: { role: 'link', name: 'First', href: '/first' } },
    { text: '[Second]', number: 2, item: { role: 'link', name: 'Second', href: '/second' } },
  ]);
  const result = await runBoth('prefilled', state, [
    { op: 'openNumberPrompt', digits: '2' },
    { op: 'numberKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.cursor, 1);
  assert.equal(result.state.statusMsg, 'Activated: Second — no visible change.');
});

test('the address bar opens on the page\'s own address', { skip: needsCrystal }, async () => {
  const state = plainState();
  const result = await runBoth('focus', state, [
    { op: 'focusAddress' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'address');
  assert.deepEqual(result.state.address, {
    text: PAGE_URL, caret: PAGE_URL.length, scroll: 0,
  });
});

test('escape leaves the address bar without going anywhere', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://x/', caret: 11, scroll: 0 } });
  const result = await runBoth('escape', state, [
    { op: 'addressKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.ok(result.results[0].writes.join('').includes(PAGE_URL),
    'the address row says where we still are');
});

test('an empty address bar closes without navigating', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: '', caret: 0, scroll: 0 } });
  const result = await runBoth('empty', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, '');
});

test('an address goes where it says', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://other.test/here', caret: 23, scroll: 0 } }, {
    rescanBlocks: [{ text: 'the other page', item: { role: 'text' } }],
  });
  const result = await runBoth('navigate', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL, title: 'Other' });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.address.text, 'https://other.test/here');
  assert.equal(result.state.statusMsg, 'Loaded https://other.test/here');
  assert.equal(result.state.lines[0].text, 'the other page');
  assert.equal(result.state.cursor, 0, 'a new page starts at the top');
});

test('a host name with a scheme missing is completed, not searched', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'example.test', caret: 12, scroll: 0 } }, {
    rescanBlocks: [{ text: 'example page', item: { role: 'text' } }],
  });
  const result = await runBoth('host', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Loaded https://example.test');
});

test('words are searched, and the search is said', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'crystal reports', caret: 15, scroll: 0 } }, {
    rescanBlocks: [{ text: 'search results', item: { role: 'text' } }],
  });
  const result = await runBoth('search', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL, title: 'Search' });
  assert.equal(result.state.statusMsg,
    'Loaded https://duckduckgo.com/?q=crystal%20reports');
});

test('credentials in an address are taken out and not searched on', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://bob:secret@example.test/secret', caret: 38, scroll: 0 } }, {
    rescanBlocks: [{ text: 'the secret page', item: { role: 'text' } }],
  });
  const result = await runBoth('credentials', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Loaded https://example.test/secret');
});

test('a refused address is classified and the warning page is read', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://gone.test/', caret: 18, scroll: 0 } }, {
    rescanBlocks: [{ text: 'the warning page', item: { role: 'text' } }],
  });
  const result = await runBoth('refused', state, [
    { op: 'addressKey', chunk: '\r' },
  ], { url: PAGE_URL, gotoFault: 'net::ERR_NAME_NOT_RESOLVED' });
  assert.equal(result.state.statusMsg,
    'https://gone.test/ was refused — ERR_NAME_NOT_RESOLVED. The browser\'s own warning is on screen.');
  assert.equal(result.state.lines[0].text, 'the warning page');
});

test('escape stops a load that is still running', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://slow.test/', caret: 18, scroll: 0 } }, {});
  const result = await runBoth('interrupt', state, [
    { op: 'addressKey', chunk: '\r', keys: ['\x1b'] },
  ], { url: PAGE_URL, gotoHang: true });
  assert.equal(result.state.statusMsg, 'Stopped loading https://slow.test/.');
  assert.equal(result.state.mode, 'browse');
});

test('the address bar edits like a line editor', { skip: needsCrystal }, async () => {
  const state = plainState({ mode: 'address', address: { text: 'https://example.test/pag', caret: 24, scroll: 0 } });
  const result = await runBoth('edit', state, [
    { op: 'addressKey', chunk: 'e' },
    { op: 'addressKey', chunk: '\x7f' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.address, {
    text: 'https://example.test/pag', caret: 24, scroll: 0,
  }, 'the backspace took the e back off');
});
