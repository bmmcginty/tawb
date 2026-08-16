#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
const { FIELD_ROLES, LINK_ROLES, BUTTON_ROLES } = require('./aria');
const { itemAtOffset } = require('./blocks');
const { activateDomItem, domElementHandle } = require('./dom');
const { renderElementHandle } = require('./render_html');
const { snapshotFrameTree } = require('./frames');
const { installLive, armFrame, refreshDue, createLiveState, TICK_MS } = require('./live');
const { log, timed, count, flushCounters, LOG_PATH } = require('./log');
const { layoutLines } = require('./layout');

const START_URL = process.argv[2] || 'https://www.google.com';

const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_L = '\x0c';
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

// The three views of a page, cycled by backslash.
const SOURCES = ['ax', 'render', 'html'];
const SOURCE_LABELS = { ax: 'AX', render: 'PAGE', html: 'HTML' };

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

async function snapshotBlocks(page, source = 'ax') {
  const t0 = Date.now();
  const blocks = await snapshotFrameTree(page, source);
  log('snapshot', { source, ms: Date.now() - t0, blocks: blocks.length, frames: page.frames().length });
  return blocks;
}

// Reads the field's live text + caret straight from the DOM. Real
// <input>/<textarea> elements expose selectionStart, which is the source of
// truth (handles autoformatting, IME, etc.). contenteditable/custom widgets
// don't, so we fall back to textContent and track the caret locally.
//
// Takes an ElementHandle, not a Locator: a locator re-resolves by role+name
// on every call, and a field's accessible name can change while you type
// (Wikipedia's search box renames itself once suggestions open), which makes
// the locator stop matching mid-edit.
async function readFieldState(handle) {
  return handle.evaluate((el) => {
    if ('value' in el && typeof el.value === 'string') {
      return {
        text: el.value,
        caret: el.selectionStart != null ? el.selectionStart : el.value.length,
        native: true,
      };
    }
    const text = el.textContent || '';
    return { text, caret: text.length, native: false };
  });
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
  return 'j/k line  h/l/f/b/n/p nav  \\ view  ^L address  c changes  L live  q quit';
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
// Snapshot refresh, view switching, change tracking
// ---------------------------------------------------------------------------

// Remembers where the reader is by content, not by index. Line counts differ
// wildly between the three views, so an index would land somewhere arbitrary;
// matching the text puts you on the same thing you were reading.
// Identity of the element behind a block, where the view has one. The
// DOM-derived views number the nodes they walk, which survives a re-snapshot
// as long as the document structure has not shifted — far stronger evidence
// than the block's text, which is routinely duplicated.
function identityOf(block) {
  if (!block || !block.item) return null;
  const index = block.item.domIndex != null ? block.item.domIndex : block.item.renderIndex;
  if (index == null) return null;
  const frameUrl = block.item.frame ? block.item.frame.url() : '';
  return `${frameUrl}#${index}`;
}

function anchorFor(state) {
  const block = currentBlock(state);
  return {
    text: block ? block.text : '',
    name: block && block.item ? block.item.name : '',
    identity: identityOf(block),
    line: state.cursor,
    // Snapshot of the neighbouring lines, used to tell repeated text apart.
    context: Array.from(
      { length: CONTEXT_RADIUS * 2 + 1 },
      (_, i) => lineText(state, state.cursor + i - CONTEXT_RADIUS),
    ),
    ratio: state.lines.length ? state.cursor / state.lines.length : 0,
  };
}

function restoreAnchor(state, anchor) {
  if (!anchor) return;
  const needle = (anchor.name || anchor.text || '').trim();

  if (needle) {
    const exact = state.lines.findIndex((l) => !l.continuation && state.blocks[l.blockIndex].text === anchor.text);
    if (exact >= 0) { state.cursor = exact; state.col = 0; clampScroll(state); return; }

    const partial = state.lines.findIndex((l) => !l.continuation && l.text.includes(needle));
    if (partial >= 0) { state.cursor = partial; state.col = 0; clampScroll(state); return; }
  }

  state.cursor = Math.min(
    Math.round(anchor.ratio * state.lines.length),
    Math.max(state.lines.length - 1, 0),
  );
  state.col = 0;
  clampScroll(state);
}

async function refresh(state, page, { resetCursor = false, anchor = null } = {}) {
  const started = Date.now();
  state.blocks = await snapshotBlocks(page, state.source);
  if (state.live) state.live.snapshotCostMs = Date.now() - started;
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
const REANCHOR_WINDOW = 250;
const CONTEXT_RADIUS = 3;

function reanchorQuietly(state, anchor) {
  if (!anchor) return;

  const settle = () => {
    state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(state.lines.length - 1, 0));
    clampCol(state);
    clampScroll(state);
  };

  if (anchor.identity != null) {
    const found = state.lines.findIndex(
      (l) => !l.continuation && identityOf(state.blocks[l.blockIndex]) === anchor.identity);
    // Node numbering comes from walk order, so inserting an element earlier
    // in the document renumbers everything after it and the same number can
    // name a different node. Trust the match only when a second signal
    // agrees: the text is unchanged, or it is somewhere plausibly nearby.
    if (found >= 0) {
      const sameText = state.blocks[state.lines[found].blockIndex].text === anchor.text;
      if (sameText || Math.abs(found - anchor.line) <= REANCHOR_WINDOW) {
        state.cursor = found;
        settle();
        return;
      }
    }
  }

  const start = Math.min(Math.max(anchor.line, 0), Math.max(state.lines.length - 1, 0));

  // Matching a single line is not enough when the text repeats — a page of
  // <option value=30> entries offers dozens of equally good candidates. The
  // neighbours disambiguate: the right one sits in the same surroundings it
  // did before, so candidates are scored on how much of their context still
  // agrees, with distance breaking ties.
  let best = null;

  for (let distance = 0; distance <= REANCHOR_WINDOW; distance += 1) {
    const candidates = distance === 0 ? [start] : [start - distance, start + distance];
    for (const index of candidates) {
      const line = state.lines[index];
      if (!line || line.continuation) continue;
      if (state.blocks[line.blockIndex].text !== anchor.text) continue;

      let score = 0;
      for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
        if (offset === 0) continue;
        const expected = anchor.context[offset + CONTEXT_RADIUS];
        const actual = lineText(state, index + offset);
        if (expected != null && expected === actual) score += 1;
      }

      if (!best || score > best.score) best = { index, score };
      if (best.score === CONTEXT_RADIUS * 2) break; // perfect context, done
    }
    if (best && best.score === CONTEXT_RADIUS * 2) break;
  }

  if (best) { state.cursor = best.index; settle(); return; }

  // Nothing matched by text — which is the normal case for a line whose own
  // content is what changed. A clock rewrites itself every second, so its
  // text is never the text we anchored on, yet its neighbours are unchanged.
  // Locate it by surroundings alone, ignoring the centre line. Without this,
  // reading a clock while lines shift above it leaves the cursor sitting on
  // whatever slid into that index.
  const MIN_CONTEXT_SCORE = 3;
  let byContext = null;

  for (let distance = 0; distance <= REANCHOR_WINDOW; distance += 1) {
    const candidates = distance === 0 ? [start] : [start - distance, start + distance];
    for (const index of candidates) {
      const line = state.lines[index];
      if (!line || line.continuation) continue;

      let score = 0;
      for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
        if (offset === 0) continue;
        const expected = anchor.context[offset + CONTEXT_RADIUS];
        if (expected && expected === lineText(state, index + offset)) score += 1;
      }

      if (score >= MIN_CONTEXT_SCORE && (!byContext || score > byContext.score)) {
        byContext = { index, score };
      }
      if (byContext && byContext.score === CONTEXT_RADIUS * 2) break;
    }
    if (byContext && byContext.score === CONTEXT_RADIUS * 2) break;
  }

  if (byContext) state.cursor = byContext.index;
  settle();
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

