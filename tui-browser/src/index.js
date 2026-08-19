#!/usr/bin/env node
'use strict';

const { FIELD_ROLES, LINK_ROLES, BUTTON_ROLES } = require('./aria');
const { itemAtOffset } = require('./blocks');
const {
  Core, ALL_SOURCES, SOURCE_LABELS, DOM_SOURCES,
  findBlockWithText, sameDocumentFragment,
  ActionTimeout, withTimeout, readFieldState, ACTION_TIMEOUT_MS,
} = require('./core');
const { armFrame, refreshDue, pulse, TICK_MS } = require('./live');
const { log, timed, count, flushCounters, LOG_PATH } = require('./log');
const { layoutLines } = require('./layout');
const { normaliseEndpoint } = require('./browser');
const { openDriver, engineNames, DEFAULT_ENGINE } = require('./driver');
const { claimedTargets, releaseTab } = require('./session');
const { capturePlace, restorePlace } = require('./place');

// --connect <port|host:port|url> attaches to a browser that is already
// running with --remote-debugging-port, rather than launching one.
// --browser <name> chooses which engine to drive.
function parseArgs(argv) {
  const options = {
    url: null, connect: null, profile: null, engine: DEFAULT_ENGINE, keepBrowser: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--connect') { options.connect = normaliseEndpoint(argv[i + 1] || ''); i += 1; }
    else if (arg.startsWith('--connect=')) { options.connect = normaliseEndpoint(arg.slice('--connect='.length)); }
    else if (arg === '--profile') { options.profile = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--profile=')) { options.profile = arg.slice('--profile='.length); }
    else if (arg === '--keep-browser') { options.keepBrowser = true; }
    else if (arg === '--browser') { options.engine = argv[i + 1] || DEFAULT_ENGINE; i += 1; }
    else if (arg.startsWith('--browser=')) { options.engine = arg.slice('--browser='.length); }
    else if (!arg.startsWith('-') && !options.url) { options.url = arg; }
  }
  return options;
}

const ARGS = parseArgs(process.argv.slice(2));
const START_URL = ARGS.url || 'https://www.google.com';

// Set by the entry point so the shutdown path can reach the browser from a
// signal handler, which has no other way to get at it.
let setCurrentDriver = () => {};

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_L = '\x0c';
const CTRL_G = '\x07';
const BACKSPACE = '\x7f';
const BACKSPACE_ALT = '\x08';
const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const HOME_KEY = '\x1b[H';
const END_KEY = '\x1b[F';
// Shift+F4 closes the tab, as the terminals in use actually send it. Function
// keys are the least standardised part of terminal input: xterm and its
// descendants add a modifier parameter, while rxvt and the Linux console send
// a shifted function key as a higher-numbered one — shift+F4 arrives as F14.
// Anything unrecognised is logged with its bytes, so a terminal that speaks
// some fifth dialect can be added by reading tweb.log.
const CLOSE_TAB_KEYS = new Set([
  '\x1b[1;2S',   // xterm, VTE, kitty, alacritty, tmux, screen
  '\x1bO2S',     // xterm keeping SS3 with a modifier
  '\x1b[14;2~',  // terminals that number F4 as 14
  '\x1b[26~',    // Linux console and rxvt: shift+F4 is F14
]);

// Quick navigation follows the JAWS vocabulary: h headings, f form fields,
// b buttons, n non-link text, p paragraphs. Uppercase goes backwards. JAWS
// puts links on k, which is taken by line movement here, so links are on l.
const QUICK_NAV = {
  h: { label: 'heading', match: (item) => item.role === 'heading' },
  l: { label: 'link', match: (item) => LINK_ROLES.has(item.role) },
  f: { label: 'form field', match: (item) => FIELD_ROLES.has(item.role) },
  b: { label: 'button', match: (item) => BUTTON_ROLES.has(item.role) },
  n: { label: 'non-link text', match: (item) => item.role === 'text' },
};

const HEADER_ROWS = 3;   // address line, hint line, blank line
const FOOTER_ROWS = 2;   // blank + status line
const ADDRESS_ROW = 1;
const HINT_ROW = 2;

// No selection marker: the terminal cursor already marks the focused line,
// and a screen reader / braille display tracks it there. A printed marker
// would only add a column of noise to every line and shift the text.
const GUTTER = 0;

function termSize() {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

function viewportHeight() {
  return Math.max(1, termSize().rows - HEADER_ROWS - FOOTER_ROWS);
}

function contentWidth() {
  return Math.max(20, termSize().cols - GUTTER - 1);
}

function setupRawInput() {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
}

function readKey() {
  return new Promise((resolve) => {
    process.stdin.once('data', (chunk) => resolve(chunk));
  });
}

// ANSI cursor positioning is 1-indexed. This is the whole point of the
// exercise: a terminal screen reader / braille display follows the actual
// terminal cursor, so it must land on the focused line, and mid-edit on the
// real caret column.
function moveCursor(row, col) {
  process.stdout.write(`\x1b[${row};${col}H`);
}

// Rewrites a single row in place (move, erase-to-end-of-line, write).
function writeLine(row, text) {
  moveCursor(row, 1);
  process.stdout.write('\x1b[2K' + text);
}

// DECSTBM: confine scrolling to the list area so the header stays put and a
// single-line step past an edge costs one new line instead of a repaint.
function setScrollRegion() {
  process.stdout.write(`\x1b[${HEADER_ROWS + 1};${HEADER_ROWS + viewportHeight()}r`);
}

function resetScrollRegion() {
  process.stdout.write('\x1b[r');
}

function scrollRegion(direction) {
  const top = HEADER_ROWS + 1;
  const bottom = HEADER_ROWS + viewportHeight();
  if (direction > 0) {
    moveCursor(bottom, 1);
    process.stdout.write('\x1bD'); // IND — scroll up, blank line at bottom
    return bottom;
  }
  moveCursor(top, 1);
  process.stdout.write('\x1bM'); // RI — scroll down, blank line at top
  return top;
}

function lineRow(state, lineIndex) {
  return HEADER_ROWS + 1 + (lineIndex - state.scroll);
}

function isVisible(state, lineIndex) {
  return lineIndex >= state.scroll && lineIndex < state.scroll + viewportHeight();
}

function currentLine(state) {
  return state.lines[state.cursor] || null;
}

function currentBlock(state) {
  const line = currentLine(state);
  return line ? state.blocks[line.blockIndex] : null;
}

function itemUnderCursor(state) {
  const block = currentBlock(state);
  return itemAtOffset(block);
}

function cursorCol(state) {
  return GUTTER + (state.col || 0) + 1;
}

function clampCol(state) {
  const line = currentLine(state);
  const max = line ? Math.max(line.text.length - 1, 0) : 0;
  state.col = Math.min(Math.max(state.col || 0, 0), max);
}

function clampScroll(state) {
  const height = viewportHeight();
  const maxScroll = Math.max(0, state.lines.length - height);
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  else if (state.cursor >= state.scroll + height) state.scroll = state.cursor - height + 1;
  state.scroll = Math.min(Math.max(state.scroll, 0), maxScroll);
  syncCursor(state);
}

// Tell the core where the reader is, in the only currency it understands: a
// block index. Every cursor movement in this file settles through
// clampScroll, which makes this the one place that has to say so.
//
// It is deliberately one-way and unacknowledged. Across a process boundary
// this is a single line of JSON with nothing awaiting it — around 25
// microseconds — which is what lets arrow keys stay a local operation while
// the policy that needs to know where the reader is stays in the core. The
// worst a stale answer can cost is one refused text patch.
function syncCursor(state) {
  if (!state.core) return;
  const line = state.lines[state.cursor];
  state.core.at(line ? line.blockIndex : -1);
}

function relayout(state) {
  state.lines = layoutLines(state.blocks, contentWidth());
  if (state.cursor >= state.lines.length) state.cursor = Math.max(state.lines.length - 1, 0);
  clampCol(state);
  clampScroll(state);
}

function lineText(state, lineIndex) {
  const line = state.lines[lineIndex];
  return line ? line.text : '';
}

// ---------------------------------------------------------------------------
// Drawing
//
// The header and the list are drawn independently. Navigating, switching
// view, even loading a different page repaints only the list area — the
// address and hint rows are rewritten just when their own text changes.
// Repainting a row a screen reader is not looking at is not free: it makes
// the display re-read content that did not change.
// ---------------------------------------------------------------------------

function addressText(state, page) {
  if (state.mode === 'address') return state.address.text;
  return page.url();
}

// The address is one line and URLs are routinely longer than the terminal is
// wide, so it scrolls horizontally around the caret instead of wrapping.
function drawAddress(state, page, { force = false } = {}) {
  const label = `[${SOURCE_LABELS[state.source]}] `;
  const width = Math.max(10, termSize().cols - label.length);
  const full = addressText(state, page);

  let view = full;
  let caretOffset = 0;

  if (state.mode === 'address') {
    const caret = state.address.caret;
    if (caret < state.address.scroll) state.address.scroll = caret;
    else if (caret >= state.address.scroll + width) state.address.scroll = caret - width + 1;
    state.address.scroll = Math.max(0, Math.min(state.address.scroll, Math.max(0, full.length - width + 1)));
    view = full.slice(state.address.scroll, state.address.scroll + width);
    caretOffset = caret - state.address.scroll;
  } else if (full.length > width) {
    view = full.slice(0, width - 1) + '>';
  }

  const rendered = label + view;
  if (!force && rendered === state.drawn.address) return;
  state.drawn.address = rendered;
  writeLine(ADDRESS_ROW, rendered);

  if (state.mode === 'address') {
    moveCursor(ADDRESS_ROW, label.length + caretOffset + 1);
  }
}

function hintText(state) {
  if (state.mode === 'address') return 'Address — Enter: go  Esc: cancel';
  if (state.mode === 'type') return 'Typing — Esc: stop  Enter: submit';
  if (state.mode === 'find') return 'Find — Enter: search  Esc: cancel';
  return 'j/k line  h/l/f/b/n/p nav  / find  m click  \\ view  ^L address  c changes  q quit';
}

// Deliberately carries no line counter. A position indicator here would
// change on every keystroke and force the banner to be repainted along with
// it, which is the churn the split exists to avoid — the banner should stay
// untouched while reading. Press '=' when the position is actually wanted.
function drawHint(state, { force = false } = {}) {
  const rendered = hintText(state).slice(0, termSize().cols);
  if (!force && rendered === state.drawn.hint) return;
  state.drawn.hint = rendered;
  writeLine(HINT_ROW, rendered);
}

// Repaints only the list region. No clear-screen: the header rows and the
// status row are left exactly as they are.
function drawList(state) {
  const height = viewportHeight();
  resetScrollRegion();
  for (let i = 0; i < height; i += 1) {
    const lineIndex = state.scroll + i;
    writeLine(HEADER_ROWS + 1 + i, lineIndex < state.lines.length
      ? renderRow(state, lineIndex)
      : '');
  }
  setScrollRegion();
}

function renderRow(state, lineIndex) {
  if (state.mode === 'type' && lineIndex === state.cursor) return typingText(state).text;
  return lineText(state, lineIndex);
}

function typingText(state) {
  const item = state.typing.item;
  const label = `[${item.name}: `;
  return {
    text: label + state.typing.text + ']',
    caretCol: GUTTER + label.length + state.typing.caret + 1,
  };
}

function statusRow() {
  return termSize().rows;
}

function setStatus(state, msg) {
  state.statusMsg = msg;
  writeLine(statusRow(), msg.slice(0, termSize().cols));
  parkCursor(state);
}

// Puts the terminal cursor back where the reader is.
function parkCursor(state) {
  if (state.mode === 'address') {
    drawAddress(state, state.page, { force: true });
    return;
  }
  if (state.mode === 'find') {
    drawFind(state);
    return;
  }
  if (state.mode === 'type') {
    const { caretCol } = typingText(state);
    moveCursor(lineRow(state, state.cursor), caretCol);
    return;
  }
  moveCursor(lineRow(state, state.cursor), cursorCol(state));
}

function render(state, page, { force = false } = {}) {
  clampScroll(state);
  drawAddress(state, page, { force });
  drawHint(state, { force });
  drawList(state);
  if (state.statusMsg) writeLine(statusRow(), state.statusMsg.slice(0, termSize().cols));
  parkCursor(state);
}

// What is on screen now, so it can be compared with what is on screen after.
// Sparse and indexed by line number, which is how patchVisibleRows reads it,
// and only as wide as the viewport — the buffer behind it can be 17,000 lines.
function screenBefore(state) {
  return { rows: visibleRowsNow(state), scroll: state.scroll, height: viewportHeight() };
}

// Repainting after something the reader did.
//
// The list area is redrawn the way a live update redraws it: only the rows
// whose text actually changed. A repainted row is re-read by a screen reader
// and re-flashed by a braille display whether or not it says anything new,
// which is why live updates have always been careful about it — and pressing
// Enter was not. Activating a play button repainted all 19 rows of a 24-row
// terminal, 904 bytes, where two rows had changed and cost 52.
//
// It falls back to a full repaint whenever a row-by-row comparison cannot
// mean anything: the view scrolled, so every row moved; the terminal was
// resized under us; or there is no record of what was on screen before.
function repaintList(state, page, before) {
  drawAddress(state, page);
  drawHint(state);

  if (before && before.scroll === state.scroll && before.height === viewportHeight()) {
    const repainted = patchVisibleRows(state, before.rows);
    log('repaint', { rows: repainted, of: before.height, source: state.source });
    return repainted;
  }

  drawList(state);
  parkCursor(state);
  log('repaint', { rows: viewportHeight(), of: viewportHeight(), full: true, source: state.source });
  return null;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function moveSelection(state, newCursor, page, newCol = 0) {
  const target = Math.min(Math.max(newCursor, 0), Math.max(state.lines.length - 1, 0));
  if (target === state.cursor && newCol === state.col) return;

  const oldScroll = state.scroll;
  state.cursor = target;
  state.col = newCol;
  clampCol(state);
  clampScroll(state);

  const scrolledBy = state.scroll - oldScroll;

  // Nothing outside the list area is touched here: no banner, no status.
  if (scrolledBy === 0) {
    moveCursor(lineRow(state, target), cursorCol(state));
  } else if (Math.abs(scrolledBy) === 1) {
    const newRow = scrollRegion(scrolledBy);
    writeLine(newRow, renderRow(state, target));
    moveCursor(newRow, cursorCol(state));
  } else {
    drawList(state);
    parkCursor(state);
  }
}

// Character movement that carries across line ends, so holding an arrow key
// reads straight through the page rather than stopping at every line.
function moveCaretLeft(state, page) {
  if (state.col > 0) return moveSelection(state, state.cursor, page, state.col - 1);
  if (state.cursor === 0) return;
  const previous = state.cursor - 1;
  return moveSelection(state, previous, page, Math.max(lineText(state, previous).length - 1, 0));
}

function moveCaretRight(state, page) {
  const line = currentLine(state);
  const lastCol = line ? Math.max(line.text.length - 1, 0) : 0;
  if (state.col < lastCol) return moveSelection(state, state.cursor, page, state.col + 1);
  if (state.cursor >= state.lines.length - 1) return;
  return moveSelection(state, state.cursor + 1, page, 0);
}

function findQuickNav(state, match, direction) {
  const step = direction > 0 ? 1 : -1;
  for (let i = state.cursor + step; i >= 0 && i < state.lines.length; i += step) {
    const line = state.lines[i];
    if (line.continuation) continue;
    const block = state.blocks[line.blockIndex];
    if (block.item && match(block.item)) return { line: i, col: 0 };
  }
  return null;
}

// A paragraph is the start of a block-level run that holds text — the unit
// p/P steps through, as distinct from n/N which finds any non-link text.
function findParagraph(state, direction) {
  const step = direction > 0 ? 1 : -1;
  for (let i = state.cursor + step; i >= 0 && i < state.lines.length; i += step) {
    const line = state.lines[i];
    if (line.continuation) continue;
    const block = state.blocks[line.blockIndex];
    if (!block.item || block.item.role !== 'text') continue;
    if (block.startsBlock || block.isParagraph) return { line: i, col: 0 };
  }
  return null;
}

function jumpTo(state, page, found, label, direction) {
  if (!found) {
    setStatus(state, `No ${direction > 0 ? 'next' : 'previous'} ${label}.`);
    return;
  }
  moveSelection(state, found.line, page, found.col);
}

// ---------------------------------------------------------------------------
// Finding text
//
// `/` searches forward, `?` backward, over the lines as they are written —
// so a match lands the cursor on the matching text itself, not merely on the
// line holding it, which is what a braille display and a screen reader
// follow. Wrapped rows are searched like any other, since each is navigable
// in its own right.
//
// Case follows what was typed: an all-lowercase search ignores case, and one
// with a capital in it does not. It is the rule vi and less use, and it means
// searching for "braille" finds the heading while searching for "Braille"
// finds only the name.
//
// There is no `n` for the next match: `n` is non-link text in the JAWS
// vocabulary this reader uses, and taking a jump key away to save two
// keystrokes is a poor trade. `Ctrl+G` repeats the search — Firefox's key for
// exactly this — and `/` or `?` with nothing typed repeats it in that
// direction, which is how a search is reversed.
// ---------------------------------------------------------------------------

function findText(state, needle, direction) {
  const total = state.lines.length;
  if (!total || !needle) return null;

  // Smart case: a capital anywhere means the reader meant it.
  const sensitive = /[A-Z]/.test(needle);
  const want = sensitive ? needle : needle.toLowerCase();
  const textAt = (index) => {
    const text = lineText(state, index);
    return sensitive ? text : text.toLowerCase();
  };

  // One extra step so the line the search started on is examined again from
  // its own start after the wrap, rather than being the one place a match
  // could hide.
  for (let step = 0; step <= total; step += 1) {
    const index = (((state.cursor + direction * step) % total) + total) % total;
    const text = textAt(index);

    let at;
    if (step === 0) {
      // Start from just past the cursor, so repeating a search advances
      // within a long line instead of finding the same match again.
      at = direction > 0
        ? text.indexOf(want, state.col + 1)
        : (state.col > 0 ? text.lastIndexOf(want, state.col - 1) : -1);
    } else {
      at = direction > 0 ? text.indexOf(want) : text.lastIndexOf(want);
    }

    if (at >= 0) {
      const wrapped = step > 0 && (direction > 0
        ? index <= state.cursor
        : index >= state.cursor);
      return { line: index, col: at, wrapped };
    }
  }

  return null;
}

function runSearch(state, page, needle, direction) {
  const found = findText(state, needle, direction);
  if (!found) {
    setStatus(state, `"${needle}" not found.`);
    return;
  }
  moveSelection(state, found.line, page, found.col);
  setStatus(state, `"${needle}" — line ${found.line + 1} of ${state.lines.length}`
    + `${found.wrapped ? ', wrapped' : ''}.`);
}

// The prompt lives on the status line, where the cursor goes with it: the
// address bar is at the top because that is where an address belongs, but a
// search is about the list below and putting the prompt there would mean
// jumping the cursor over the whole page to type.
function findPrompt(state) {
  return (state.find.direction > 0 ? '/' : '?') + state.find.text;
}

function drawFind(state) {
  const cols = termSize().cols;
  writeLine(statusRow(), findPrompt(state).slice(0, cols));
  moveCursor(statusRow(), Math.min(state.find.caret + 2, cols));
}

// ---------------------------------------------------------------------------
// Snapshot refresh, view switching, change tracking
// ---------------------------------------------------------------------------

// Remembers where the reader is by content, not by index. Line counts differ
// wildly between the three views, so an index would land somewhere arbitrary;
// matching the text puts you on the same thing you were reading.
function anchorFor(state) {
  return state.core.anchor();
}

// The line a block starts on. Every block has one; a block index that is not
// in this buffer at all answers -1.
function lineForBlock(state, blockIndex) {
  if (blockIndex < 0) return -1;
  return state.lines.findIndex((l) => l.blockIndex === blockIndex && !l.continuation);
}

function restoreAnchor(state, anchor) {
  if (!anchor) return;
  const line = lineForBlock(state, state.core.restore(anchor));
  if (line >= 0) state.cursor = line;
  state.col = 0;
  clampScroll(state);
}

async function refresh(state, page, { resetCursor = false, anchor = null } = {}) {
  await state.core.rescan({ page });
  if (state.live) state.live.snapshotCostMs = state.core.snapshotCostMs;
  if (resetCursor) { state.cursor = 0; state.scroll = 0; state.col = 0; }
  relayout(state);
  if (anchor) restoreAnchor(state, anchor);
}

// Re-anchoring for an update the reader did not ask for. Unlike
// restoreAnchor, it never falls back to a proportional guess: if the line the
// reader was on has gone, staying put is far less disorienting than being
// silently teleported somewhere proportional.
// Searching for the anchor's text from the top of the document is wrong here:
// block text is often not unique — HTML view is full of repeated <svg>,
// <h4>, <option value=30> — so the first match can be thousands of lines from
// where the reader actually is. Identity first, then the *nearest* text match
// searched outward from the previous position, then stay put. A live update
// must never relocate the reader across the page.
// A live update the reader did not ask for. The core decides where they
// belong now, in block space; all that is left here is finding the line that
// block starts on, and -1 meaning "stay exactly where you are".
function reanchorQuietly(state, anchor) {
  if (!anchor) return;
  const line = lineForBlock(state, state.core.reanchor(anchor).block);
  if (line >= 0) state.cursor = line;
  state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(state.lines.length - 1, 0));
  clampCol(state);
  clampScroll(state);
}

// Repaints only the visible rows whose text actually changed, then puts the
// cursor back. A live update must not scroll, must not move the reader, and
// must not touch a row that still says the same thing — otherwise a braille
// display re-reads content that did not change, every tick.
function patchVisibleRows(state, previousLines) {
  const height = viewportHeight();
  let repainted = 0;

  for (let i = 0; i < height; i += 1) {
    const lineIndex = state.scroll + i;
    const now = lineIndex < state.lines.length ? renderRow(state, lineIndex) : '';
    // Past the end of the list both sides are empty; comparing against
    // undefined here would repaint every blank row on every tick.
    const before = previousLines[lineIndex] != null ? previousLines[lineIndex] : '';
    if (now === before) continue;
    writeLine(HEADER_ROWS + 1 + i, now);
    repainted += 1;
  }

  parkCursor(state);
  return repainted;
}

// Announcements go to the status line. Assertive ones interrupt; polite ones
// only surface when nothing more important is showing — the same distinction
// aria-live draws, and the reason a chat page does not shout over an error.
function announce(state, { politeness, text }) {
  if (!text) return;
  if (politeness === 'assertive' || !state.statusMsg || (state.statusHeldUntil || 0) < Date.now()) {
    state.statusHeldUntil = Date.now() + (politeness === 'assertive' ? 8000 : 4000);
    setStatus(state, text.slice(0, termSize().cols));
  } else {
    state.live.queue.push({ politeness, text });
    if (state.live.queue.length > 5) state.live.queue.shift();
  }
}

// Records that the reader just did something. Live refreshes hold off while
// this is recent, so the buffer is never swapped mid-keystroke. It lives in
// the key handlers rather than the input loop so no call path can bypass it.
// The page can navigate without us asking: a script redirects, a video ends
// and moves on, a login completes. Until we notice, the buffer describes a
// document that no longer exists — every line refers to an element that is
// gone, so activating one fails with an evaluation error against a stale
// handle. Rebuild when the main frame lands somewhere new.
async function onExternalNavigation(state, page) {
  // Every tab reports its own navigations, and only the one being read
  // should rebuild anything.
  if (page !== state.page) return;
  const url = page.url();
  if (url === state.renderedUrl) return;
  if (state.live && state.live.refreshing) return;

  // Following a fragment fires this too. Nothing was replaced — the document
  // is the one already in the buffer — so rebuilding it and resetting the
  // cursor would throw the reader to the top of a page they never left.
  // Activation moves them to the target itself; a hash changed by script
  // leaves them where they are, and the observer catches any real change.
  if (sameDocumentFragment(state.renderedUrl, url)) {
    state.renderedUrl = url;
    return;
  }

  state.renderedUrl = url;
  log('navigation.external', { url: url.slice(0, 120) });
  try {
    await refresh(state, page, { resetCursor: true });
  } catch {
    return; // navigating again already; the next event will catch up
  }
  render(state, page);
  setStatus(state, `Page changed: ${url}`);
}

function markInput(state) {
  if (state.core) state.core.markInput();
}

// Puts the reader back where they were after the buffer has been rebuilt.
// The new position is worked out arithmetically from what actually changed;
// only when the rewritten region resized under the cursor is there no exact
// answer, and only then do we fall back to searching for the line. Reports
// whether the arithmetic answer was available.
// Put the cursor on the line a block starts on, or leave it exactly where it
// is when the core answered -1 for "that content is gone".
function settleCursorOn(state, blockIndex) {
  const line = lineForBlock(state, blockIndex);
  if (line >= 0) state.cursor = line;
  state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(state.lines.length - 1, 0));
  clampCol(state);
  clampScroll(state);
}

function restoreCursorAfterRebuild(state, previousTexts, anchor) {
  const settled = state.core.reanchor(anchor, previousTexts);
  settleCursorOn(state, settled.block);
  return settled.exact;
}

async function runLiveRefresh(state, page) {
  const live = state.live;
  if (!refreshDue(live)) return;

  const cycle = Date.now();
  const wasNavigation = live.navigated;
  live.refreshing = true;
  live.refreshes += 1;
  live.navigated = false;

  const tPrep = Date.now();
  const previousLines = state.lines.map((_, i) => renderRow(state, i));
  const anchor = anchorFor(state);
  const prepMs = Date.now() - tPrep;

  let rebuilt;
  const tPost = Date.now();
  try {
    // Nothing to keep across a navigation: the lines the reader was among
    // belong to a document that is gone.
    rebuilt = await state.core.rebuild(anchor, { page, keepPlace: !wasNavigation });
  } catch (err) {
    live.refreshing = false;
    log('live.refresh.error', { error: String(err.message || err).slice(0, 160) });
    return;
  }
  live.snapshotCostMs = state.core.snapshotCostMs;

  if (wasNavigation) {
    state.cursor = 0;
    state.col = 0;
    state.scroll = 0;
  }
  relayout(state);
  if (!wasNavigation) settleCursorOn(state, rebuilt.settled.block);
  const remapExact = rebuilt.settled.exact;
  const regions = rebuilt.regions;
  const reanchorMs = Date.now() - tPost;
  const diffMs = 0;

  const tDraw = Date.now();
  const repainted = patchVisibleRows(state, previousLines);
  const drawMs = Date.now() - tDraw;

  live.dirty = false;
  live.mutations = 0;
  live.lastRefreshMs = Date.now();
  live.refreshing = false;

  log('live.refresh', {
    source: state.source,
    totalMs: Date.now() - cycle,
    snapshotMs: live.snapshotCostMs,
    prepMs,
    reanchorMs,
    diffMs,
    drawMs,
    repainted,
    remapExact,
    lines: state.lines.length,
    changedRegions: regions.length,
    cursor: state.cursor,
  });
}

// Splices replaced text straight into the buffer, skipping the snapshot.
//
// The core does the rewriting, because which block a piece of text names and
// whether the reader is standing on it are page questions, not terminal ones.
// What is left here is the one test the core cannot make: the patched text
// must still wrap to the same number of lines. A patch that reflows the
// buffer would move the reader, and moving the reader is the one thing a
// live update may not do — so it is undone and the wholesale refresh happens
// instead. Returns the indices of the blocks it changed.
function applyTextPatches(state, patches) {
  // Protection is only owed to a reader who is actually reading: outside the
  // input grace period a tick on the cursor's own line is no more disruptive
  // than one anywhere else.
  const protect = state.core.reading();
  const previousLineCount = state.lines.length;

  const patched = state.core.patchText(patches, { protect });
  if (!patched) return null;

  relayout(state);
  if (state.lines.length !== previousLineCount) {
    patched.undo();
    relayout(state);
    return null;
  }

  return patched.touched;
}

// The rows currently on screen, which is all a splice can have changed: it
// kept the line count, so nothing scrolled. Rendering the whole buffer for
// the comparison would cost more than the patch it is there to make cheap.
function visibleRowsNow(state) {
  const height = viewportHeight();
  const rows = [];
  for (let i = 0; i < height; i += 1) {
    const lineIndex = state.scroll + i;
    rows[lineIndex] = lineIndex < state.lines.length ? renderRow(state, lineIndex) : '';
  }
  return rows;
}

function onLiveEvent(state, page, payload) {
  const { announcements, patches, mutations } = state.core.classify(payload);
  count('mutations', mutations || 0);
  count('notifies');

  for (const item of announcements) announce(state, item);

  // Try the cheap path first. Splicing text in is the reader's to attempt
  // because only the reader can see the one thing that would forbid it: new
  // text that wraps to a different number of lines.
  if (patches && state.mode === 'browse') {
    const before = visibleRowsNow(state);
    const touched = applyTextPatches(state, patches);
    if (touched) {
      const t0 = Date.now();
      const repainted = patchVisibleRows(state, before);
      state.changes = touched.map((index) => ({ start: index, end: index }));
      state.changeIndex = -1;
      count('patched');
      log('live.patch', { patches: patches.length, blocks: touched.length, repainted, ms: Date.now() - t0 });
      return;
    }
    count('patchMissed');
  }

  state.live.mutations += (mutations || 0);
  state.live.dirty = true;
}

// ---------------------------------------------------------------------------
// Tabs
//
// A link with target="_blank" opens a tab and the browser moves to it, which
// for a sighted user is the whole story. Here the reader was left on the page
// they had, reading something the browser had already left behind, with no
// way to reach what had just opened.
//
// So new tabs are followed when the browser gives them focus, and `<` and `>`
// step between everything open. Tabs from every window appear in that list:
// both protocols report tabs without saying which window they sit in, and for
// reading purposes a window is just somewhere else a tab can be.
// ---------------------------------------------------------------------------

// Pages we have already wired navigation events to. Attaching twice would
// rebuild the buffer twice for one navigation.
const attachedPages = new WeakSet();

// How long a newly opened tab is given to become the one on screen before we
// conclude it opened in the background.
const NEW_TAB_SETTLE_MS = 1200;

async function switchToTab(state, page, { note = '' } = {}) {
  if (!page || page === state.page) return false;

  await state.core.adoptTab(page);

  if (!attachedPages.has(page)) {
    attachedPages.add(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      armFrame(frame).catch(() => {});
      onExternalNavigation(state, page).catch(() => {});
    });
  }

  await attachLive(state, page);
  // The buffer described a different tab entirely, so there is no place to
  // keep and nothing to reanchor against.
  await refresh(state, page, { resetCursor: true });
  render(state, page, { force: true });

  const { position, of } = state.core.where(page);
  const label = await state.core.tabLabel(page);
  setStatus(state, note
    ? `${note} — tab ${position} of ${of}: ${label}`
    : `Tab ${position} of ${of}: ${label}`);
  log('tab.switch', { position, of, url: page.url().slice(0, 120) });
  return true;
}

