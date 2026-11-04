'use strict';

// What makes a list a list.
//
// The browser's own lists, the dropdown of a select, and the keyboard wizard
// all answer the same questions: which rows survive the filter, where a
// section heading belongs, which row is selected while it does, and where a
// movement key lands. None of that depends on what a row does when it is
// activated, so it lives here rather than in each screen.
//
// A row is anything with `key`, `text` and `search`. `search` is what the
// filter reads; it may include words the line does not show — a URL behind a
// title, an action id or a binding behind a label.
//
// A section is `{ key, title, rows }`. A title makes a heading row visible
// whenever the section still has a matching row. `pinned` rows are shown
// whatever the filter says: the wizard's reset and exit rows are the reason.

function terms(filter) {
  return String(filter || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// What the reader typed, against what they can see. Case is ignored, because
// an address is lower case and a title is not, and nobody filtering a list of
// pages means the difference. Every word must appear, in any order: a search
// for "book mark" is a search for both words, not for that exact phrase, so
// "wiki braille" finds the article without knowing which order they come in.
function matches(haystack, filter) {
  const words = terms(filter);
  if (!words.length) return true;
  const text = String(haystack || '').toLowerCase();
  return words.every((word) => text.includes(word));
}

function rowMatches(row, filter) {
  return matches(row && row.search != null ? row.search : row && row.text, filter);
}

function filterRows(rows, filter) {
  const words = terms(filter);
  if (!words.length) return [...rows];
  return rows.filter((row) => rowMatches(row, filter));
}

function sectionEntries(section, filter) {
  const rows = filterRows(section.rows || [], filter);
  if (!rows.length) return [];
  const entries = [];
  if (section.title) {
    entries.push({
      kind: 'heading',
      key: `section:${section.key}`,
      title: section.title,
      section,
    });
  }
  for (const row of rows) entries.push({ kind: 'row', key: row.key, row, section });
  return entries;
}

// Everything the screen may draw, in order. Sections with no matching row
// disappear entirely, heading included; pinned rows never do.
function visibleEntries({ sections = [], pinned = [], filter = '' } = {}) {
  const entries = [];
  for (const section of sections) entries.push(...sectionEntries(section, filter));
  for (const row of pinned) entries.push({ kind: 'pinned', key: row.key, row });
  return entries;
}

function firstSelectable(entries) {
  const index = entries.findIndex((entry) => entry.kind !== 'heading');
  return index >= 0 ? index : 0;
}

// The key the selection should have after the rows or the filter changed.
// The row the reader was on wins when it is still there; otherwise the first
// row after its heading is a better landing place than the heading itself,
// because that is where the next Enter or replacement acts.
function selectionKey(entries, preferred = null) {
  if (!entries.length) return null;
  if (preferred != null && entries.some((entry) => entry.key === preferred)) return preferred;
  return entries[firstSelectable(entries)].key;
}

function selectionIndex(entries, preferred = null) {
  if (!entries.length) return -1;
  const key = selectionKey(entries, preferred);
  return entries.findIndex((entry) => entry.key === key);
}

// Where one movement lands. `pageSize` is the screen's list height; `first`
// is the very top entry, heading included, and `last` is the pinned row at
// the bottom. `next` and `previous` step through headings as ordinary rows so
// a reader can hear the section they are entering.
function moveKey(entries, selectedKey, action, pageSize = 1) {
  if (!entries.length) return null;
  const index = selectionIndex(entries, selectedKey);
  let target = index;
  switch (action) {
    case 'next': target = index + 1; break;
    case 'previous': target = index - 1; break;
    case 'page-next': target = index + pageSize; break;
    case 'page-previous': target = index - pageSize; break;
    case 'first': target = 0; break;
    case 'last': target = entries.length - 1; break;
    default: break;
  }
  target = Math.max(0, Math.min(target, entries.length - 1));
  return entries[target].key;
}

// The filter's own two edits, so every list removes a character the same way.
// Code points, not UTF-16 units: an emoji typed into a filter is one
// character to the reader and must be one Backspace.
function appendFilter(filter, text) {
  return String(filter || '') + String(text || '');
}

function backspaceFilter(filter) {
  const characters = [...String(filter || '')];
  characters.pop();
  return characters.join('');
}

module.exports = {
  terms, matches, rowMatches, filterRows,
  visibleEntries, firstSelectable, selectionKey, selectionIndex, moveKey,
  appendFilter, backspaceFilter,
};
