'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  acknowledgeHistoryNavigation, rememberHistoryPlace, restoreHistoryPlace,
} = require('../src/index');

function stateAt(cursor, col, scroll) {
  return {
    cursor, col, scroll,
    lines: Array.from({ length: 30 }, (_, index) => ({ text: `line ${index} has enough text` })),
    historyPlaces: new WeakMap(),
  };
}

test('each history entry restores the cursor and scroll position it was left at', () => {
  const page = { url: () => 'https://example.test/same-address' };
  const state = stateAt(8, 5, 4);
  rememberHistoryPlace(state, page, 'entry:first');

  state.cursor = 20;
  state.col = 3;
  state.scroll = 15;
  rememberHistoryPlace(state, page, 'entry:second');

  state.cursor = 0;
  state.col = 0;
  state.scroll = 0;
  assert.equal(restoreHistoryPlace(state, page, 'entry:first'), true);
  assert.deepEqual(
    { cursor: state.cursor, col: state.col, scroll: state.scroll },
    { cursor: 8, col: 5, scroll: 4 },
  );
});

test('a restored history page cannot be mistaken for a later new navigation', () => {
  const page = { url: () => 'https://example.test/restored' };
  const state = {
    core: { live: { href: 'https://example.test/page-left', navigated: true } },
  };
  acknowledgeHistoryNavigation(state, page);
  assert.equal(state.core.live.href, page.url());
  assert.equal(state.core.live.navigated, false);
});

test('url identity restores history position when entry keys are unavailable', () => {
  const page = { url: () => 'https://example.test/article' };
  const state = stateAt(12, 7, 9);
  rememberHistoryPlace(state, page);

  state.cursor = 0;
  state.col = 0;
  state.scroll = 0;
  assert.equal(restoreHistoryPlace(state, page), true);
  assert.deepEqual(
    { cursor: state.cursor, col: state.col, scroll: state.scroll },
    { cursor: 12, col: 7, scroll: 9 },
  );
});