async function runLiveRefresh(state, page) {
  const live = state.live;
  if (!refreshDue(live)) return;

  const cycle = Date.now();
  live.refreshing = true;
  live.refreshes += 1;

  const tPrep = Date.now();
  const previousLines = state.lines.map((_, i) => renderRow(state, i));
  const previousTexts = state.blocks.map((b) => b.text);
  const anchor = anchorFor(state);
  const prepMs = Date.now() - tPrep;

  try {
    await refresh(state, page);
  } catch (err) {
    live.refreshing = false;
    log('live.refresh.error', { error: String(err.message || err).slice(0, 160) });
    return;
  }

  const tPost = Date.now();
  reanchorQuietly(state, anchor);
  const reanchorMs = Date.now() - tPost;

  const tDiff = Date.now();
  const regions = diffBlocks(previousTexts, state.blocks);
  if (regions.length) {
    state.changes = regions;
    state.changeIndex = -1;
  }
  const diffMs = Date.now() - tDiff;

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
    lines: state.lines.length,
    changedRegions: regions.length,
    cursor: state.cursor,
  });
}

function onLiveEvent(state, page, payload) {
  const live = state.live;
  if (!payload) return;
  live.notifies += 1;
  count('mutations', payload.mutations || 0);
  count('notifies');

  if (!live.enabled) return;

  for (const item of payload.announcements || []) announce(state, item);

  live.mutations += payload.mutations || 0;
  live.dirty = true;
}

