'use strict';

// The shared list rules: which rows survive a filter, where section headings
// go, which row the selection lands on, and how a movement moves. The library,
// the dropdown and the keyboard wizard all read these answers rather than
// carrying their own copies.

const test = require('node:test');
const assert = require('node:assert');

const {
  terms, matches, rowMatches, filterRows, visibleEntries,
  firstSelectable, nearestSelectable, selectionKey, selectionIndex, moveKey,
  appendFilter, backspaceFilter,
} = require('../src/list_model');

const row = (key, text, search = text) => ({ key, text, search });

const SECTIONS = [
  {
    key: 'reading',
    title: 'Reading',
    rows: [
      row('next-line', 'Next line', 'Next line next-line j ArrowDown'),
      row('previous-line', 'Previous line', 'Previous line previous-line k ArrowUp'),
    ],
  },
  {
    key: 'editing',
    title: 'Editing',
    rows: [
      row('edit-backspace', 'Delete previous character while editing',
        'Delete previous character while editing edit-backspace Backspace'),
    ],
  },
];
const PINNED = [row('cmd:reset', 'Restore default bindings'), row('cmd:exit', 'Exit keyboard wizard')];

test('a filter is every word, in any order and any case', () => {
  assert.deepEqual(terms('  Next   LINE '), ['next', 'line']);
  assert.equal(matches('Next line', 'line next'), true);
  assert.equal(matches('Next line', 'NEXT'), true);
  assert.equal(matches('Next line', 'next missing'), false);
  assert.equal(matches('Next line', ''), true);
  assert.equal(matches('', 'anything'), false);
});

test('a row filters on its search text, not only on what it shows', () => {
  const hidden = row('download-link', 'Download link under the cursor', 'Alt+D download-link');
  assert.equal(rowMatches(hidden, 'alt+d'), true);
  assert.equal(rowMatches(hidden, 'download link'), true);
  assert.deepEqual(filterRows([hidden, row('quit', 'Quit', 'q')], 'alt+d')
    .map((one) => one.key), ['download-link']);
});

test('sections with no matching row disappear, heading and all; pinned rows stay', () => {
  const all = visibleEntries({ sections: SECTIONS, pinned: PINNED });
  assert.deepEqual(all.map((entry) => entry.key), [
    'section:reading', 'next-line', 'previous-line',
    'section:editing', 'edit-backspace',
    'cmd:reset', 'cmd:exit',
  ]);
  assert.deepEqual(all.map((entry) => entry.kind), [
    'heading', 'row', 'row', 'heading', 'row', 'pinned', 'pinned',
  ]);

  const filtered = visibleEntries({ sections: SECTIONS, pinned: PINNED, filter: 'backspace' });
  assert.deepEqual(filtered.map((entry) => entry.key), [
    'section:editing', 'edit-backspace', 'cmd:reset', 'cmd:exit',
  ]);

  const nothing = visibleEntries({ sections: SECTIONS, pinned: PINNED, filter: 'zzz' });
  assert.deepEqual(nothing.map((entry) => entry.kind), ['pinned', 'pinned']);
});

test('an untitled section contributes rows but no heading', () => {
  const entries = visibleEntries({
    sections: [{ key: 'plain', title: null, rows: [row('a', 'Alpha')] }],
  });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.key]), [['row', 'a']]);
});

test('the selection keeps a visible row and otherwise lands after its heading', () => {
  const entries = visibleEntries({ sections: SECTIONS, pinned: PINNED });
  assert.equal(firstSelectable(entries), 1);
  assert.equal(selectionKey(entries, 'previous-line'), 'previous-line');
  assert.equal(selectionIndex(entries, 'previous-line'), 2);
  // A row that the filter removed is not kept: the first row after its
  // heading is where Enter or a replacement will act.
  assert.equal(selectionKey(entries, 'gone'), 'next-line');
  assert.equal(selectionIndex(entries, 'gone'), 1);
  assert.equal(selectionKey([], 'anything'), null);
});

test('a missing selection falls to the nearest selectable row by position', () => {
  const entries = visibleEntries({ sections: SECTIONS, pinned: PINNED });
  // Entries: heading, next-line, previous-line, heading, edit-backspace,
  // cmd:reset, cmd:exit.
  assert.equal(nearestSelectable(entries, 2), 2);
  assert.equal(nearestSelectable(entries, 3), 2, 'a heading falls back upward');
  assert.equal(nearestSelectable(entries, 0), 1, 'the first heading falls forward');
  assert.equal(nearestSelectable(entries, 99), 6, 'past the end lands on the last row');
  assert.equal(nearestSelectable([], 4), -1);
  assert.equal(selectionKey(entries, 'gone', { fallbackIndex: 4 }), 'edit-backspace');
  assert.equal(selectionIndex(entries, 'gone', { fallbackIndex: 4 }), 4);
  // The old behaviour is unchanged when no fallback is named.
  assert.equal(selectionKey(entries, 'gone'), 'next-line');
});

test('movement steps through headings and clamps at both ends', () => {
  const entries = visibleEntries({ sections: SECTIONS, pinned: PINNED });
  assert.equal(moveKey(entries, null, 'next'), 'previous-line');
  assert.equal(moveKey(entries, 'next-line', 'next'), 'previous-line');
  assert.equal(moveKey(entries, 'next-line', 'previous'), 'section:reading');
  assert.equal(moveKey(entries, 'next-line', 'page-next', 3), 'edit-backspace');
  assert.equal(moveKey(entries, 'edit-backspace', 'page-previous', 3), 'next-line');
  assert.equal(moveKey(entries, 'edit-backspace', 'first'), 'section:reading');
  assert.equal(moveKey(entries, 'section:reading', 'last'), 'cmd:exit');
  assert.equal(moveKey(entries, 'cmd:exit', 'next'), 'cmd:exit');
  assert.equal(moveKey([], null, 'next'), null);
});

test('the filter edits by reader-visible character', () => {
  assert.equal(appendFilter('louis', ' braille'), 'louis braille');
  assert.equal(backspaceFilter('louis'), 'loui');
  assert.equal(backspaceFilter('a😀'), 'a');
  assert.equal(backspaceFilter(''), '');
});