async function cycleTab(state, direction) {
  const next = state.core.nextTab(direction);
  if (!next) {
    setStatus(state, 'Only one tab open.');
    return;
  }
  await switchToTab(state, next);
}

// Closing the tab the reader is on, which is only ever theirs to ask for.
//
// The last tab is not closed. A reader left with no tab has no page, no
// buffer and nothing to move to — the browser would still be running with
// nothing in it — so the key does nothing and says why. Quitting is `q`.
async function closeCurrentTab(state) {
  const current = state.page;
  const next = state.core.tabAfter(current);
  if (!next) {
    setStatus(state, 'This is the only tab open — press q to quit.');
    return;
  }

  const { of } = state.core.where(current);
  const label = await state.core.tabLabel(current);

  try {
    await state.core.closeTab(current);
  } catch (err) {
    setStatus(state, `Could not close this tab: ${err.message.split('\n')[0]}`);
    return;
  }

  log('tab.close', { of, url: current.url ? String(current.url()).slice(0, 120) : '' });
  await switchToTab(state, next, { note: `Closed "${label}"` });
}

// A tab that opens and takes the screen is followed, because the browser has
// already moved and the reader should be where the browser is. One that opens
// behind is announced and left alone — nothing moves the reader without
// saying so.
async function onNewTab(state, page) {
  if (!state.ready || page === state.page) return;

  await new Promise((r) => setTimeout(r, NEW_TAB_SETTLE_MS));
  if (page.isClosed && page.isClosed()) return;

  const foreground = await state.core.isForeground(page);
  log('tab.opened', { url: page.url().slice(0, 120), foreground });

  if (foreground) {
    await switchToTab(state, page, { note: 'Followed a new tab' });
    return;
  }
  const label = await state.core.tabLabel(page);
  setStatus(state, `A new tab opened in the background: ${label} — press > to reach it.`);
}