// A steady tick, deliberately not a debounce. Under continuous mutation a
// debounced timer is reset before it ever fires, so refreshes never happen at
// all — which is exactly what a page with a clock produces.
function startLiveTicker(state, page) {
  if (state.live.ticker) return;
  state.live.ticker = setInterval(() => {
    runLiveRefresh(state, page).catch(() => {});
  }, TICK_MS);
  if (state.live.ticker.unref) state.live.ticker.unref();
  log('live.ticker.start', { everyMs: TICK_MS });
}

async function attachLive(state, page) {
  const t0 = Date.now();
  const info = await installLive(page, (payload) => onLiveEvent(state, page, payload));
  log('live.attach', { ms: Date.now() - t0, ...info });
  startLiveTicker(state, page);
}

// Records which parts of the page changed as a result of an action, so a
// button that updates something far from the cursor is not silent.
function diffBlocks(previousTexts, blocks) {
  const before = new Set(previousTexts);
  const changed = [];
  blocks.forEach((block, index) => {
    if (!before.has(block.text)) changed.push(index);
  });

  // Collapse consecutive indices into regions; one edit usually replaces a
  // run of lines and should be reported as a single place to go.
  const regions = [];
  for (const index of changed) {
    const last = regions[regions.length - 1];
    if (last && index === last.end + 1) last.end = index;
    else regions.push({ start: index, end: index });
  }
  return regions;
}

function noteChanges(state, previousTexts) {
  const regions = diffBlocks(previousTexts, state.blocks);
  state.changes = regions;
  state.changeIndex = -1;
  return regions;
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
    await refresh(state, page, { anchor });
    noteChanges(state, previous);
    render(state, page);
    setStatus(state, 'Rescanned.');
    return;
  }

  // Cycle views, keeping the reader on the same content.
  if (chunk === '\\') {
    const anchor = anchorFor(state);
    state.source = SOURCES[(SOURCES.indexOf(state.source) + 1) % SOURCES.length];
    await refresh(state, page, { anchor });
    render(state, page);
    setStatus(state, `${SOURCE_LABELS[state.source]} view.`);
    return;
  }

  if (chunk === ARROW_DOWN || chunk === 'j') return moveSelection(state, state.cursor + 1, page);
  if (chunk === ARROW_UP || chunk === 'k') return moveSelection(state, state.cursor - 1, page);
  if (chunk === ARROW_RIGHT) return moveCaretRight(state, page);
  if (chunk === ARROW_LEFT) return moveCaretLeft(state, page);
  if (chunk === PAGE_DOWN) return moveSelection(state, state.cursor + viewportHeight(), page);
  if (chunk === PAGE_UP) return moveSelection(state, state.cursor - viewportHeight(), page);
  if (chunk === 'g') return moveSelection(state, 0, page);
  if (chunk === 'G') return moveSelection(state, state.lines.length - 1, page);
  if (chunk === HOME_KEY) return moveSelection(state, state.cursor, page, 0);
  if (chunk === END_KEY) {
    const line = currentLine(state);
    return moveSelection(state, state.cursor, page, line ? line.text.length - 1 : 0);
  }

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
}

async function elementHandleFor(state, page, item) {
  if (state.source === 'html') return domElementHandle(page, item);
  if (state.source === 'render') return renderElementHandle(page, item);
  const scope = item.frame || page;
  return scope.getByRole(item.role, { name: item.name, exact: true }).first().elementHandle();
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

  try {
    if (FIELD_ROLES.has(item.role)) {
      const handle = await elementHandleFor(state, page, item);
      await handle.evaluate((el) => el.focus());
      const info = await readFieldState(handle);
      state.mode = 'type';
      state.typing = { handle, item, text: info.text, caret: info.caret };
      drawHint(state);
      writeLine(lineRow(state, state.cursor), typingText(state).text);
      setStatus(state, `Typing into "${item.name}" — Esc to stop, Enter to submit.`);
      return;
    }

    if (state.source === 'html') {
      state.statusMsg = await activateDomItem(page, item);
    } else {
      // Activate through the DOM's own default action rather than a
      // mouse-coordinate click: a blind user has no viewport, and legitimate
      // targets (skip links, visually hidden controls) sit off-screen.
      const handle = await elementHandleFor(state, page, item);
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        handle.evaluate((el) => el.click()),
      ]);
      state.statusMsg = `Activated: ${item.name}`;
    }
  } catch (err) {
    setStatus(state, `Error activating "${item.name}": ${err.message.split('\n')[0]}`);
    return;
  }

  const navigated = page.url() !== previousUrl;
  await refresh(state, page, navigated ? { resetCursor: true } : { anchor });

  const regions = navigated ? [] : noteChanges(state, previousTexts);
  render(state, page);

  if (navigated) setStatus(state, state.statusMsg);
  else if (regions.length) {
    setStatus(state, `${state.statusMsg} — ${regions.length} area${regions.length === 1 ? '' : 's'} changed, press c to jump.`);
  } else {
    setStatus(state, `${state.statusMsg} — no visible change.`);
  }
}

