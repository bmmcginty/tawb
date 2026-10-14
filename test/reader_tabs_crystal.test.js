'use strict';

// The interactive reader's tab commands, differenced against the original
// front end. A switch must replace the document and all later keys must use
// the newly current page.

const test = require('node:test');
const assert = require('node:assert');
const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const tabs = [
  { url: 'https://one.test/', title: ' One   page ',
    blocks: [{ text: 'one', item: { role: 'text' } }] },
  { url: 'https://two.test/', title: 'Two page',
    blocks: [{ text: 'two', item: { role: 'text' } }] },
];

function state(overrides = {}, coreOverrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 0, col: 0, scroll: 0, title: 'One page',
    lines: [{ text: 'one', blockIndex: 0 }], statusMsg: '', drawn: {},
    linkAddress: false,
    core: {
      source: 'ax', blocks: tabs[0].blocks, tabs, currentTab: 0,
      popup: null, popupAt: -1,
      live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 },
      ...coreOverrides,
    },
    ...overrides,
  };
}

async function runBoth(name, initial, actions) {
  const results = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state: initial, actions }));
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('next and previous tab replace the document', { skip: needsCrystal }, async () => {
  const result = await runBoth('cycle tabs', state(), [
    { op: 'browseKey', chunk: '>' },
    { op: 'browseKey', chunk: '<' },
  ]);
  assert.equal(result.state.title, 'One page');
  assert.equal(result.state.lines[0].text, 'one');
  assert.equal(result.state.statusMsg, 'Tab 1 of 2: One page');
});

test('a key after switching acts on the new tab', { skip: needsCrystal }, async () => {
  const result = await runBoth('new current page', state(), [
    { op: 'browseKey', chunk: '>' },
    { op: 'browseKey', chunk: '\x0c' },
  ]);
  assert.equal(result.state.address.text, 'https://two.test/');
});

test('cycling a one-tab browser says why it stayed put', { skip: needsCrystal }, async () => {
  const result = await runBoth('one tab', state({}, { tabs: [tabs[0]] }), [
    { op: 'browseKey', chunk: '>' },
  ]);
  assert.equal(result.state.statusMsg, 'Only one tab open.');
});

test('Lynx main menu returns to the session home without reloading it',
  { skip: needsCrystal }, async () => {
    const keys = { profile: 'lynx', bindings: { 'main-menu': ['m'] } };
    const returned = await runBoth('return home', state({
      interface: 'lynx', keys, homeUrl: 'https://home.test/',
    }), [{ op: 'browseKey', chunk: 'm' }]);
    assert.equal(returned.state.statusMsg, 'Loaded https://home.test/');

    const already = await runBoth('already home', state({
      interface: 'lynx', keys, homeUrl: 'https://one.test/',
    }), [{ op: 'browseKey', chunk: 'm' }]);
    assert.equal(already.state.statusMsg, 'You are already at the main screen.');
  });

test('new tab opens an empty address bar', { skip: needsCrystal }, async () => {
  const opened = await runBoth('new tab', state(), [
    { op: 'browseKey', chunk: '\x14' },
  ]);
  assert.equal(opened.state.mode, 'address');
  assert.equal(opened.state.address.text, '');
  assert.equal(opened.state.statusMsg, 'Opened a new tab — tab 3 of 3: about:blank');

  const refused = await runBoth('new tab refused', state({}, {
    newTabFault: 'the browser refused',
  }), [{ op: 'browseKey', chunk: '\x14' }]);
  assert.equal(refused.state.statusMsg,
    'Could not open a new tab: the browser refused');
});

test('close tab walks forward and preserves a refused tab', { skip: needsCrystal }, async () => {
  const keys = { bindings: { 'close-tab': ['x'] } };
  const closed = await runBoth('closed', state({ keys }), [
    { op: 'browseKey', chunk: 'x' },
  ]);
  assert.equal(closed.state.lines[0].text, 'two');
  assert.equal(closed.state.statusMsg, 'Closed "One page" — tab 1 of 1: Two page');

  const refused = await runBoth('close refused', state({ keys }, {
    closeTabFault: 'the tab is busy',
  }), [{ op: 'browseKey', chunk: 'x' }]);
  assert.equal(refused.state.statusMsg, 'Could not close this tab: the tab is busy');

  const only = await runBoth('only tab', state({ keys }, { tabs: [tabs[0]] }), [
    { op: 'browseKey', chunk: 'x' },
  ]);
  assert.equal(only.state.statusMsg,
    'This is the only tab open — press q to quit.');
});
