'use strict';

// The native list-screen policy, differenced against the shipping reader:
// which keys a typeahead and an explicit filter consume, and the words they
// put on the status row.

const test = require('node:test');
const assert = require('node:assert');
const screen = require('../src/list_screen');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

const edits = [
  [screen.TYPEAHEAD, false, '', 'a', { character: true }],
  [screen.TYPEAHEAD, false, 'a', '\x7f', { backspace: true }],
  [screen.TYPEAHEAD, false, 'a', '\x15', { clear: true }],
  [screen.TYPEAHEAD, false, 'a', '\r', { enter: true }],
  [screen.EXPLICIT, false, '', 'j', { character: true }],
  [screen.EXPLICIT, true, '', 'j', { character: true }],
  [screen.EXPLICIT, true, 'j', '\x7f', { backspace: true }],
  [screen.EXPLICIT, true, 'j', '\r', { enter: true }],
  [screen.EXPLICIT, true, 'j', '\x1b', { escape: true }],
  [screen.EXPLICIT, true, 'j', '\x15', { clear: true }],
];

test('native filter policy matches for every input shape', { skip }, () => {
  for (const [policy, filtering, filter, chunk, flags] of edits) {
    const list = screen.createListState({
      rows: [{ key: 'a', text: 'Alpha', search: 'Alpha' }], policy, filter, filtering,
    });
    const expected = screen.filterKey(list, chunk, flags);
    const actual = call('list_screen.filter_key', {
      policy, filtering, filter, chunk,
      character: !!flags.character, backspace: !!flags.backspace,
      clear: !!flags.clear, enter: !!flags.enter, escape: !!flags.escape,
    });
    assert.deepEqual(actual, expected,
      `${policy}/${filtering} ${JSON.stringify(filter)} ${JSON.stringify(chunk)}`);
    assert.equal(list.filter, actual.filter);
    assert.equal(list.filtering, actual.filtering);
  }
});

test('native filter status and hint match', { skip }, () => {
  const cases = [
    { rows: [], filter: '' },
    { rows: [{ key: 'a', text: 'Alpha', search: 'Alpha' }], filter: '' },
    { rows: [{ key: 'a', text: 'Alpha', search: 'Alpha' }], filter: 'zzz' },
    { rows: [
      { key: 'a', text: 'Alpha', search: 'Alpha' },
      { key: 'b', text: 'Beta', search: 'Beta' },
      { key: 'c', text: 'Gamma', search: 'Gamma' },
    ], filter: 'beta' },
  ];
  for (const { rows, filter } of cases) {
    const list = screen.createListState({ rows, filter });
    const summary = screen.filterSummary(list, { noun: 'row' });
    const total = rows.length;
    const shown = screen.entriesOf(list).filter((entry) => entry.kind !== 'heading').length;
    assert.equal(call('list_screen.filter_summary', { filter, total, shown, noun: 'row' }),
      summary, filter || '(no filter)');
  }
  for (const policy of [screen.TYPEAHEAD, screen.EXPLICIT]) {
    for (const filtering of [false, true]) {
      assert.equal(call('list_screen.filter_hint', { policy, filtering }),
        screen.filterHint({ policy, filtering }));
    }
  }
});
