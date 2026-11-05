'use strict';

// What makes a list screen a screen.
//
// list_model.js answers the questions a list has — what matches, where a
// heading belongs, where a movement lands. This is the state a screen keeps
// between those questions: one filter, one policy for how that filter is
// typed, and one selected row. The library, the dropdown and the keyboard
// wizard all use this shape rather than each keeping its own `filter` and
// `filtering` variables.
//
// A policy is not a preference. Every production list uses explicit filtering:
// j and k stay movement, and `/` (or whatever `find-forward` is bound to)
// opens the filter input. The wizard needs it because it edits the very keymap
// that would otherwise turn every printable key into text. Typeahead remains
// the other half of the shared primitive for contract tests, but no list the
// reader opens uses it.

const {
  visibleEntries, selectionKey, selectionIndex, moveKey, appendFilter, backspaceFilter,
} = require('./list_model');

const TYPEAHEAD = 'typeahead';
const EXPLICIT = 'explicit';
const CLEAR_FILTER = '\x15';

function blankRows(rows) {
  return { key: 'rows', title: null, rows };
}

// One state shape for every list screen. `rows` is shorthand for a single
// untitled section, which is what the library and chooser have; screens with
// headings pass `sections` directly.
function createListState({
  rows = null, sections = [], pinned = [], filter = '', policy = TYPEAHEAD,
  selectedKey = null, fallbackIndex = 0, filtering = false,
} = {}) {
  return {
    sections: rows == null ? sections : [blankRows(rows)],
    pinned,
    filter: String(filter || ''),
    policy: policy === EXPLICIT ? EXPLICIT : TYPEAHEAD,
    selectedKey: selectedKey == null ? null : selectedKey,
    fallbackIndex: Math.max(0, fallbackIndex | 0),
    filtering: policy === EXPLICIT ? !!filtering : false,
  };
}

function entriesOf(list) {
  return visibleEntries(list);
}

function selectedIndex(list, entries = entriesOf(list)) {
  return selectionIndex(entries, list.selectedKey, { fallbackIndex: list.fallbackIndex });
}

// Settle the selection against the rows that exist now. The row the reader
// was on wins when it is still there; otherwise the nearest row to where it
// was wins. Returns the selected index, or -1 for a list with no rows at all.
function select(list, entries = entriesOf(list)) {
  if (!entries.length) {
    list.selectedKey = null;
    return -1;
  }
  const key = selectionKey(entries, list.selectedKey, { fallbackIndex: list.fallbackIndex });
  list.selectedKey = key;
  const index = selectionIndex(entries, key);
  list.fallbackIndex = Math.max(0, index);
  return index;
}

// Replace the filter and settle the selection in one step. The old selected
// position becomes the fallback, so a row which the new filter hides still
// leaves the reader near where they were rather than at the top.
function setFilter(list, filter) {
  const before = entriesOf(list);
  const index = selectedIndex(list, before);
  if (index >= 0) list.fallbackIndex = index;
  list.filter = String(filter || '');
  return select(list);
}

function move(list, action, pageSize = 1) {
  const entries = entriesOf(list);
  const index = select(list, entries);
  if (index < 0) return -1;
  const key = moveKey(entries, list.selectedKey, action, pageSize);
  list.selectedKey = key;
  const moved = selectionIndex(entries, key);
  list.fallbackIndex = Math.max(0, moved);
  return moved;
}

function beginFilter(list) {
  if (list.policy !== EXPLICIT) return false;
  list.filtering = true;
  return true;
}

function endFilter(list) {
  if (list.policy !== EXPLICIT) return false;
  const was = list.filtering;
  list.filtering = false;
  return was;
}

function printable(chunk) {
  return typeof chunk === 'string' && chunk >= ' ' && chunk !== '\x7f'
    && !chunk.startsWith('\x1b');
}

// Edit the filter according to the screen's policy. The caller says what kind
// of key it saw; this decides whether the filter is allowed to have it.
// Returns whether the key was consumed, whether the rows changed, and whether
// an explicit filter input ended. A typeahead list has no separate input mode,
// so Enter and Escape are left to the screen.
function filterKey(list, chunk, {
  character = printable(chunk), backspace = false, clear = false,
  enter = false, escape = false,
} = {}) {
  const explicit = list.policy === EXPLICIT;
  if (explicit && !list.filtering) return { handled: false, changed: false, ended: false };

  // Ctrl+U is always the filter's clear. A page keymap may also call that
  // control chord a command — Lynx has several — but a reader inside the
  // filter input means the edit, not the command.
  if (clear) {
    const changed = list.filter !== '';
    setFilter(list, '');
    return { handled: true, changed, ended: false };
  }
  if (explicit && (enter || escape)) {
    list.filtering = false;
    return { handled: true, changed: false, ended: true };
  }
  if (backspace) {
    if (!list.filter) return { handled: true, changed: false, ended: false };
    setFilter(list, backspaceFilter(list.filter));
    return { handled: true, changed: true, ended: false };
  }
  if (character) {
    setFilter(list, appendFilter(list.filter, chunk));
    return { handled: true, changed: true, ended: false };
  }
  return { handled: false, changed: false, ended: false };
}

function counts(list, entries = entriesOf(list)) {
  let total = 0;
  for (const section of list.sections) total += (section.rows || []).length;
  const shown = entries.filter((entry) => entry.kind !== 'heading').length;
  return { total, shown };
}

// The sentence a filter screen says about its own rows. `noun` is pluralised
// here; a caller with a different word for an empty list says that itself.
function filterSummary(list, { noun = 'row' } = {}) {
  const { total, shown } = counts(list);
  const plural = (count) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (list.filter) {
    return shown ? `${shown} of ${total} ${noun}s matching "${list.filter}".`
      : `Nothing matching "${list.filter}".`;
  }
  return `${plural(total)}.`;
}

// What the screen says about how to filter it, so the policy is visible on
// the status row rather than hidden in the handler.
function filterHint(list, {
  typeahead = 'type to filter', explicit = '/: filter',
  filtering = 'Enter/Esc: browse results  Ctrl+U: clear',
} = {}) {
  if (list.policy === EXPLICIT) return list.filtering ? filtering : explicit;
  return typeahead;
}

module.exports = {
  TYPEAHEAD, EXPLICIT, CLEAR_FILTER,
  createListState, entriesOf, selectedIndex, select, setFilter, move,
  beginFilter, endFilter, printable, filterKey, counts, filterSummary, filterHint,
};