// ---------------------------------------------------------------------------
// Reaching the end of a feed
//
// A feed has no bottom, it has a scroll position. On Reddit, a search results
// page, a long comment thread, the posts below the fold are not in the
// document at all until something scrolls towards them — and this reader
// never scrolls, because it reads the document rather than the window onto
// it. So the last line of the buffer is not the end of the page, and from
// the reader's side the two are indistinguishable: the list simply stops,
// with no hint that there was ever more.
//
// Pressing down at the last line asks for the rest. We scroll the page to
// its bottom, wait briefly for whatever that triggers, and rebuild. New
// lines land below the cursor, which does not move until they arrive.
// ---------------------------------------------------------------------------

// How long to wait for a feed to answer, when scrolling actually took us
// somewhere new and a fetch is plausible. Long enough for a slow connection.
const LOAD_MORE_TIMEOUT_MS = 2500;
// How long when it did not — we were already at the bottom, so whatever a
// scroll was going to trigger has had its chance. Waiting the full time here
// is what makes the end of an ordinary page feel like a hang.
const LOAD_MORE_SETTLED_MS = 800;

const SCROLL_TO_BOTTOM = () => {
  const root = document.scrollingElement || document.documentElement;
  const targets = [];
  if (root.scrollHeight > root.clientHeight + 50) targets.push(root);

  // Plenty of feeds scroll an inner container rather than the document, and
  // scrolling the document then does nothing at all. Find the tallest one
  // that actually scrolls. The cheap size test comes first so that style
  // resolution — the expensive half — runs on a handful of elements rather
  // than every element on the page.
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  if (best && best !== root) targets.push(best);

  // Where everything was, so a scroll that gained nothing can be undone.
  window.__twebScrollUndo = targets.map((el) => ({ el, top: el.scrollTop }));

  let moved = false;
  for (const el of targets) {
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    if (el.scrollTop !== before) moved = true;
  }

  return {
    elements: document.getElementsByTagName('*').length,
    // Nothing on the page scrolls, so no amount of waiting will produce
    // anything: this is the end of the page and we can say so at once.
    scrollable: targets.length > 0,
    moved,
  };
};

