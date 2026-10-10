'use strict';

// Webpage keyboard mode: every other key goes to the page, differenced
// between the JavaScript original and the Crystal port. What lands in the
// page's own keyboard — and under what name — is the whole of the mode.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/video';

function stateFor(overrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'page',
    cursor: 0, col: 0, scroll: 0,
    lines: [{ text: 'page', blockIndex: 0 }],
    core: { source: 'ax', blocks: [], live: { enabled: true, dirty: false, lastPulseMs: 10 } },
    statusMsg: '', drawn: {}, linkAddress: true,
    ...overrides,
  };
}

async function runBoth(name, state, actions, page = {}) {
  const spec = { state: JSON.parse(JSON.stringify(state)), actions,
    page: { url: PAGE_URL, ...page } };
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

test('browse keys are sent to the page under their browser names', { skip: needsCrystal }, async () => {
  const result = await runBoth('keys to the page', stateFor(), [
    { op: 'pageKey', chunk: ' ' },
    { op: 'pageKey', chunk: 'm' },
    { op: 'pageKey', chunk: '\x1b[A' },
    { op: 'pageKey', chunk: '\x0c' },
    { op: 'pageKey', chunk: '\x1bq' },
  ]);
  assert.deepEqual(result.results.map((entry) => entry.value), [
    [' '], ['m'], ['ArrowUp'], ['Control+L'], ['Alt+Q'],
  ]);
  assert.equal(result.state.mode, 'page');
});

test('a key the terminal cannot name is refused with an explanation', { skip: needsCrystal }, async () => {
  const result = await runBoth('unknown key', stateFor(), [
    { op: 'pageKey', chunk: '\x1b[999~' },
  ]);
  assert.deepEqual(result.results[0].value, []);
  assert.equal(result.state.statusMsg, 'That terminal key cannot be sent to the webpage.');
});

test('the same configurable key leaves the mode and defers the rescan', { skip: needsCrystal }, async () => {
  const result = await runBoth('exit chord', stateFor(), [
    { op: 'pageKey', chunk: '\x1bk' },
  ]);
  assert.equal(result.state.mode, 'browse');
  assert.deepEqual(result.state.live, { enabled: true, dirty: true, lastPulseMs: 0 });
  assert.equal(result.state.statusMsg,
    'Webpage keyboard off — the page will rescan when you pause.');
});

test('leaving with live updates off asks for a manual rescan', { skip: needsCrystal }, async () => {
  const result = await runBoth('exit with live off', stateFor({
    core: { source: 'ax', blocks: [], live: { enabled: false, dirty: false, lastPulseMs: 10 } },
  }), [
    { op: 'pageKey', chunk: '\x1bk' },
  ]);
  assert.equal(result.state.statusMsg, 'Webpage keyboard off — press r to rescan.');
});

test('a page that refuses a key press is reported, not crashed into', { skip: needsCrystal }, async () => {
  const result = await runBoth('refused press', stateFor(), [
    { op: 'pageKey', chunk: ' ' },
  ], { failPress: true });
  assert.deepEqual(result.results[0].value, []);
  assert.match(result.state.statusMsg, /^Could not send Space to the webpage: the page refused$/);
});

test('each keystroke marks input', { skip: needsCrystal }, async () => {
  const result = await runBoth('input marked', stateFor(), [
    { op: 'pageKey', chunk: ' ' },
    { op: 'pageKey', chunk: 'm' },
  ]);
  assert.equal(result.state.inputMarks, 2);
});
