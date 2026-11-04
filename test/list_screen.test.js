'use strict';

// The shared list-screen state: one filter, one input policy and one selected
// row for the library, the dropdown and the keyboard wizard.

const test = require('node:test');
const assert = require('node:assert');

const {
  TYPEAHEAD, EXPLICIT, CLEAR_FILTER,
  createListState, entriesOf, select, setFilter, move,
  beginFilter, endFilter, filterKey, filterSummary, filterHint,
} = require('../src/list_screen');

const row = (key, text, search = text) => ({ key, text, search });

test('rows become one untitled section, and sections remain sections', () => {
  const rows = createListState({ rows: [row('a', 'Alpha')] });
  assert.deepEqual(rows.sections, [{ key: 'rows', title: null, rows: [row('a', 'Alpha')] }]);
  const sections = [{ key: 'reading', title: 'Reading', rows: [row('b', 'Beta')] }];
  assert.equal(createListState({ sections }).sections, sections);
});

test('a typeahead list filters on every printable character', () => {
  const list = createListState({ rows: [row('a', 'Alpha'), row('b', 'Beta')] });
  assert.equal(filterKey(list, 'b').changed, true);
  assert.equal(list.filter, 'b');
  assert.deepEqual(entriesOf(list).map((entry) => entry.key), ['b']);
  assert.equal(filterKey(list, '\x7f', { backspace: true }).changed, true);
  assert.equal(list.filter, '');
});

test('an explicit list keeps printable keys for movement until its filter opens', () => {
  const list = createListState({
    rows: [row('a', 'Alpha'), row('b', 'Beta')], policy: EXPLICIT,
  });
  assert.equal(filterKey(list, 'j').handled, false);
  assert.equal(list.filter, '');
  assert.equal(beginFilter(list), true);
  assert.equal(list.filtering, true);
  assert.equal(filterKey(list, 'b').changed, true);
  assert.equal(list.filter, 'b');
  assert.equal(filterKey(list, '\r', { enter: true }).ended, true);
  assert.equal(list.filtering, false);
  assert.equal(list.filter, 'b', 'ending the input keeps the narrowed results');
  assert.equal(endFilter(list), false);
});

test('Ctrl+U clears the filter in either policy', () => {
  const list = createListState({ rows: [row('a', 'Alpha')] });
  filterKey(list, 'a');
  assert.equal(CLEAR_FILTER, '\x15');
  assert.equal(filterKey(list, CLEAR_FILTER, { clear: true }).changed, true);
  assert.equal(list.filter, '');
});

test('selection follows a stable key and otherwise the nearest position', () => {
  const list = createListState({
    rows: [row('a', 'Alpha'), row('b', 'Beta'), row('c', 'Gamma')], selectedKey: 'b',
  });
  assert.equal(select(list), 1);
  setFilter(list, 'g');
  assert.equal(list.selectedKey, 'c', 'the selected row disappeared, so land near it');
  setFilter(list, '');
  assert.equal(list.selectedKey, 'c', 'and stay on the stable row that is back');
  list.selectedKey = 'gone';
  list.fallbackIndex = 2;
  assert.equal(select(list), 2);
});

test('movement and status come from the shared model', () => {
  const list = createListState({ rows: [row('a', 'Alpha'), row('b', 'Beta')] });
  assert.equal(move(list, 'next'), 1);
  assert.equal(list.selectedKey, 'b');
  assert.equal(move(list, 'last'), 1);
  assert.equal(move(list, 'first'), 0);
  assert.equal(filterSummary(list), '2 rows.');
  filterKey(list, 'b');
  assert.equal(filterSummary(list), '1 of 2 rows matching "b".');
  assert.equal(filterHint(list), 'type to filter');
  const explicit = createListState({ rows: [row('a', 'Alpha')], policy: EXPLICIT });
  assert.equal(filterHint(explicit), '/: filter');
  beginFilter(explicit);
  assert.match(filterHint(explicit), /Enter\/Esc/);
});