// Scrolling is not free of consequences even when it gains nothing. Sent to
// the bottom of a Wikipedia article, the sticky table of contents collapses
// and the page loses 216 lines — content the reader had and did not ask to
// give up. So a scroll that produced nothing is put back.
const RESTORE_SCROLL = () => {
  const undo = window.__twebScrollUndo;
  if (!undo) return false;
  for (const entry of undo) {
    try { entry.el.scrollTop = entry.top; } catch { /* detached since */ }
  }
  window.__twebScrollUndo = null;
  return true;
};

async function loadMore(state, page) {
  if (state.loadingMore) return;
  state.loadingMore = true;
  // Hold off the live refresh: the page is about to mutate heavily, and a
  // rebuild landing in the middle of this one would fight with it.
  const wasRefreshing = state.live.refreshing;
  state.live.refreshing = true;
  setStatus(state, 'Loading more…');

  const t0 = Date.now();
  const linesBefore = state.lines.length;
  let grew = false;
  let probe = null;

  try {
    probe = await page.evaluate(SCROLL_TO_BOTTOM);
    if (probe.scrollable) {
      try {
        await page.waitForFunction(
          (n) => document.getElementsByTagName('*').length > n,
          probe.elements,
          { timeout: probe.moved ? LOAD_MORE_TIMEOUT_MS : LOAD_MORE_SETTLED_MS, polling: 250 },
        );
        grew = true;
      } catch {
        grew = false; // nothing arrived; this really is the end
      }
    }
  } catch (err) {
    state.loadingMore = false;
    state.live.refreshing = wasRefreshing;
    setStatus(state, 'Could not ask the page for more.');
    log('loadmore.error', { error: String(err.message || err).slice(0, 160) });
    return;
  }

  // Nothing arrived, so there is nothing to rebuild — and a rebuild here
  // does not merely cost a snapshot for no gain, it can lose content: put
  // the scroll back and leave the buffer alone.
  if (!grew) {
    await page.evaluate(RESTORE_SCROLL).catch(() => {});
    state.loadingMore = false;
    state.live.refreshing = wasRefreshing;
    log('loadmore', { ms: Date.now() - t0, grew, scrollable: probe.scrollable, added: 0, lines: state.lines.length });
    setStatus(state, 'End of page.');
    return;
  }

  const screen = screenBefore(state);
  const previousTexts = state.blocks.map((b) => b.text);
  const anchor = anchorFor(state);

  try {
    await refresh(state, page);
  } catch (err) {
    log('loadmore.error', { error: String(err.message || err).slice(0, 160) });
  }
  restoreCursorAfterRebuild(state, previousTexts, anchor);

  const added = state.lines.length - linesBefore;
  state.live.lastPulseMs = 0; // the fingerprint is stale now; re-baseline it
  state.live.refreshing = wasRefreshing;
  state.loadingMore = false;

  repaintList(state, page, screen);
  log('loadmore', { ms: Date.now() - t0, grew, added, lines: state.lines.length });

  if (added > 0) {
    // The reader asked to move down, so move down — onto the first of what
    // just arrived, which is where they were headed.
    moveSelection(state, state.cursor + 1, page);
    setStatus(state, `${added} more line${added === 1 ? '' : 's'}.`);
  } else {
    // The page grew but said nothing worth reading: trackers, a spinner.
    setStatus(state, 'Nothing more to read.');
  }
}

