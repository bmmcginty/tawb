'use strict';

// The contents of the internal pages Lynx asks for: HELP, INFO, LIST,
// ADDRLIST, VLINKS and HISTORY, plus the one-line description DWIMHELP gives.
//
// Each builder returns plain library rows and reads nothing but its arguments,
// so the terminal loop keeps only the small wrapper that lifts the rows into a
// buffer and shows them. Nothing here knows how a buffer or a cursor works,
// which is what makes the pages testable without a terminal.

const { LINK_ROLES, FOCUSABLE_ROLES, FIELD_ROLES } = require('./aria');
const { shortAddress } = require('./library');

// HELP. Lynx prints its own fixed help screen; the commands named here are the
// ones this interface actually acts on. Imported functions with no TAWB
// equivalent cannot be bound, so they are listed rather than hidden.
function helpRows({ unsupported = [] } = {}) {
  const rows = [
    'Lynx Help for TAWB',
    '',
    'Arrow keys: move to links and controls; Right or Enter activates.',
    '^ / $: first / last link or form control.',
    'Space / b: next / previous screen.',
    'g / G: enter a new address / edit the current address.',
    '/, n, N: search / next match / previous match.',
    'l / A: list references / list reference addresses.',
    'a / v: add a bookmark / view bookmarks; r removes the selected bookmark.',
    'd: download the current link.',
    'o: options menu.  k: keymap and keyboard bindings.',
    'm: return to the main screen.  \\: toggle source.',
    'x: reload without cache.  z: stop loading.',
    'Ctrl+T: toggle tracing.  ;: view the trace log.',
    'q: quit, after asking.  Q: quit without asking.',
    'Left: return from this help page.',
  ];
  if (unsupported && unsupported.length) {
    rows.push('', `Unavailable Lynx functions: ${unsupported.join(', ')}`);
  }
  return rows;
}

// INFO. The document and, when the reader is standing on one, the selected
// control. Lynx's own headings, so a reader who knows the screen finds the
// line where they expect it.
function documentInfoRows({ title, url, source, size, item }) {
  const rows = [
    { text: 'File that you are currently viewing', entry: null },
    { text: `Linkname: ${title || '(no title)'}`, entry: null },
    { text: `URL: ${url}`, entry: null },
    { text: `size: ${size} lines`, entry: null },
    { text: `mode: ${source === 'source' ? 'source' : 'normal'}`, entry: null },
  ];
  if (item && FOCUSABLE_ROLES.has(item.role)) {
    rows.push(
      { text: 'Link that you currently have selected', entry: null },
      { text: `Linkname: ${item.name || '(unnamed)'}`, entry: null },
    );
    if (item.href) rows.push({ text: `URL: ${item.href}`, entry: null });
  }
  return rows;
}

// VLINKS: the links followed this session, newest first, each with the address
// Enter would follow.
function visitedRows(visitedLinks = []) {
  return visitedLinks.map((entry) => ({
    text: `${entry.name} — ${shortAddress(entry.href)}`,
    entry: { title: entry.name, url: entry.href },
  }));
}

// HISTORY: the documents held this session. The current one is marked, since
// the list is read from the top and the reader wants to know where "here" is.
function sessionRows(pageLog = []) {
  return pageLog.map((entry, index) => ({
    text: `${index === 0 ? 'here: ' : ''}${entry.title} — ${shortAddress(entry.url)}`,
    entry: { title: entry.title, url: entry.url },
  }));
}

// LIST and ADDRLIST. A reference list points back into the current page
// buffer, so each row keeps the block object it named rather than only its
// address: Enter uses that to activate the page's own control, preserving
// fragments, focus and history. The marker follows the numbering the display
// already uses when numbering is on, and falls back to a plain ordinal.
function linkListRows({ blocks = [], lines = [], addresses = false, numbered = false } = {}) {
  const displayNumbers = new Map();
  for (const line of lines) {
    if (line.displayNumber && !displayNumbers.has(line.blockIndex)) {
      displayNumbers.set(line.blockIndex, line.displayNumber);
    }
  }
  const rows = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const item = block && block.item;
    if (!item || !LINK_ROLES.has(item.role) || !item.href) continue;
    const ordinal = displayNumbers.get(blockIndex) || rows.length + 1;
    const marker = numbered ? `[${ordinal}]` : `${rows.length + 1}.`;
    const description = addresses ? item.href : (item.name || item.href);
    rows.push({
      text: `${marker} ${description}`,
      entry: { title: description, url: item.href, block },
    });
  }
  return rows;
}

// DWIMHELP's answer for the control under the cursor, or null when there is
// none. F1 says what pressing the control would do, which for a text field is
// to enter it rather than to go anywhere.
function describeItem(item) {
  if (!item) return null;
  const parts = [item.name || '(unnamed)', item.role || 'item'];
  if (item.href) parts.push(`goes to ${item.href}`);
  if (item.expanded === true) parts.push('expanded');
  if (item.expanded === false) parts.push('collapsed');
  if (item.disabled) parts.push('disabled');
  if (item.checked != null) parts.push(item.checked ? 'checked' : 'not checked');
  const how = FIELD_ROLES.has(item.role)
    ? 'Typing enters it; Enter submits'
    : 'Enter activates it';
  return `${parts.join(' — ')}. ${how}.`;
}

// The trace log page is the last 500 non-blank lines of the file TAWB wrote.
function traceRows(text) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-500)
    .map((line) => ({ text: line, entry: null }));
}

module.exports = {
  helpRows, documentInfoRows, visitedRows, sessionRows,
  linkListRows, describeItem, traceRows,
};
