'use strict';

// The shared list rules, differenced against the Crystal port. The screens
// that use them are compared elsewhere; this pins the answers themselves —
// filter visibility, headings, pinned rows, selection and movement — so a
// screen cannot diverge by interpreting the model differently.

const test = require('node:test');
const assert = require('node:assert');

const model = require('../src/list_model');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

const row = (key, search) => ({ key, search });
const SECTIONS = [
  { key: 'reading', title: 'Reading', rows: [
    row('next-line', 'Next line next-line j ArrowDown'),
    row('previous-line', 'Previous line previous-line k ArrowUp'),
  ] },
  { key: 'editing', title: 'Editing', rows: [
    row('edit-backspace', 'Delete previous character while editing edit-backspace Backspace'),
  ] },
];
const PINNED = [row('cmd:reset', 'Restore default bindings'), row('cmd:exit', 'Exit keyboard wizard')];

function shape(entries) {
  return entries.map((entry) => ({
    kind: entry.kind,
    key: entry.key,
    title: entry.title ?? null,
    rowKey: entry.row ? entry.row.key : null,
  }));
}

test('native list visibility, headings, pinned rows and filtering match', { skip }, () => {
  for (const filter of ['', 'line', 'backspace', 'nothing', 'NEXT']) {
    const expected = shape(model.visibleEntries({ sections: SECTIONS, pinned: PINNED, filter }));
    assert.deepEqual(call('list_model.visible_entries', {
      sections: SECTIONS, pinned: PINNED, filter,
    }), expected, filter || '(no filter)');
  }
});

test('native list selection and movement match', { skip }, () => {
  const entries = shape(model.visibleEntries({ sections: SECTIONS, pinned: PINNED }));
  const compact = entries.map((entry) => ({ kind: entry.kind, key: entry.key }));
  const cases = [
    [null, 'next'], ['next-line', 'next'], ['next-line', 'previous'],
    ['next-line', 'page-next', 3], ['edit-backspace', 'page-previous', 3],
    ['edit-backspace', 'first'], ['section:reading', 'last'],
    ['cmd:exit', 'next'], ['gone', 'next'],
  ];
  for (const [selectedKey, action, pageSize] of cases) {
    assert.deepEqual(call('list_model.move', {
      entries: compact, selectedKey, action, pageSize: pageSize ?? 1,
    }), model.moveKey(entries, selectedKey, action, pageSize ?? 1),
    `${selectedKey ?? '(none)'} ${action}`);
  }
  assert.deepEqual(call('list_model.move', { entries: [], selectedKey: null, action: 'next' }), null);
});