function atEnd(state) {
  return state.cursor >= state.lines.length - 1;
}

// A steady tick, deliberately not a debounce. Under continuous mutation a
// debounced timer is reset before it ever fires, so refreshes never happen at
// all — which is exactly what a page with a clock produces.
// Notices a page that changed without telling anyone, and revives the
// observer if the document it was watching has been replaced.
// A pulse that found nothing is the normal case and not worth a line each
// second; one that found something, or was slow enough to be worth knowing
// about on this page, is.
async function pulseLive(state, page) {
  // A tab can go away underneath the reader: the page closes itself, or it is
  // closed in the browser. The buffer then describes a tab that no longer
  // exists and every command against it fails, so move to one that does.
  if (page.isClosed && page.isClosed()) {
    const remaining = state.core.tabs().filter((other) => other !== page);
    if (!remaining.length) {
      setStatus(state, 'The last tab closed.');
      return;
    }
    log('tab.closed', { remaining: remaining.length });
    await switchToTab(state, remaining[remaining.length - 1], { note: 'That tab closed' });
    return;
  }

  const result = await pulse(page, state.live);
  if (result && (result.changed || result.navigated || result.rearmed || result.ms > 50)) {
    log('live.pulse', result);
  }
  // A pulse that cannot run at all is worth knowing about: it is the safety
  // net, and a silent one is no net.
  if (state.live.pulseErrors) {
    count('pulseErrors', state.live.pulseErrors);
    state.live.pulseErrors = 0;
  }
}

function startLiveTicker(state, page) {
  if (state.live.ticker) return;
  state.live.ticker = setInterval(() => {
    // state.page rather than the page this was started for: the reader can
    // move to another tab, and the ticker has to follow them there.
    pulseLive(state, state.page).catch(() => {});
    runLiveRefresh(state, state.page).catch(() => {});
  }, TICK_MS);
  if (state.live.ticker.unref) state.live.ticker.unref();
  log('live.ticker.start', { everyMs: TICK_MS });
}

async function attachLive(state, page) {
  log('live.attach', await state.core.attachLive(page, (payload) => onLiveEvent(state, page, payload)));
  startLiveTicker(state, page);
}

// Records which parts of the page changed as a result of an action, so a
// button that updates something far from the cursor is not silent.
function noteChanges(state, previousTexts) {
  return state.core.noteChanges(previousTexts);
}

