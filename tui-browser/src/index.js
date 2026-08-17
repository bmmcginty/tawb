#!/usr/bin/env node
'use strict';

const { FIELD_ROLES, LINK_ROLES, BUTTON_ROLES } = require('./aria');
const { itemAtOffset } = require('./blocks');
const { activateDomItem, domElementHandle } = require('./dom');
const { renderElementHandle } = require('./render_html');
const { snapshotFrameTree } = require('./frames');
const { installLive, armFrame, armRenderedFrames, refreshDue, createLiveState, pulse, TICK_MS, INPUT_GRACE_MS } = require('./live');
const { log, timed, count, flushCounters, LOG_PATH } = require('./log');
const { layoutLines } = require('./layout');
const { remapIndex } = require('./remap');
const { launchOwnBrowser, connectToBrowser, normaliseEndpoint, defaultProfileDir } = require('./browser');
const { claimedTargets, claimTab, releaseTab } = require('./session');

// --connect <port|host:port|url> attaches to a browser that is already
// running with --remote-debugging-port, rather than launching one.
function parseArgs(argv) {
  const options = { url: null, connect: null, profile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--connect') { options.connect = normaliseEndpoint(argv[i + 1] || ''); i += 1; }
    else if (arg.startsWith('--connect=')) { options.connect = normaliseEndpoint(arg.slice('--connect='.length)); }
    else if (arg === '--profile') { options.profile = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--profile=')) { options.profile = arg.slice('--profile='.length); }
    else if (!arg.startsWith('-') && !options.url) { options.url = arg; }
  }
  return options;
}

const ARGS = parseArgs(process.argv.slice(2));
const START_URL = ARGS.url || 'https://www.google.com';

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
const SOURCES = ['ax', 'render', 'html', 'source'];
const SOURCE_LABELS = { ax: 'AX', render: 'PAGE', html: 'HTML', source: 'SOURCE' };
// The two views built from a DOM walk keep their own page-side node array
// and are activated through it, rather than by matching role and name.
const DOM_SOURCES = new Set(['html', 'source']);

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

async function snapshotBlocks(page, source = 'ax', { visited = null } = {}) {
  const t0 = Date.now();
  const blocks = await snapshotFrameTree(page, source, { visited });
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
  const visited = [];
  state.blocks = await snapshotBlocks(page, state.source, { visited });
  state.renderedUrl = page.url();
  // Observe what we display: a frame that contributed lines may keep
  // changing them — an embedded player's elapsed time, for instance — and it
  // is often cross-origin, so nothing else would arm it.
  armRenderedFrames(visited).catch(() => {});
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

// Records that the reader just did something. Live refreshes hold off while
// this is recent, so the buffer is never swapped mid-keystroke. It lives in
// the key handlers rather than the input loop so no call path can bypass it.
// The page can navigate without us asking: a script redirects, a video ends
// and moves on, a login completes. Until we notice, the buffer describes a
// document that no longer exists — every line refers to an element that is
// gone, so activating one fails with an evaluation error against a stale
// handle. Rebuild when the main frame lands somewhere new.
// Whether two URLs are the same document reached at a different fragment.
function sameDocumentFragment(before, after) {
  try {
    const a = new URL(before);
    const b = new URL(after);
    if (!b.hash) return false;
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

async function onExternalNavigation(state, page) {
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
  if (state.live) state.live.lastInputMs = Date.now();
}

// Puts the reader back where they were after the buffer has been rebuilt.
// The new position is worked out arithmetically from what actually changed;
// only when the rewritten region resized under the cursor is there no exact
// answer, and only then do we fall back to searching for the line. Reports
// whether the arithmetic answer was available.
function restoreCursorAfterRebuild(state, previousLineTexts, anchor) {
  const remap = remapIndex(previousLineTexts, state.lines.map((l) => l.text), state.cursor);
  if (remap.exact) {
    state.cursor = Math.min(Math.max(remap.index, 0), Math.max(state.lines.length - 1, 0));
    clampCol(state);
    clampScroll(state);
  } else {
    reanchorQuietly(state, anchor);
  }
  return remap.exact;
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
  const previousLineTexts = state.lines.map((l) => l.text);
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
  const remapExact = restoreCursorAfterRebuild(state, previousLineTexts, anchor);
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
    remapExact,
    lines: state.lines.length,
    changedRegions: regions.length,
    cursor: state.cursor,
  });
}

// Where a piece of text sits in the buffer, but only if it sits in exactly
// one place. Ambiguity is the whole risk in patching by content: "12:04"
// appearing twice means we cannot say which one the page rewrote.
function soleBlockContaining(blocks, needle) {
  let found = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const at = blocks[i].text.indexOf(needle);
    if (at < 0) continue;
    // Twice inside one line is just as ambiguous as once in two lines.
    if (found >= 0 || blocks[i].text.indexOf(needle, at + needle.length) >= 0) return -1;
    found = i;
  }
  return found;
}

// Splices replaced text straight into the buffer, skipping the snapshot.
//
// A clock costs a whole-page snapshot per tick today — 150ms on a plain page
// and seconds on a heavy one — to change eight characters. When the page
// tells us the exact text it replaced, and that text names one line and one
// line only, we can rewrite that line for a fraction of a millisecond.
//
// Anything the splice cannot account for returns null and leaves the buffer
// untouched, so the wholesale refresh still happens. In particular the line
// count must come out the same: a patch that reflows the buffer would move
// the reader, and moving the reader is the one thing a live update may not
// do. Returns the indices of the blocks it changed.
function applyTextPatches(state, patches) {
  if (!patches || !patches.length || !state.blocks.length) return null;

  const previousLineCount = state.lines.length;
  const undo = [];
  const touched = [];
  const restore = () => {
    for (const entry of undo.reverse()) {
      entry.block.text = entry.text;
      if (entry.name !== null) entry.block.item.name = entry.name;
    }
  };

  for (const patch of patches) {
    const { from, to } = patch || {};
    if (!from || !to || from === to) { restore(); return null; }

    // Resolved one at a time, against the buffer as the previous patch left
    // it: two patches can land on the same line.
    const index = soleBlockContaining(state.blocks, from);
    if (index < 0) { restore(); return null; }

    const block = state.blocks[index];
    const item = block.item;
    const hadName = item && typeof item.name === 'string' && item.name.includes(from);
    undo.push({ block, text: block.text, name: hadName ? item.name : null });

    block.text = block.text.replace(from, to);
    // The name is what activation resolves against, so it cannot be left
    // describing text that is no longer on the page.
    if (hadName) item.name = item.name.replace(from, to);
    if (!touched.includes(index)) touched.push(index);
  }

  relayout(state);
  if (state.lines.length !== previousLineCount) {
    restore();
    relayout(state);
    return null;
  }

  // The line the reader is on is theirs while they are reading it. A clock
  // elsewhere on the page may tick — that moves nothing — but rewriting the
  // words under the cursor mid-sentence is exactly the freeze's purpose.
  const onCursorLine = state.lines[state.cursor];
  if (onCursorLine && touched.includes(onCursorLine.blockIndex)
      && Date.now() - state.live.lastInputMs < INPUT_GRACE_MS) {
    restore();
    relayout(state);
    return null;
  }

  return touched;
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
  const live = state.live;
  if (!payload) return;
  live.notifies += 1;
  count('mutations', payload.mutations || 0);
  count('notifies');

  if (!live.enabled) return;

  for (const item of payload.announcements || []) announce(state, item);

  // Try the cheap path first. It only applies to a batch that was nothing but
  // text replacement, and only while nothing else is rewriting the buffer —
  // a refresh in flight is about to replace these blocks wholesale.
  if (payload.pureText && state.mode === 'browse' && !live.refreshing) {
    const before = visibleRowsNow(state);
    const touched = applyTextPatches(state, payload.patches);
    if (touched) {
      const t0 = Date.now();
      const repainted = patchVisibleRows(state, before);
      state.changes = touched.map((index) => ({ start: index, end: index }));
      state.changeIndex = -1;
      count('patched');
      log('live.patch', { patches: payload.patches.length, blocks: touched.length, repainted, ms: Date.now() - t0 });
      return;
    }
    count('patchMissed');
  }

  live.mutations += payload.mutations || 0;
  live.dirty = true;
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

  const previousVisible = visibleRowsNow(state);
  const previousLineTexts = state.lines.map((l) => l.text);
  const anchor = anchorFor(state);

  try {
    await refresh(state, page);
  } catch (err) {
    log('loadmore.error', { error: String(err.message || err).slice(0, 160) });
  }
  restoreCursorAfterRebuild(state, previousLineTexts, anchor);

  const added = state.lines.length - linesBefore;
  state.live.lastPulseMs = 0; // the fingerprint is stale now; re-baseline it
  state.live.refreshing = wasRefreshing;
  state.loadingMore = false;

  patchVisibleRows(state, previousVisible);
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
  const result = await pulse(page, state.live);
  if (result && (result.changed || result.rearmed || result.ms > 50)) log('live.pulse', result);
}

function startLiveTicker(state, page) {
  if (state.live.ticker) return;
  state.live.ticker = setInterval(() => {
    pulseLive(state, page).catch(() => {});
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

// Nothing the reader triggers may block the interface indefinitely.
// Playwright's default timeout is 30 seconds, so a click that cannot resolve
// — a control inside a bot-check frame, an element that vanished mid-page —
// froze the whole terminal for half a minute with no way out. Bound it, and
// report the failure on the status line instead.
const ACTION_TIMEOUT_MS = 6000;
const OPERATION_TIMEOUT_MS = 8000;
const NAVIGATION_TIMEOUT_MS = 20000;

class ActionTimeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ActionTimeout(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function elementHandleFor(state, page, item) {
  if (DOM_SOURCES.has(state.source)) return domElementHandle(page, item);
  if (state.source === 'render') return renderElementHandle(page, item);
  const scope = item.frame || page;
  return scope.getByRole(item.role, { name: item.name, exact: true }).first().elementHandle();
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

const TEXT_AT_FRAGMENT = (hash) => {
  let target = null;
  try {
    target = document.getElementById(hash) || document.querySelector(`[name="${CSS.escape(hash)}"]`);
  } catch { /* not a usable selector */ }
  if (!target) return null;

  // The first readable text at or after the target. A skip link usually
  // points at a container — <main id="main-content"> — whose own text is the
  // entire rest of the page, so what identifies the place is the first thing
  // inside it, not the container.
  //
  // Readable is the load-bearing word. Reddit's #main-content opens with a
  // <script> whose source is the first text node in it; matching on that
  // looks for `SML.load([...])` in the buffer, which no view will ever show.
  const UNRENDERED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || UNRENDERED.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if ((node.data || '').replace(/\s+/g, ' ').trim().length < 2) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  walker.currentNode = target;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    return (node.data || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return null;
};

// The href of the element we are about to activate, so a fragment link can be
// followed even when the page cancels the click and handles it in script —
// in which case the URL never changes and there is nothing else to go on.
async function fragmentOf(state, page, item) {
  let href = null;
  if (DOM_SOURCES.has(state.source)) {
    href = item.attrs && item.attrs.href;
  } else {
    try {
      const handle = await withTimeout(
        elementHandleFor(state, page, item), ACTION_TIMEOUT_MS, 'Locating link');
      href = await handle.evaluate((el) => el.getAttribute('href'));
    } catch {
      return null;
    }
  }
  if (!href || !href.startsWith('#') || href.length < 2) return null;
  return decodeURIComponent(href.slice(1));
}

// The block holding a piece of text, searched by content in both directions:
// the buffer's line can be longer than the snippet (prose runs together) or
// shorter (a link renders as just its name).
function findBlockWithText(state, needle) {
  const trimmed = (needle || '').trim();
  if (!trimmed) return -1;

  const direct = state.blocks.findIndex((b) => b.text.includes(trimmed));
  if (direct >= 0) return direct;

  // Long enough that a common word cannot match the wrong place.
  return state.blocks.findIndex((b) => {
    const text = b.text.trim();
    return text.length >= 10 && trimmed.includes(text);
  });
}

async function jumpToFragment(state, page, hash) {
  const snippet = await page.evaluate(TEXT_AT_FRAGMENT, hash).catch(() => null);
  if (!snippet) return false;

  const blockIndex = findBlockWithText(state, snippet);
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
  const fragment = LINK_ROLES.has(item.role) ? await fragmentOf(state, page, item) : null;

  try {
    setStatus(state, `Activating "${item.name}"...`);
    if (FIELD_ROLES.has(item.role)) {
      const handle = await withTimeout(
        elementHandleFor(state, page, item), ACTION_TIMEOUT_MS, 'Locating field');
      await withTimeout(handle.evaluate((el) => el.focus()), ACTION_TIMEOUT_MS, 'Focusing field');
      const info = await readFieldState(handle);
      state.mode = 'type';
      state.typing = { handle, item, text: info.text, caret: info.caret };
      drawHint(state);
      writeLine(lineRow(state, state.cursor), typingText(state).text);
      setStatus(state, `Typing into "${item.name}" — Esc to stop, Enter to submit.`);
      return;
    }

    if (DOM_SOURCES.has(state.source)) {
      state.statusMsg = await activateDomItem(page, item);
    } else {
      // Activate through the DOM's own default action rather than a
      // mouse-coordinate click: a blind user has no viewport, and legitimate
      // targets (skip links, visually hidden controls) sit off-screen.
      const handle = await withTimeout(
        elementHandleFor(state, page, item), ACTION_TIMEOUT_MS, 'Locating element');
      await withTimeout(Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        handle.evaluate((el) => el.click()),
      ]), ACTION_TIMEOUT_MS, 'Activating');
      state.statusMsg = `Activated: ${item.name}`;
    }
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
    render(state, page);
    const jumped = await jumpToFragment(state, page, fragment);
    log('activate.fragment', { hash: fragment.slice(0, 60), jumped });
    setStatus(state, jumped
      ? `Moved to ${fragment}.`
      : `"${item.name}" points at ${fragment}, which is not in this view.`);
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
  markInput(state);
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

// A tab's identity as the browser knows it, which is the only name for it
// that means the same thing in another session's process.
async function targetIdFor(context, page) {
  try {
    const session = await context.newCDPSession(page);
    const { targetInfo } = await session.send('Target.getTargetInfo');
    await session.detach().catch(() => {});
    return (targetInfo && targetInfo.targetId) || null;
  } catch {
    return null;
  }
}

async function main() {
  log('start', { url: START_URL, logPath: LOG_PATH, connect: ARGS.connect || null });

  // Either attach to a browser the user is already running, or start an
  // ordinary one ourselves. There is deliberately no Playwright-launched
  // fallback: that browser announces itself as automated, and sites that
  // react to it leave the reader stuck on pages that never resolve.
  let browser;
  let context;
  let ownedChild = null;
  let rejoined = false;
  let browserPort = null;
  if (ARGS.connect) {
    const connected = await timed('browser.connect', { endpoint: ARGS.connect }, () =>
      connectToBrowser(ARGS.connect));
    ({ browser, context } = connected);
    browserPort = connected.port;
    rejoined = true;
  } else {
    const started = await timed('browser.start', {}, () =>
      launchOwnBrowser({ profileDir: ARGS.profile || defaultProfileDir(), log }));
    ({ browser, context } = started);
    ownedChild = started.child;
    browserPort = started.port;
    rejoined = !!started.rejoined;
  }

  // When joining a browser that is already running, take over the tab it is
  // already showing rather than opening a blank one. Rejoining is usually
  // about reaching something already on screen — a video that is playing, a
  // form half filled in — and a fresh tab would hide exactly that.
  //
  // Never a tab another session is reading, though: two sessions on one tab
  // navigate each other around. Those are skipped, and if every candidate is
  // taken we open our own tab instead.
  let page = null;
  let pageTargetId = null;
  if (rejoined && !ARGS.url) {
    const taken = claimedTargets(browserPort);
    const existing = context.pages().filter((p) => {
      const url = p.url();
      return url && url !== 'about:blank';
    });
    for (let i = existing.length - 1; i >= 0; i -= 1) {
      const candidate = existing[i];
      const targetId = await targetIdFor(context, candidate);
      if (targetId && taken.has(targetId)) continue;
      page = candidate;
      pageTargetId = targetId;
      break;
    }
    if (page) log('page.adopt', { url: page.url().slice(0, 120), of: existing.length, taken: taken.size });
    else if (existing.length) log('page.adopt.none', { of: existing.length, taken: taken.size });
  }

  const adopted = !!page;
  if (!page) page = await context.newPage();
  // Claim whichever tab we ended up on, including one we just opened and one
  // in a browser we started: the session that joins later is the one that
  // needs to know to leave it alone.
  if (!pageTargetId) pageTargetId = await targetIdFor(context, page);
  claimTab(browserPort, pageTargetId);
  page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  if (!adopted) {
    await timed('goto', { url: START_URL }, () =>
      page.goto(START_URL, { waitUntil: 'domcontentloaded' }));
  }

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
    renderedUrl: page.url(),
    drawn: { address: null, hint: null },
    live: createLiveState(),
    statusHeldUntil: 0,
    loadingMore: false,
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
    if (frame !== page.mainFrame()) return;
    armFrame(frame).catch(() => {});
    onExternalNavigation(state, page).catch(() => {});
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
    markInput(state);

    const t0 = Date.now();
    let result;
    if (state.mode === 'type') result = await handleTypeKey(chunk, state, page);
    else if (state.mode === 'address') result = await handleAddressKey(chunk, state, page);
    else result = await handleBrowseKey(chunk, state, page);
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
  await browser.close().catch(() => {});
  // Only tear down a browser we started; one the user was already running is
  // theirs to keep.
  if (ownedChild) { try { ownedChild.kill(); } catch { /* already gone */ } }
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
  applyTextPatches, soleBlockContaining, loadMore, atEnd,
  sameDocumentFragment, findBlockWithText, jumpToFragment,
  renderRow, parseArgs, onExternalNavigation,
};