async function handleTypeKey(chunk, state, page) {
  const t = state.typing;
  if (!t) { state.mode = 'browse'; return; }

  if (chunk === ESC) {
    state.mode = 'browse';
    state.typing = null;
    await refresh(state, page, { anchor: anchorFor(state) });
    render(state, page);
    setStatus(state, `Stopped typing into "${t.item.name}".`);
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const previousUrl = page.url();
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    state.mode = 'browse';
    state.typing = null;
    await refresh(state, page, { resetCursor: true });
    render(state, page);
    setStatus(state, page.url() === previousUrl
      ? `Submitted "${t.item.name}".`
      : `Submitted "${t.item.name}" — loaded ${page.url()}`);
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

async function handleAddressKey(chunk, state, page) {
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

// Headless Chrome announces itself as "HeadlessChrome" in the User-Agent,
// and bot protection (Cloudflare among others) blocks on that token alone —
// timeanddate.com answers 403 "Just a moment..." with it and 200 without.
// Nothing else about the automation needs hiding for that check: it still
// passes with navigator.webdriver set to true. Deriving the string from the
// browser's own UA keeps it correct across Chrome versions and platforms.
async function openContext(browser) {
  const probe = await browser.newContext();
  const probePage = await probe.newPage();
  const ua = await probePage.evaluate(() => navigator.userAgent);
  await probe.close();

  return browser.newContext({
    userAgent: ua.replace('HeadlessChrome', 'Chrome'),
  });
}

async function main() {
  log('start', { url: START_URL, logPath: LOG_PATH });
  const browser = await timed('browser.launch', {}, () => chromium.launch({ headless: true }));
  const context = await timed('context.open', {}, () => openContext(browser));
  const page = await context.newPage();
  await timed('goto', { url: START_URL }, () =>
    page.goto(START_URL, { waitUntil: 'domcontentloaded' }));

  const state = {
    page,
    source: 'ax',
    blocks: await snapshotBlocks(page, 'ax'),
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    statusMsg: '',
    mode: 'browse', // 'browse' | 'type' | 'address'
    typing: null,
    address: null,
    changes: [],
    changeIndex: -1,
    drawn: { address: null, hint: null },
    live: createLiveState(),
    statusHeldUntil: 0,
  };
  relayout(state);

  setupRawInput();
  process.stdout.write('\x1b[2J');
  render(state, page, { force: true });

  await attachLive(state, page);
  // Re-arm only when the main document itself is replaced. Reacting to every
  // frame event would mean a round trip per ad iframe — hundreds of them,
  // queued on the same connection our snapshots use, which is what made
  // snapshots take seconds instead of milliseconds. Same-origin child frames
  // are covered by addInitScript without any per-frame work here.
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) armFrame(frame).catch(() => {});
  });

  process.stdout.on('resize', () => {
    relayout(state);
    process.stdout.write('\x1b[2J');
    render(state, page, { force: true });
  });

  const counterTimer = setInterval(() => {
    flushCounters({ refreshes: state.live.refreshes, lines: state.lines.length, source: state.source });
  }, 5000);
  if (counterTimer.unref) counterTimer.unref();

  let running = true;
  while (running) {
    const chunk = await readKey();
    // Recorded before handling so an in-flight refresh yields to input
    // rather than repainting under the reader's hands.
    state.live.lastInputMs = Date.now();

    const t0 = Date.now();
    let result;
    if (state.mode === 'type') result = await handleTypeKey(chunk, state, page);
    else if (state.mode === 'address') result = await handleAddressKey(chunk, state, page);
    else result = await handleBrowseKey(chunk, state, page);
    const ms = Date.now() - t0;

    state.live.lastInputMs = Date.now();
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
  await browser.close();
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

if (require.main === module) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { restoreTerminal(); process.exit(0); });
  }
  main().catch((err) => {
    restoreTerminal();
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  readFieldState, handleBrowseKey, handleTypeKey, handleAddressKey,
  render, drawList, drawAddress, drawHint, snapshotBlocks, moveSelection,
  moveCaretLeft, moveCaretRight, lineRow, relayout, viewportHeight,
  itemUnderCursor, findQuickNav, findParagraph, currentLine, currentBlock,
  anchorFor, restoreAnchor, diffBlocks, jumpToChange, activateCurrent, SOURCES,
  attachLive, onLiveEvent, runLiveRefresh, patchVisibleRows, reanchorQuietly,
  renderRow, openContext,
};