function jumpToChange(state, page, direction = 1) {
  if (!state.changes || state.changes.length === 0) {
    setStatus(state, 'No recorded changes.');
    return;
  }
  const count = state.changes.length;
  state.changeIndex = (state.changeIndex + direction + count) % count;
  const region = state.changes[state.changeIndex];
  const lineIndex = state.lines.findIndex((l) => l.blockIndex === region.start);
  if (lineIndex < 0) {
    setStatus(state, 'Changed area is no longer present.');
    return;
  }
  moveSelection(state, lineIndex, page, 0);
  const size = region.end - region.start + 1;
  setStatus(state, `Change ${state.changeIndex + 1} of ${count} (${size} line${size === 1 ? '' : 's'}).`);
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

async function handleBrowseKey(chunk, state, page) {
  markInput(state);
  if (chunk === CTRL_C || chunk === 'q') return 'quit';

  if (chunk === CTRL_L) {
    state.mode = 'address';
    state.address = { text: page.url(), caret: page.url().length, scroll: 0 };
    drawHint(state);
    drawAddress(state, page, { force: true });
    return;
  }

  if (chunk === 'r') {
    const previous = state.blocks.map((b) => b.text);
    const anchor = anchorFor(state);
    const screen = screenBefore(state);
    await refresh(state, page, { anchor });
    noteChanges(state, previous);
    repaintList(state, page, screen);
    setStatus(state, 'Rescanned.');
    return;
  }

  // Cycle views, keeping the reader on the same content.
  //
  // The place is taken before the switch and put back after it, by element
  // rather than by line number: the same page is 135 lines of accessibility
  // tree and 1500 lines of markup, so nothing about a line number survives
  // the crossing. Where the element cannot be matched — Playwright's
  // accessibility tree has no element references to match against — the
  // reader is told their place could not be kept rather than left to work
  // out why they are somewhere else.
  if (chunk === '\\') {
    const anchor = anchorFor(state);
    const place = await withTimeout(
      capturePlace(state, (item) => state.core.handleFor(item, page)),
      ACTION_TIMEOUT_MS, 'Marking your place',
    ).catch(() => null);

    const cycle = state.sources;
    state.source = cycle[(cycle.indexOf(state.source) + 1) % cycle.length];
    await refresh(state, page);

    const kept = await withTimeout(
      restorePlace(state, page, place), ACTION_TIMEOUT_MS, 'Finding your place',
    ).catch(() => null);
    if (!kept) restoreAnchor(state, anchor);
    clampCol(state);
    clampScroll(state);

    render(state, page);
    setStatus(state, kept === 'exact' || (!place && !kept)
      ? `${SOURCE_LABELS[state.source]} view.`
      : `${SOURCE_LABELS[state.source]} view — nearest place.`);
    return;
  }

  // Moving past the last line is how the reader asks a feed for more.
  if (chunk === ARROW_DOWN || chunk === 'j') {
    if (atEnd(state)) return loadMore(state, page);
    return moveSelection(state, state.cursor + 1, page);
  }
  if (chunk === ARROW_UP || chunk === 'k') return moveSelection(state, state.cursor - 1, page);
  if (chunk === ARROW_RIGHT) return moveCaretRight(state, page);
  if (chunk === ARROW_LEFT) return moveCaretLeft(state, page);
  if (chunk === PAGE_DOWN) {
    if (atEnd(state)) return loadMore(state, page);
    return moveSelection(state, state.cursor + viewportHeight(), page);
  }
  if (chunk === PAGE_UP) return moveSelection(state, state.cursor - viewportHeight(), page);
  if (chunk === 'g') return moveSelection(state, 0, page);
  if (chunk === 'G') return moveSelection(state, state.lines.length - 1, page);
  if (chunk === HOME_KEY) return moveSelection(state, state.cursor, page, 0);
  if (chunk === END_KEY) {
    const line = currentLine(state);
    return moveSelection(state, state.cursor, page, line ? line.text.length - 1 : 0);
  }

  if (chunk === '>') return cycleTab(state, 1);
  if (chunk === '<') return cycleTab(state, -1);
  if (CLOSE_TAB_KEYS.has(chunk)) return closeCurrentTab(state);

  if (chunk === 'c') return jumpToChange(state, page, 1);
  if (chunk === 'C') return jumpToChange(state, page, -1);

  if (chunk === '=') {
    const block = currentBlock(state);
    const total = state.lines.length;
    const role = block && block.item ? block.item.role : 'nothing';
    setStatus(state, `Line ${state.cursor + 1} of ${total}, column ${state.col + 1} — ${role}.`);
    return;
  }

  // A page that updates itself is not always welcome: a clock or a ticker
  // would keep marking changes while you are trying to read something else.
  if (chunk === 'L') {
    state.live.enabled = !state.live.enabled;
    setStatus(state, state.live.enabled
      ? 'Live updates on.'
      : 'Live updates off — press r to refresh manually.');
    return;
  }

  if (chunk === 'm') return clickAsHuman(state, page);

  if (chunk === '/' || chunk === '?') {
    state.mode = 'find';
    state.find = { text: '', caret: 0, direction: chunk === '/' ? 1 : -1 };
    drawHint(state);
    drawFind(state);
    return;
  }

  if (chunk === CTRL_G) {
    if (!state.lastFind) {
      setStatus(state, 'Nothing searched for yet — press / to search.');
      return;
    }
    return runSearch(state, page, state.lastFind.text, state.lastFind.direction);
  }

  if (chunk === 'p' || chunk === 'P') {
    const direction = chunk === 'p' ? 1 : -1;
    return jumpTo(state, page, findParagraph(state, direction), 'paragraph', direction);
  }

  if (chunk.length === 1 && QUICK_NAV[chunk.toLowerCase()]) {
    const spec = QUICK_NAV[chunk.toLowerCase()];
    const direction = chunk === chunk.toLowerCase() ? 1 : -1;
    return jumpTo(state, page, findQuickNav(state, spec.match, direction), spec.label, direction);
  }

  if (chunk === '\r' || chunk === '\n') return activateCurrent(state, page);

  // An escape sequence nobody claimed is almost always a key this reader
  // could support and does not recognise from this terminal. Silence gives a
  // blind reader nothing to go on; the log gives the bytes.
  if (chunk.startsWith(ESC)) log('key.unknown', { bytes: JSON.stringify(chunk) });
}

// ---------------------------------------------------------------------------
// Fragment links
//
// "Skip to content" is the first link on most pages and the one a screen
// reader user hits first. It points at a fragment — href="#main-content" —
// and in a graphical browser it scrolls there and moves focus.
//
// Here it did the opposite of what it says. Clicking it changed the URL, so
// activation read that as a navigation, rebuilt the buffer and reset the
// cursor: the reader asked to skip the navigation and was sent to the very
// top of it instead.
//
// The buffer has no notion of document position to jump to — the AX view has
// no node identity at all — so the target is located the way everything else
// here is, by its content: ask the page what text sits at that fragment, and
// find that text in the buffer.
// ---------------------------------------------------------------------------

async function jumpToFragment(state, page, hash) {
  const blockIndex = await state.core.blockAtFragment(hash, page);
  if (blockIndex < 0) return false;

  const line = state.lines.findIndex((l) => l.blockIndex === blockIndex && !l.continuation);
  if (line < 0) return false;

  moveSelection(state, line, page);
  return true;
}

async function activateCurrent(state, page) {
  const item = itemUnderCursor(state);
  if (!item || item.role === 'text') {
    setStatus(state, 'Nothing to activate on this line.');
    return;
  }

  const previousTexts = state.blocks.map((b) => b.text);
  const previousUrl = page.url();
  const anchor = anchorFor(state);
  const screen = screenBefore(state);
  const fragment = LINK_ROLES.has(item.role) ? await state.core.fragmentOf(item, page) : null;

  try {
    setStatus(state, `Activating "${item.name}"...`);
    if (FIELD_ROLES.has(item.role)) {
      const handle = await withTimeout(
        state.core.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating field');
      await withTimeout(handle.evaluate((el) => el.focus()), ACTION_TIMEOUT_MS, 'Focusing field');
      const info = await readFieldState(handle);
      state.mode = 'type';
      state.typing = { handle, item, text: info.text, caret: info.caret };
      drawHint(state);
      writeLine(lineRow(state, state.cursor), typingText(state).text);
      setStatus(state, `Typing into "${item.name}" — Esc to stop, Enter to submit.`);
      return;
    }

    const done = await state.core.activate(item, page);
    state.statusMsg = done.status || `Activated: ${item.name}`;
  } catch (err) {
    const timedOut = err instanceof ActionTimeout;
    setStatus(state, timedOut
      ? `Gave up activating "${item.name}" after ${ACTION_TIMEOUT_MS / 1000}s — it may be inside a bot check or an unreachable frame.`
      : `Error activating "${item.name}": ${err.message.split('\n')[0]}`);
    log('activate.failed', { name: String(item.name).slice(0, 80), timedOut, source: state.source });
    return;
  }

  // A fragment link never left the document, whatever it did to the URL, so
  // the buffer still stands and the reader keeps their place — until we move
  // them deliberately, to where the link actually points.
  if (fragment) {
    await refresh(state, page, { anchor });
    repaintList(state, page, screen);
    const jumped = await jumpToFragment(state, page, fragment);
    log('activate.fragment', { hash: fragment.slice(0, 60), jumped });
    setStatus(state, jumped
      ? `Moved to ${fragment}.`
      : `"${item.name}" points at ${fragment}, which is not in this view.`);
    return;
  }

  await reportAfterAction(state, page, { previousTexts, previousUrl, anchor, screen });
}

// What happened after something was pressed: a different page, a part of this
// one rewritten, or nothing at all. Nothing here moves the reader unless the
// page did — a rebuilt buffer keeps their place by content.
async function reportAfterAction(state, page, { previousTexts, previousUrl, anchor, screen = null }) {
  const navigated = page.url() !== previousUrl;
  await refresh(state, page, navigated ? { resetCursor: true } : { anchor });

  const regions = navigated ? [] : noteChanges(state, previousTexts);
  // A different page is a different screen, so there is nothing to compare
  // against and everything to draw. Staying on the same one usually rewrites
  // a line or two.
  if (navigated) render(state, page);
  else repaintList(state, page, screen);

  if (navigated) setStatus(state, state.statusMsg);
  else if (regions.length) {
    setStatus(state, `${state.statusMsg} — ${regions.length} area${regions.length === 1 ? '' : 's'} changed, press c to jump.`);
  } else {
    setStatus(state, `${state.statusMsg} — no visible change.`);
  }
}

// ---------------------------------------------------------------------------
// A click the browser treats as a person's
//
// Enter activates through the DOM's own default action, which is the right
// default for reading: it needs no viewport and it reaches controls that are
// off-screen, which is where skip links and visually hidden controls live.
// What it cannot produce is *user activation*. The browser knows nobody
// touched anything, so everything gated on a real gesture — playing audio,
// fullscreen, the clipboard, opening a window — refuses, and no amount of
// page-side cleverness changes that: the gate exists precisely to tell the
// two apart.
//
// So `m` sends a click through the browser's own input pipeline, above
// content, where the events are trusted and carry activation. It is a
// separate key rather than a smarter Enter because it is a different act with
// different costs: it goes to a point on the screen, so the element has to be
// scrolled into view and whatever is on top of it gets the click. Both are
// checked first and reported instead of being discovered afterwards by
// whatever the click did instead.
// ---------------------------------------------------------------------------

async function clickAsHuman(state, page) {
  const item = itemUnderCursor(state);
  if (!item) {
    setStatus(state, 'Nothing on this line to click.');
    return;
  }
  if (!state.core.canRealClick()) {
    setStatus(state, `The ${state.driver.name} driver cannot send a real click.`);
    return;
  }

  const previousTexts = state.blocks.map((b) => b.text);
  const previousUrl = page.url();
  const anchor = anchorFor(state);
  const screen = screenBefore(state);
  const started = Date.now();

  try {
    setStatus(state, `Clicking "${item.name}" as a person would...`);
    const clicked = await state.core.realClick(item, page);
    if (!clicked.ok) {
      log('click.real.refused', { name: String(item.name).slice(0, 80), reason: clicked.reason });
      setStatus(state, `Cannot click "${item.name}": it ${clicked.reason}.`
        + ' Enter activates it without a real click.');
      return;
    }

    log('click.real', { name: String(item.name).slice(0, 80), ms: Date.now() - started, source: state.source });
    state.statusMsg = `Clicked "${item.name}"`;
  } catch (err) {
    const timedOut = err instanceof ActionTimeout;
    setStatus(state, timedOut
      ? `Gave up clicking "${item.name}" after ${ACTION_TIMEOUT_MS / 1000}s.`
      : `Could not click "${item.name}": ${err.message.split('\n')[0]}`);
    log('click.real.failed', { name: String(item.name).slice(0, 80), timedOut, source: state.source });
    return;
  }

  await reportAfterAction(state, page, { previousTexts, previousUrl, anchor, screen });
}

async function handleTypeKey(chunk, state, page) {
  markInput(state);
  const t = state.typing;
  if (!t) { state.mode = 'browse'; return; }

  if (chunk === ESC) {
    // Captured while the field is still drawn as it is on screen, so the one
    // row that changes — the field, back to its ordinary form — is the one
    // row repainted.
    const screen = screenBefore(state);
    state.mode = 'browse';
    state.typing = null;
    await refresh(state, page, { anchor: anchorFor(state) });
    repaintList(state, page, screen);
    setStatus(state, `Stopped typing into "${t.item.name}".`);
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const previousUrl = page.url();
    const screen = screenBefore(state);
    const anchor = anchorFor(state);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    state.mode = 'browse';
    state.typing = null;

    // A submit that navigated is a new page and there is nothing to keep. One
    // that submitted in place is the same page with a different list on it,
    // and the reader is still standing in the form they just filled in —
    // resetting the cursor there threw them to the top of the document for no
    // reason they could see.
    const navigated = page.url() !== previousUrl;
    await refresh(state, page, navigated ? { resetCursor: true } : { anchor });
    if (navigated) render(state, page);
    else repaintList(state, page, screen);
    setStatus(state, navigated
      ? `Submitted "${t.item.name}" — loaded ${page.url()}`
      : `Submitted "${t.item.name}".`);
    return;
  }

  if (chunk === BACKSPACE || chunk === BACKSPACE_ALT) {
    await page.keyboard.press('Backspace');
    t.caret = Math.max(t.caret - 1, 0);
  } else if (chunk.startsWith(ESC)) {
    return;
  } else {
    await page.keyboard.type(chunk);
    t.caret += chunk.length;
  }

  const info = await readFieldState(t.handle);
  t.text = info.text;
  t.caret = info.native ? info.caret : Math.min(Math.max(t.caret, 0), t.text.length);
  const { text, caretCol } = typingText(state);
  const row = lineRow(state, state.cursor);
  writeLine(row, text);
  moveCursor(row, caretCol);
}

async function handleFindKey(chunk, state, page) {
  markInput(state);
  const find = state.find;

  if (chunk === ESC || chunk === CTRL_C) {
    state.mode = 'browse';
    drawHint(state);
    setStatus(state, 'Search cancelled.');
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    // Nothing typed repeats the last search, in the direction this prompt was
    // opened with — which is the only way to search backwards through what
    // you just found without retyping it.
    const needle = find.text || (state.lastFind ? state.lastFind.text : '');
    state.mode = 'browse';
    drawHint(state);
    if (!needle) {
      setStatus(state, 'Nothing searched for yet — type what to find.');
      return;
    }
    state.lastFind = { text: needle, direction: find.direction };
    return runSearch(state, page, needle, find.direction);
  }

  if (chunk === ARROW_LEFT) find.caret = Math.max(0, find.caret - 1);
  else if (chunk === ARROW_RIGHT) find.caret = Math.min(find.text.length, find.caret + 1);
  else if (chunk === HOME_KEY) find.caret = 0;
  else if (chunk === END_KEY) find.caret = find.text.length;
  else if (chunk === BACKSPACE || chunk === BACKSPACE_ALT) {
    if (find.caret > 0) {
      find.text = find.text.slice(0, find.caret - 1) + find.text.slice(find.caret);
      find.caret -= 1;
    }
  } else if (!chunk.startsWith(ESC)) {
    find.text = find.text.slice(0, find.caret) + chunk + find.text.slice(find.caret);
    find.caret += chunk.length;
  }

  drawFind(state);
}

async function handleAddressKey(chunk, state, page) {
  markInput(state);
  const a = state.address;

  if (chunk === ESC) {
    state.mode = 'browse';
    drawHint(state);
    drawAddress(state, page, { force: true });
    parkCursor(state);
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const target = a.text.trim();
    state.mode = 'browse';
    drawHint(state);
    if (!target) { drawAddress(state, page, { force: true }); parkCursor(state); return; }
    const url = /^[a-zA-Z][\w+.-]*:/.test(target) ? target : `https://${target}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await refresh(state, page, { resetCursor: true });
      render(state, page, { force: true });
      setStatus(state, `Loaded ${page.url()}`);
    } catch (err) {
      drawAddress(state, page, { force: true });
      setStatus(state, `Could not load ${url}: ${err.message.split('\n')[0]}`);
    }
    return;
  }

  if (chunk === ARROW_LEFT) a.caret = Math.max(0, a.caret - 1);
  else if (chunk === ARROW_RIGHT) a.caret = Math.min(a.text.length, a.caret + 1);
  else if (chunk === HOME_KEY) a.caret = 0;
  else if (chunk === END_KEY) a.caret = a.text.length;
  else if (chunk === BACKSPACE || chunk === BACKSPACE_ALT) {
    if (a.caret > 0) {
      a.text = a.text.slice(0, a.caret - 1) + a.text.slice(a.caret);
      a.caret -= 1;
    }
  } else if (chunk === CTRL_L) {
    a.text = '';
    a.caret = 0;
  } else if (!chunk.startsWith(ESC)) {
    a.text = a.text.slice(0, a.caret) + chunk + a.text.slice(a.caret);
    a.caret += chunk.length;
  }

  drawAddress(state, page, { force: true });
}

// ---------------------------------------------------------------------------

async function main() {
  log('start', {
    url: START_URL, logPath: LOG_PATH, connect: ARGS.connect || null, engine: ARGS.engine,
  });

  // Either attach to a browser the user is already running, or start an
  // ordinary one ourselves. There is deliberately no Playwright-launched
  // fallback: that browser announces itself as automated, and sites that
  // react to it leave the reader stuck on pages that never resolve.
  const driver = await timed('browser.start', { engine: ARGS.engine }, () =>
    openDriver({
      engine: ARGS.engine,
      connect: ARGS.connect,
      profile: ARGS.profile,
      keepBrowser: ARGS.keepBrowser,
      log,
    }));
  setCurrentDriver(driver);
  const { browser, context } = driver;
  const browserPort = driver.port;
  const rejoined = driver.rejoined;

  // When joining a browser that is already running, take over the tab it is
  // already showing rather than opening a blank one. Rejoining is usually
  // about reaching something already on screen — a video that is playing, a
  // form half filled in — and a fresh tab would hide exactly that.
  //
  // Never a tab another session is reading, though: two sessions on one tab
  // navigate each other around. Those are skipped, and if every candidate is
  // taken we open our own tab instead.
  let page = null;
  if (rejoined && !ARGS.url) {
    const taken = claimedTargets(browserPort);
    const existing = context.pages().filter((p) => {
      const url = p.url();
      return url && url !== 'about:blank';
    });
    for (let i = existing.length - 1; i >= 0; i -= 1) {
      const candidate = existing[i];
      const targetId = await driver.targetIdFor(candidate);
      if (targetId && taken.has(targetId)) continue;
      page = candidate;
      break;
    }
    if (page) log('page.adopt', { url: page.url().slice(0, 120), of: existing.length, taken: taken.size });
    else if (existing.length) log('page.adopt.none', { of: existing.length, taken: taken.size });
  }

  const adopted = !!page;
  if (!page) page = await context.newPage();

  const sources = ALL_SOURCES.filter((s) => s !== 'ax' || driver.capabilities?.ax !== false);
  const core = new Core({ driver, page, source: sources[0], sources, browserPort });
  // Claim whichever tab we ended up on, including one we just opened and one
  // in a browser we started: the session that joins later is the one that
  // needs to know to leave it alone.
  await core.adoptTab(page);
  if (!adopted) {
    await timed('goto', { url: START_URL }, () =>
      page.goto(START_URL, { waitUntil: 'domcontentloaded' }));
  }
  await core.rescan();
  const state = {
    core,
    sources,
    browserPort,
    // Nothing may follow a tab until the first page is drawn: the browser
    // reports the tab we open ourselves at startup as new, like any other.
    ready: false,
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    statusMsg: '',
    mode: 'browse', // 'browse' | 'type' | 'address' | 'find'
    typing: null,
    address: null,
    find: null,
    lastFind: null,
    drawn: { address: null, hint: null },
    statusHeldUntil: 0,
    loadingMore: false,
  };
  // The reader still reaches these through `state`, because the four hundred
  // places in this file that say `state.blocks` are not what the split is
  // about — but the core is what owns them. Reading and writing through to it
  // keeps one copy of the buffer while the rest of the reader moves across at
  // its own pace, and every one of these names is a line of the protocol a
  // second front end would speak.
  for (const key of ['driver', 'page', 'source', 'blocks', 'changes', 'changeIndex', 'renderedUrl', 'live']) {
    Object.defineProperty(state, key, {
      get: () => core[key],
      set: (value) => { core[key] = value; },
      enumerable: true,
      configurable: true,
    });
  }

  relayout(state);

  setupRawInput();
  process.stdout.write('\x1b[2J');
  render(state, page, { force: true });

  await attachLive(state, page);
  attachedPages.add(page);
  state.ready = true;
  driver.onNewTab((opened) => { onNewTab(state, opened).catch(() => {}); });
  // Re-arm only when the main document itself is replaced. Reacting to every
  // frame event would mean a round trip per ad iframe — hundreds of them,
  // queued on the same connection our snapshots use, which is what made
  // snapshots take seconds instead of milliseconds. Same-origin child frames
  // are covered by addInitScript without any per-frame work here.
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    armFrame(frame).catch(() => {});
    onExternalNavigation(state, page).catch(() => {});
  });

  process.stdout.on('resize', () => {
    relayout(state);
    process.stdout.write('\x1b[2J');
    render(state, state.page, { force: true });
  });

  const counterTimer = setInterval(() => {
    flushCounters({
      refreshes: state.live.refreshes, lines: state.lines.length, source: state.source,
    });
  }, 5000);
  if (counterTimer.unref) counterTimer.unref();

  let running = true;
  while (running) {
    const chunk = await readKey();
    markInput(state);

    const t0 = Date.now();
    let result;
    // state.page, not the page this loop began with: `<` and `>` move the
    // reader between tabs and every handler must act on the one they are on.
    const current = state.page;
    if (state.mode === 'type') result = await handleTypeKey(chunk, state, current);
    else if (state.mode === 'address') result = await handleAddressKey(chunk, state, current);
    else if (state.mode === 'find') result = await handleFindKey(chunk, state, current);
    else result = await handleBrowseKey(chunk, state, current);
    const ms = Date.now() - t0;

    markInput(state);
    // Only slow keys are worth a line each; movement is the common case and
    // would otherwise flood the log.
    if (ms >= 20) {
      log('key', { key: JSON.stringify(chunk).slice(0, 20), mode: state.mode, ms, cursor: state.cursor });
    } else {
      count('fastKeys');
    }

    if (result === 'quit') { running = false; break; }
  }

  clearInterval(counterTimer);
  flushCounters({ refreshes: state.live.refreshes });
  log('exit', {});
  releaseTab(browserPort);
  await driver.close();
  restoreTerminal();
  process.exit(0);
}

// A scroll region outlives the process, so leaving one set would give the
// user a terminal that only scrolls in the top few rows.
function restoreTerminal() {
  resetScrollRegion();
  moveCursor(termSize().rows, 1);
  process.stdout.write('\n');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

// The browser has to be told we are leaving, however we leave.
//
// Firefox serves one session at a time and does not end it when a connection
// drops, so a reader that exits without saying so locks out the next one. That
// is recoverable — Marionette can release a stranded session — but recovering
// is not the same as never needing to, and every abnormal exit used to strand
// one: the signal handlers exited without telling the driver, the error path
// printed and exited, and an uncaught exception was not handled at all. A
// crash from a missing method took the shortest route to the worst outcome.
//
// Only SIGKILL, an out-of-memory kill and losing power can get past this now.
const SHUTDOWN_GRACE_MS = 1500;
let shuttingDown = false;

async function shutdown(code, driver) {
  // A second Ctrl-C must not restart the wait, and must still get you out.
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  restoreTerminal();
  if (driver) {
    // Bounded: a browser that will not answer must not keep the terminal.
    await Promise.race([
      driver.close().catch(() => {}),
      new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS)),
    ]);
  }
  process.exit(code);
}

if (require.main === module) {
  // Set as soon as the driver exists, so a crash during startup still tidies
  // up whatever was already opened.
  let openDriverRef = null;
  setCurrentDriver = (driver) => { openDriverRef = driver; };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { shutdown(0, openDriverRef).catch(() => process.exit(0)); });
  }

  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      restoreTerminal();
      log('crash', { event, error: String(err && err.message ? err.message : err).slice(0, 300) });
      console.error(err);
      shutdown(1, openDriverRef).catch(() => process.exit(1));
    });
  }

  main().catch((err) => {
    console.error(err);
    shutdown(1, openDriverRef).catch(() => process.exit(1));
  });
}

module.exports = {
  handleBrowseKey, handleTypeKey, handleAddressKey, handleFindKey,
  findText, runSearch,
  render, drawList, drawAddress, drawHint, moveSelection,
  moveCaretLeft, moveCaretRight, lineRow, relayout, viewportHeight,
  itemUnderCursor, findQuickNav, findParagraph, currentLine, currentBlock,
  clickAsHuman, reportAfterAction,
  anchorFor, restoreAnchor, capturePlace, restorePlace, jumpToChange, activateCurrent, ALL_SOURCES,
  attachLive, onLiveEvent, runLiveRefresh, patchVisibleRows, reanchorQuietly,
  screenBefore, repaintList, visibleRowsNow,
  applyTextPatches, loadMore, atEnd, switchToTab, cycleTab, closeCurrentTab, onNewTab,
  sameDocumentFragment, findBlockWithText, jumpToFragment,
  renderRow, parseArgs, onExternalNavigation,
};
