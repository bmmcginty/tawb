#!/usr/bin/env node
'use strict';

const { FIELD_ROLES, LINK_ROLES, BUTTON_ROLES, FOCUSABLE_ROLES } = require('./aria');
const { itemAtOffset } = require('./blocks');
const {
  Core, ALL_SOURCES, SOURCE_LABELS, DOM_SOURCES,
  findBlockWithText, sameDocumentFragment,
  ActionTimeout, withTimeout, readFieldState, ACTION_TIMEOUT_MS,
} = require('./core');
const { armFrame, refreshDue, pulse, TICK_MS } = require('./live');
const { log, timed, count, flushCounters, enableLog } = require('./log');
const { layoutLines } = require('./layout');
const { normaliseEndpoint } = require('./browser');
const { openDriver, engineNames, DEFAULT_ENGINE } = require('./driver');
const { claimedTargets, releaseTab } = require('./session');
const { capturePlace, restorePlace, exactBlockForElement } = require('./place');
const { armActivationFocus, focusedByActivation, cancelActivationFocus } = require('./focus');
const { Keymap } = require('./keys');
const { KeyReader, EOF } = require('./input');
const { runKeyWizard } = require('./key_wizard');
const { editAction, applyBufferEdit, sendFieldEdit } = require('./edit');
const { Credentials, describeChallenge, splitCredentials } = require('./auth');
const { entryLine, matches, shortAddress, KIND_LABELS } = require('./library');
const { resolveAddress, DEFAULT_SEARCH } = require('./address');
const { readSettings } = require('./settings');
const { startupStatus } = require('./startup');
const { escapeNonAscii, escapedOffset } = require('./unicode_escape');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --connect <port|host:port|url> attaches to a browser that is already
// running with --remote-debugging-port, rather than launching one.
// --browser <name> chooses which engine to drive.
// --search <template> is where words typed in the address bar go looking. A
// browser asks its own settings for that; neither protocol will tell us what
// the reader chose there, so it is said here instead — or in TAWB_SEARCH,
// since it is a preference rather than something to retype every launch.
// --no-link-address starts with the status row quiet about where the link
// under the cursor goes. `u` turns it back on for the rest of the session;
// TAWB_LINK_ADDRESS=off says it once and for good, for the same reason
// TAWB_SEARCH exists.
// --short-links says a link that stays on this site as its path alone. Off by
// default, because a graphical browser's status bar shows the whole address
// and this is meant to read like one.
// --escape-unicode represents non-ASCII page text with ASCII-only Unicode
// escapes, for Speakup review on a physical Linux console.
// Options in the settings file are read first, so an explicit command-line
// option can replace them. --no-keep-browser provides that escape hatch for
// the otherwise one-way --keep-browser switch.
const OFF = new Set(['off', 'no', 'false', '0']);
const ON = new Set(['on', 'yes', 'true', '1']);

function parseArgs(argv, env = process.env) {
  const options = {
    url: null, connect: null, profile: null, engine: DEFAULT_ENGINE, keepBrowser: false,
    keyboard: false, log: false, logDir: env.TAWB_LOG_DIR || null,
    search: env.TAWB_SEARCH || DEFAULT_SEARCH,
    linkAddress: !OFF.has(String(env.TAWB_LINK_ADDRESS || '').toLowerCase()),
    shortLinks: ON.has(String(env.TAWB_SHORT_LINKS || '').toLowerCase()),
    escapeUnicode: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--connect') { options.connect = normaliseEndpoint(argv[i + 1] || ''); i += 1; }
    else if (arg.startsWith('--connect=')) { options.connect = normaliseEndpoint(arg.slice('--connect='.length)); }
    else if (arg === '--profile') { options.profile = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--profile=')) { options.profile = arg.slice('--profile='.length); }
    else if (arg === '--keep-browser') { options.keepBrowser = true; }
    else if (arg === '--no-keep-browser') { options.keepBrowser = false; }
    else if (arg === '--keyboard') { options.keyboard = true; }
    else if (arg === '--log') { options.log = true; }
    else if (arg === '--log-dir') { options.logDir = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--log-dir=')) { options.logDir = arg.slice('--log-dir='.length) || null; }
    else if (arg === '--link-address') { options.linkAddress = true; }
    else if (arg === '--no-link-address') { options.linkAddress = false; }
    else if (arg === '--short-links') { options.shortLinks = true; }
    else if (arg === '--no-short-links') { options.shortLinks = false; }
    else if (arg === '--escape-unicode') { options.escapeUnicode = true; }
    else if (arg === '--no-escape-unicode') { options.escapeUnicode = false; }
    else if (arg === '--browser') { options.engine = argv[i + 1] || DEFAULT_ENGINE; i += 1; }
    else if (arg.startsWith('--browser=')) { options.engine = arg.slice('--browser='.length); }
    else if (arg === '--search') { options.search = argv[i + 1] || DEFAULT_SEARCH; i += 1; }
    else if (arg.startsWith('--search=')) { options.search = arg.slice('--search='.length); }
    else if (!arg.startsWith('-') && !options.url) { options.url = arg; }
  }
  return options;
}

// npm runs package scripts from the package directory, but preserves the
// directory where the person invoked it as INIT_CWD. Restore that directory
// before opening the browser so relative upload paths and the browser process
// belong to where TAWB was launched, not where its source happens to live.
function restoreInvocationDirectory(env = process.env, chdir = process.chdir) {
  const invokedFrom = env.INIT_CWD;
  if (!invokedFrom || !path.isAbsolute(invokedFrom)) return false;
  try {
    chdir(invokedFrom);
    return true;
  } catch {
    return false;
  }
}

const ARGS = parseArgs([...readSettings(), ...process.argv.slice(2)]);
// What is typed on the command line is read the same way as what is typed in
// the address bar: `tawb wikipedia.org` is an address, `tawb -- braille dots`
// is not one, and neither should have to carry a scheme to work.
const START_URL = ARGS.url
  ? (resolveAddress(ARGS.url, { search: ARGS.search }).url || ARGS.url)
  : 'https://www.google.com';

// Set by the entry point so the shutdown path can reach the browser from a
// signal handler, which has no other way to get at it.
let setCurrentDriver = () => {};

const ESC = '\x1b';
const FALLBACK_KEYMAP = new Keymap({ terminfo: {}, load: false });

// Quick navigation follows the JAWS vocabulary: h headings, f form fields,
// b buttons, n non-link text, p paragraphs. Uppercase goes backwards except
// for links, whose L is the live-update switch. JAWS puts links on k, which is
// taken by line movement here, so forward links are on l and backward starts
// unbound in the configurable registry.
const QUICK_ACTIONS = {
  'next-heading': { label: 'heading', direction: 1, match: (item) => item.role === 'heading' },
  'previous-heading': { label: 'heading', direction: -1, match: (item) => item.role === 'heading' },
  'next-link': { label: 'link', direction: 1, match: (item) => LINK_ROLES.has(item.role) },
  'previous-link': { label: 'link', direction: -1, match: (item) => LINK_ROLES.has(item.role) },
  'next-field': { label: 'form field', direction: 1, match: (item) => FIELD_ROLES.has(item.role) },
  'previous-field': { label: 'form field', direction: -1, match: (item) => FIELD_ROLES.has(item.role) },
  'next-button': { label: 'button', direction: 1, match: (item) => BUTTON_ROLES.has(item.role) },
  'previous-button': { label: 'button', direction: -1, match: (item) => BUTTON_ROLES.has(item.role) },
  'next-text': { label: 'non-link text', direction: 1, match: (item) => item.role === 'text' },
  'previous-text': { label: 'non-link text', direction: -1, match: (item) => item.role === 'text' },
  // Tab and Shift+Tab: the three sets above at once, in document order, which
  // is what Tab does in a graphical browser.
  'next-focusable': { label: 'control', direction: 1, match: (item) => FOCUSABLE_ROLES.has(item.role) },
  'previous-focusable': { label: 'control', direction: -1, match: (item) => FOCUSABLE_ROLES.has(item.role) },
};

const HEADER_ROWS = 4;   // title line, address line, hint line, blank line
const FOOTER_ROWS = 2;   // blank + status line
const TITLE_ROW = 1;
const ADDRESS_ROW = 2;
const HINT_ROW = 3;

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

function keyIs(chunk, name, state) {
  return (state.keys || FALLBACK_KEYMAP).isKey(chunk, name);
}

function actionKeyLabel(state, id, fallback = '') {
  const keys = state.keys || FALLBACK_KEYMAP;
  const action = keys.byId && keys.byId.get(id);
  const binding = action && action.bindings && action.bindings[0];
  return binding ? keys.display(binding) : fallback;
}

// Turn one complete terminal keystroke back into the name understood by both
// browser drivers. Printable characters already are their own names; terminfo
// sequences become ArrowUp, PageDown, and so on. The only spelling difference
// is Ctrl (terminal convention) versus Control (browser protocol convention).
function browserKeyForTerminalSequence(chunk, keys = FALLBACK_KEYMAP) {
  const name = keys.nameForSequence(chunk);
  if (!name || name.startsWith('raw:')) return null;
  return name.replace(/^Ctrl\+/, 'Control+');
}

// ANSI cursor positioning is 1-indexed. This is the whole point of the
// exercise: a terminal screen reader / braille display follows the actual
// terminal cursor, so it must land on the focused line, and mid-edit on the
// real caret column.
let terminalGeneration = 0;

function writeTerminal(text) {
  terminalGeneration += 1;
  return process.stdout.write(text);
}

function moveCursor(row, col) {
  writeTerminal(`\x1b[${row};${col}H`);
}

// Rewrites a single row in place (move, erase-to-end-of-line, write).
function writeLine(row, text) {
  moveCursor(row, 1);
  writeTerminal('\x1b[2K' + text);
}

function relativeCursor(cells) {
  if (cells < 0) return '\b'.repeat(-cells);
  if (cells > 0) return `\x1b[${cells}C`;
  return '';
}

// Changes an actively edited row like nano: one terminal write moves from the
// old caret, overwrites through the unchanged suffix, clears any stale tail,
// and returns to the new caret. Keeping the whole transaction together avoids
// exposing its intermediate screen states to a terminal or screen reader.
function patchEditedLine(row, before, after, { currentCol = null, finalCol = null } = {}) {
  const oldText = String(before || '');
  const newText = String(after || '');
  const currentKnown = Number.isInteger(currentCol);
  const finalKnown = Number.isInteger(finalCol);

  if (oldText === newText) {
    if (!finalKnown || (currentKnown && currentCol === finalCol)) return false;
    writeTerminal(currentKnown
      ? relativeCursor(finalCol - currentCol)
      : `\x1b[${row};${finalCol}H`);
    return true;
  }

  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length
    && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldText.length - prefix && suffix < newText.length - prefix
    && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix += 1;

  const startCol = prefix + 1;
  let output = currentKnown
    ? relativeCursor(startCol - currentCol)
    : `\x1b[${row};${startCol}H`;
  output += newText.slice(prefix);
  if (newText.length < oldText.length) output += '\x1b[K';
  output += '\b'.repeat(suffix);

  const naturalCol = newText.length - suffix + 1;
  if (finalKnown) output += relativeCursor(finalCol - naturalCol);
  writeTerminal(output);
  return true;
}

// DECSTBM: confine scrolling to the list area so the header stays put and a
// single-line step past an edge costs one new line instead of a repaint.
function setScrollRegion() {
  writeTerminal(`\x1b[${HEADER_ROWS + 1};${HEADER_ROWS + viewportHeight()}r`);
}

function resetScrollRegion() {
  writeTerminal('\x1b[r');
}

function scrollRegion(direction) {
  const top = HEADER_ROWS + 1;
  const bottom = HEADER_ROWS + viewportHeight();
  if (direction > 0) {
    moveCursor(bottom, 1);
    writeTerminal('\x1bD'); // IND — scroll up, blank line at bottom
    return bottom;
  }
  moveCursor(top, 1);
  writeTerminal('\x1bM'); // RI — scroll down, blank line at top
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

// The blocks the screen is showing. Ordinarily the page's, but while one of
// the browser's own lists is open it is that list: the buffer on screen is no
// longer the tab, and everything that reads lines has to agree about which.
function activeBlocks(state) {
  if (state.library) return state.library.blocks;
  if (state.dialog) return state.dialog.blocks;
  return state.core.blocks;
}

function currentBlock(state) {
  const line = currentLine(state);
  return line ? activeBlocks(state)[line.blockIndex] : null;
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

// A view switch can turn one item near the top of a short semantic view into
// an element hundreds of markup lines down in SOURCE. Merely clamping the old
// scroll position puts that item on the terminal's last row. Keep its screen
// row instead, just as screen-wise movement does, so changing representation
// does not also make the reader's cursor jump around the window.
function preserveViewportRow(state, row, height = viewportHeight()) {
  const wanted = Math.min(Math.max(row, 0), Math.max(height - 1, 0));
  const maxScroll = Math.max(0, state.lines.length - height);
  state.scroll = Math.min(Math.max(0, state.cursor - wanted), maxScroll);
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
  // A block index only means something to the core while the buffer is the
  // page. With a list of bookmarks on screen, line 12 is the twelfth
  // bookmark, and telling the core the reader is standing on the page's
  // twelfth block would let a text patch land where they are not.
  if (state.library || state.dialog) return;
  const line = state.lines[state.cursor];
  state.core.at(line ? line.blockIndex : -1);
}

function pageText(state, text) {
  return state.escapeUnicode ? escapeNonAscii(text) : String(text ?? '');
}

function displayBlocks(state) {
  const blocks = activeBlocks(state);
  if (!state.escapeUnicode || blocks !== state.core.blocks) return blocks;
  // Keep Core's original text intact. It uses that text to resolve live
  // patches, preserve the reader's place, and identify page controls.
  return blocks.map((block) => ({ ...block, text: escapeNonAscii(block.text) }));
}

function relayout(state) {
  state.lines = layoutLines(displayBlocks(state), contentWidth());
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

// The page's title, on the first row of the window.
//
// It is what a page calls itself, and until now the only way to hear it was
// to open the tab list. It costs a row of the viewport, which is why it is
// the title alone: the address is on the row below it, and repeating the URL
// here when a page has no title would spend that row saying nothing new.
//
// Read when the buffer is rebuilt rather than on every keystroke. It is a
// round trip, and the banner is meant to stay untouched while reading — a
// repainted row is re-read by a screen reader and re-flashed by a braille
// display whether or not it now says anything different.
async function readTitle(page) {
  try {
    const title = await page.title();
    return String(title || '').replace(/\s+/g, ' ').trim();
  } catch {
    return ''; // closed, navigating, or an engine that will not say
  }
}

function drawTitle(state, { force = false } = {}) {
  const rendered = pageText(state, state.title).slice(0, termSize().cols);
  if (!force && rendered === state.drawn.title) return;
  state.drawn.title = rendered;
  writeLine(TITLE_ROW, rendered);
}

// ---------------------------------------------------------------------------
// Navigating somewhere the browser will not simply load
//
// A failed navigation is not an empty result. Both engines answer a bad
// certificate — and a refused connection, and a name that does not resolve —
// by rendering a page of their own: Chromium's "Your connection is not
// private", Firefox's "Be careful. Something doesn't look right." That page
// is the whole of what a sighted person gets, and it carries the only way
// past it, which is Advanced and then Proceed.
//
// Both engines report it by throwing out of page.goto, so taking the throw at
// face value threw away the one thing the reader needed. It killed the
// session outright at startup, and from the address bar it left them on the
// page they came from with a stack-trace fragment on the status line, no
// warning to read and no way to go on.
//
// So the throw is noted and the tab is read regardless. The reader lands on
// the browser's own warning, in the same four views as any other page, and
// the controls on it work because they are ordinary page controls.
// ---------------------------------------------------------------------------

// The engine's own name for what went wrong, out of a message written for a
// developer's console. Chromium says
//   page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://example.com/
// and Firefox
//   unknown error: Error: NS_ERROR_GENERATE_FAILURE(NS_ERROR_MODULE_SECURITY,
//   MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT)
// and the code in the middle is the part worth repeating to a reader.
function navigationFault(message) {
  const text = String(message || '').split('\n')[0];
  const codes = [...text.matchAll(/\b(?:net::)?((?:ERR|NS_ERROR|MOZILLA_PKIX_ERROR|SEC_ERROR)_[A-Z0-9_]+)\b/g)]
    .map((m) => m[1]);
  // Firefox wraps the diagnosis in a generic failure and a module name —
  // NS_ERROR_GENERATE_FAILURE(NS_ERROR_MODULE_SECURITY, MOZILLA_PKIX_ERROR_
  // SELF_SIGNED_CERT) — so the code that actually says what is wrong with the
  // certificate is preferred over whatever came first.
  const specific = codes.find((code) => /^(ERR_CERT|MOZILLA_PKIX_ERROR|SEC_ERROR)/.test(code));
  if (specific || codes.length) return specific || codes[0];
  return text.replace(/^page\.goto:\s*/, '').replace(/^unknown error:\s*(Error:\s*)?/, '').slice(0, 120);
}

// Go somewhere, and say what happened rather than throwing. The caller reads
// the tab either way, because either way there is something in it.
//
// The error page arrives a moment after the navigation that failed: the throw
// comes from the network layer, and the page that replaces the document is
// rendered after it. Measured from the throw, the accessibility tree is still
// empty at 74ms on Chromium and carries the warning at 379ms; Firefox is much
// the same at 348ms. Reading once, at whatever moment the throw happened to
// land, gave an empty buffer — a reader told their page was refused, with
// nothing on screen and nothing to press. So the buffer is read again until
// it holds something, bounded, and the bound is not an error in itself: a
// page that genuinely renders nothing is a page with nothing to say.
async function settleAfterFault(state, page, { timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    await refresh(state, page, { resetCursor: true });
    if (state.lines.length) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function navigate(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { ok: true, fault: null };
  } catch (err) {
    const fault = navigationFault(err && err.message);
    log('navigate.failed', { url: String(url).slice(0, 120), fault });
    return { ok: false, fault };
  }
}

// Address-bar navigation must not own the keyboard for an entire protocol
// timeout. Keep consuming input while it is pending, and let Escape ask the
// engine to stop without waiting for that request or the original command to
// answer. navigate() observes the eventual outcome, while the external-
// navigation watcher refreshes any document that did manage to replace ours.
async function navigateInterruptibly(state, page, url) {
  const pending = navigate(page, url);
  if (!state.keyReader || typeof state.keyReader.nextOr !== 'function') return pending;

  for (;;) {
    const outcome = await state.keyReader.nextOr(pending);
    if (Object.hasOwn(outcome, 'value')) return outcome.value;

    const chunk = outcome.key;
    markInput(state);
    if (chunk !== EOF && !keyIs(chunk, 'Escape', state)) continue;

    if (typeof page.stopLoading === 'function') {
      try { Promise.resolve(page.stopLoading()).catch(() => {}); } catch { /* already gone */ }
    }
    log('navigate.cancelled', { url: String(url).slice(0, 120), eof: chunk === EOF });
    return { ok: false, fault: null, cancelled: true };
  }
}

// The link the reader is standing on, and where it goes. See drawStatus,
// which is what says it.
//
// Nothing at all when the reader has switched it off: a row that speaks costs
// a sentence on every link, which is most of the lines on some pages, and the
// address is still a keystroke away on the page itself.
//
// Only ever the page's own buffer: with one of the browser's own lists open
// the lines on screen are bookmarks or history entries rather than links on
// the page, and the status row is still the page's to talk about.
function linkTarget(state, page) {
  if (!state.linkAddress) return null;
  if (state.library || state.dialog) return null;
  const item = itemUnderCursor(state);
  if (!item || !LINK_ROLES.has(item.role)) return null;
  if (!item.href) return null;
  return state.shortLinks ? shortTarget(item.href, pageUrl(page)) : item.href;
}

// The same address, said the way a person would say it to someone already
// standing on the page: a link from /a/b/c to /b is "/b", because the host is
// the one they are on and repeating it says nothing. A link that leaves the
// site is said in full — that it leaves is the most important thing about it,
// and it is the host that carries that news.
//
// Same page, different fragment, is shorter still: "#notes" rather than the
// path the reader is already standing in. Anything that will not parse is
// handed back untouched rather than guessed at.
function shortTarget(href, here) {
  let link;
  let page;
  try {
    link = new URL(href);
    page = new URL(here);
  } catch { return href; }
  if (link.origin === 'null' || link.origin !== page.origin) return href;
  if (link.pathname === page.pathname && link.search === page.search) {
    return link.hash || `${link.pathname}${link.search}` || '/';
  }
  return `${link.pathname}${link.search}${link.hash}` || '/';
}

function pageUrl(page) {
  try {
    return page && typeof page.url === 'function' ? page.url() : '';
  } catch { return ''; }
}

// The address row is the tab's own address and nothing else. Where the link
// under the cursor goes is a different question and belongs on the status
// line, which is where a graphical browser answers it — see drawStatus.
function addressText(state, page) {
  if (state.mode === 'address') return state.address.text;
  return page.url();
}

// The address is one line and URLs are routinely longer than the terminal is
// wide, so it scrolls horizontally around the caret instead of wrapping.
function drawAddress(state, page, { force = false, edit = false } = {}) {
  const label = `[${SOURCE_LABELS[state.core.source]}] `;
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
  const previous = state.drawn.address;
  const caretCol = label.length + caretOffset + 1;
  const previousCaretCol = state.drawn.addressCaretCol;
  let cursorPlaced = false;
  if (rendered !== previous) {
    state.drawn.address = rendered;
    if (!force && state.mode === 'address' && previous != null) {
      cursorPlaced = patchEditedLine(ADDRESS_ROW, previous, rendered, {
        currentCol: edit ? previousCaretCol : null,
        finalCol: caretCol,
      });
    } else {
      writeLine(ADDRESS_ROW, rendered);
    }
  } else if (state.mode === 'address' && edit) {
    cursorPlaced = patchEditedLine(ADDRESS_ROW, rendered, rendered, {
      currentCol: previousCaretCol,
      finalCol: caretCol,
    });
  }

  if (state.mode === 'address') {
    state.drawn.addressCaretCol = caretCol;
    if (!cursorPlaced) moveCursor(ADDRESS_ROW, caretCol);
  } else {
    state.drawn.addressCaretCol = null;
  }
}

function hintText(state) {
  if (state.mode === 'address') return 'Address — Enter: go  Esc: cancel';
  if (state.mode === 'type') return 'Typing — Tab: next control  Esc: stop  Enter: submit';
  if (state.mode === 'forms') return 'Forms — Tab: next control  Enter: activate  Esc: browse';
  if (state.mode === 'control') return 'Control — arrows adjust  Home/End  Esc: stop';
  if (state.mode === 'page') {
    return `Webpage keyboard — every other key goes to the page  ${actionKeyLabel(state, 'page-keyboard', 'Alt+K')}: stop`;
  }
  if (state.mode === 'find') return 'Find — Enter: search  Esc: cancel';
  if (state.mode === 'choose') return 'Choosing — j/k: move  type: filter  Enter: choose  Esc: cancel';
  if (state.mode === 'library') {
    return `${state.library.label} — type: filter  Enter: open  Esc: close`;
  }
  if (state.mode === 'line') return `${state.line.label} — Enter: save  Esc: cancel`;
  if (state.mode === 'files') {
    const { chosen, multiple } = state.files;
    const done = multiple && chosen.length ? '  Enter on an empty line: done' : '';
    return `Attach a file — Tab: complete  Enter: attach${done}  Esc: cancel`;
  }
  if (state.mode === 'dialog') {
    return 'The browser is asking — Enter: press  Esc: leave it unanswered';
  }
  if (state.mode === 'auth') {
    const { challenge, refused } = state.auth;
    return `${refused ? 'Password refused. ' : ''}Sign in to ${describeChallenge(challenge)}`
      + ' — Enter: next  Esc: cancel';
  }
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
  const label = `[${pageText(state, item.name)}: `;
  const value = pageText(state, state.typing.text);
  return {
    text: label + value + ']',
    caretCol: GUTTER + label.length
      + (state.escapeUnicode
        ? escapedOffset(state.typing.text, state.typing.caret)
        : state.typing.caret) + 1,
  };
}

function statusRow() {
  return termSize().rows;
}

// The one place the status row is written, so that what is on it is always
// known — drawStatus below will not repaint a row that already says what it
// is about to say.
function writeStatusRow(state, text) {
  // Status messages can repeat page-provided control names and carry ARIA
  // live announcements, so they belong to the escaped page presentation too.
  const rendered = pageText(state, text).slice(0, termSize().cols);
  state.drawn.status = rendered;
  writeLine(statusRow(), rendered);
}

function setStatus(state, msg) {
  state.statusMsg = msg;
  writeStatusRow(state, msg);
  parkCursor(state);
}

// Where the link under the cursor goes, said as the reader arrives on it.
//
// This is what a graphical browser does, and it does it in the status bar
// rather than the address bar: the address bar goes on saying where you are,
// and the corner of the window says where the thing under the pointer would
// take you. The reader gets the same two answers in the same two places.
//
// A message wins while it is news — setStatus writes it whatever the cursor
// is standing on — and the next move brings the link target back, or the
// message back, whichever the new line calls for. Nothing is written when the
// row already says it, which is most keystrokes and is what keeps a screen
// reader from re-reading and a braille display from re-flashing a row that
// did not change.
//
// Browse mode only: the find prompt, the sign-in prompt, the path prompt and
// the one-line prompt are all drawn on this row and own it while they are up.
function drawStatus(state, page) {
  if (state.mode !== 'browse') return;
  const wanted = linkTarget(state, page) || state.statusMsg;
  const rendered = pageText(state, wanted).slice(0, termSize().cols);
  if (rendered === state.drawn.status) return;
  writeStatusRow(state, rendered);
}

// Puts the terminal cursor back where the reader is.
function parkCursor(state) {
  if (state.mode === 'auth') {
    drawAuthPrompt(state);
    return;
  }
  if (state.mode === 'address') {
    drawAddress(state, state.core.page);
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
  drawTitle(state, { force });
  drawAddress(state, page, { force });
  drawHint(state, { force });
  drawList(state);
  if (state.statusMsg) writeStatusRow(state, state.statusMsg);
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
  drawTitle(state);
  drawAddress(state, page);
  drawHint(state);

  if (before && before.scroll === state.scroll && before.height === viewportHeight()) {
    const repainted = patchVisibleRows(state, before.rows);
    log('repaint', { rows: repainted, of: before.height, source: state.core.source });
    return repainted;
  }

  drawList(state);
  parkCursor(state);
  log('repaint', { rows: viewportHeight(), of: viewportHeight(), full: true, source: state.core.source });
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

  // Where the new line goes, if it goes anywhere. This is the one thing
  // outside the list area a move touches — the banner is left alone — and it
  // costs nothing on the keystrokes that do not change it. Drawn before the
  // cursor is placed, since reaching the status row means moving the cursor
  // there and back.
  drawStatus(state, page);

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

// Move the document and cursor together, preserving the cursor's row on the
// screen. One line remains visible from the previous screen so the reader has
// context at the join rather than landing in entirely unfamiliar text.
function moveScreen(state, direction, page, height = viewportHeight()) {
  const step = Math.max(1, height - 1);
  const lastLine = Math.max(state.lines.length - 1, 0);
  const maxScroll = Math.max(0, state.lines.length - height);
  const targetCursor = Math.min(Math.max(state.cursor + direction * step, 0), lastLine);
  const targetScroll = Math.min(Math.max(state.scroll + direction * step, 0), maxScroll);
  if (targetCursor === state.cursor && targetScroll === state.scroll) return;

  state.cursor = targetCursor;
  state.scroll = targetScroll;
  state.col = 0;
  clampCol(state);
  syncCursor(state);
  drawStatus(state, page);
  drawList(state);
  parkCursor(state);
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
    const block = state.core.blocks[line.blockIndex];
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
    const block = state.core.blocks[line.blockIndex];
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
  const displayedNeedle = pageText(state, needle);
  const sensitive = /[A-Z]/.test(displayedNeedle);
  const want = sensitive ? displayedNeedle : displayedNeedle.toLowerCase();
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
// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

// The password prompt, on the status line, with the origin that is asking on
// the hint line above it. The origin and not the page: a challenge can come
// from an image or a frame belonging to somewhere else entirely, and telling
// somebody they are signing in to the site they can see when the password is
// going elsewhere is the shape of every credential trick there is.
function authPromptText(state) {
  const { stage, user, password } = state.auth;
  const label = stage === 'user' ? 'user: ' : 'password: ';
  const buffer = stage === 'user' ? user : password;
  // A password is not echoed. The reader may be on a shared terminal, and a
  // terminal keeps scrollback.
  const shown = stage === 'user' ? buffer.text : '*'.repeat(buffer.text.length);
  return { text: label + shown, caretCol: label.length + buffer.caret + 1 };
}

function drawAuthPrompt(state) {
  const cols = termSize().cols;
  const { text, caretCol } = authPromptText(state);
  writeStatusRow(state, text);
  moveCursor(statusRow(), Math.min(caretCol, cols));
}

// Returns credentials, null to go on to the next key, or undefined for
// "nothing decided yet".
function handleAuthKey(chunk, state) {
  const a = state.auth;
  if (keyIs(chunk, 'Escape', state)) return null;

  if (chunk === '\r' || chunk === '\n') {
    if (a.stage === 'password') return { username: a.user.text, password: a.password.text };
    // An empty username is the other way out, for a reader who has pressed
    // Enter at a prompt they did not want.
    if (!a.user.text) return null;
    a.stage = 'password';
    return undefined;
  }

  const buffer = a.stage === 'user' ? a.user : a.password;
  const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
  if (editing) applyBufferEdit(buffer, editing);
  else if (keyIs(chunk, 'Ctrl+L', state)) {
    buffer.text = '';
    buffer.caret = 0;
  } else if (!chunk.startsWith(ESC) && chunk >= ' ') {
    buffer.text = buffer.text.slice(0, buffer.caret) + chunk + buffer.text.slice(buffer.caret);
    buffer.caret += chunk.length;
  }
  return undefined;
}

// Asks, and does not return until it has an answer.
//
// This runs while the reading loop is stopped: the challenge was raised
// inside a navigation the loop is awaiting, and that navigation cannot finish
// until the browser is told what to do about the password. So the prompt
// takes the keyboard for itself and hands it back afterwards.
async function askForPassword(state, challenge, { refused = false } = {}) {
  if (!state.keyReader) return null;
  const previousMode = state.mode;
  const previousStatus = state.statusMsg;
  state.mode = 'auth';
  state.auth = {
    challenge,
    refused,
    stage: 'user',
    user: { text: '', caret: 0 },
    password: { text: '', caret: 0 },
  };
  log('auth.prompt', { origin: challenge.origin, realm: challenge.realm, scheme: challenge.scheme, refused });

  const token = state.keyReader.claim();
  drawHint(state, { force: true });
  drawAuthPrompt(state);
  try {
    for (;;) {
      const chunk = await state.keyReader.next(token);
      // The keyboard has gone while the prompt was up. Declining is the only
      // honest answer, and it is the safe one: the challenge is cancelled
      // rather than left holding a request the browser has paused, so the
      // 401's own body loads and the navigation the reading loop is awaiting
      // finishes. The loop is given the same news a moment later.
      if (chunk === EOF) return null;
      markInput(state);
      const answer = handleAuthKey(chunk, state);
      if (answer !== undefined) return answer;
      drawAuthPrompt(state);
    }
  } finally {
    const asked = state.auth.challenge;
    state.keyReader.release(token);
    state.mode = previousMode;
    state.auth = null;
    state.statusMsg = previousStatus;
    drawHint(state, { force: true });
    writeStatusRow(state, `Signing in to ${describeChallenge(asked)}…`);
  }
}

function findPrompt(state) {
  return (state.find.direction > 0 ? '/' : '?') + state.find.text;
}

function drawFind(state) {
  const cols = termSize().cols;
  writeStatusRow(state, findPrompt(state));
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
  state.title = await readTitle(page);
  if (state.core.live) state.core.live.snapshotCostMs = state.core.snapshotCostMs;
  if (resetCursor) { state.cursor = 0; state.scroll = 0; state.col = 0; }
  relayout(state);
  if (anchor) restoreAnchor(state, anchor);
}

// Re-anchoring for an update the reader did not ask for. Unlike
// restoreAnchor, it never falls back to a proportional guess: if the line the
// reader was on has gone, staying put is far less disorienting than being
// silently teleported somewhere proportional.
// Searching for the anchor's text from the top of the document is wrong here:
// block text is often not unique — SOURCE is full of repeated <svg>, <h4>
// and <option value=30> — so the first match can be thousands of lines from
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
    state.core.live.queue.push({ politeness, text });
    if (state.core.live.queue.length > 5) state.core.live.queue.shift();
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
  if (page !== state.core.page) return;
  const url = page.url();
  if (url === state.core.renderedUrl) return;
  if (state.core.live && state.core.live.refreshing) return;

  // Following a fragment fires this too. Nothing was replaced — the document
  // is the one already in the buffer — so rebuilding it and resetting the
  // cursor would throw the reader to the top of a page they never left.
  // Activation moves them to the target itself; a hash changed by script
  // leaves them where they are, and the observer catches any real change.
  if (sameDocumentFragment(state.core.renderedUrl, url)) {
    state.core.renderedUrl = url;
    return;
  }

  // The buffer and cursor still describe the document being left. Remember
  // them under that address before renderedUrl advances to the destination.
  rememberHistoryPlace(state, page, null, state.core.renderedUrl);
  state.core.renderedUrl = url;
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
  state.inputSeen = true;
  if (state.core) state.core.markInput();
}

function keepLivePlace(state, wasNavigation) {
  return !wasNavigation && !!state.inputSeen;
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
  const live = state.core.live;
  if (!refreshDue(live)) return;
  // A password prompt is answered while the reading loop is stopped inside
  // the navigation that raised it. The ticker is not stopped, and a repaint
  // over a half-typed password would take the prompt off the screen with the
  // reader still typing into it. The same is true of every prompt that takes
  // the keyboard for itself: a path being completed, a bookmark being named.
  if (state.mode === 'auth' || state.mode === 'files' || state.mode === 'line') return;

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
  // Before the first keystroke there is no reader-chosen place to protect.
  // Keeping the only control from an early, partial snapshot can drag the
  // cursor to the end as the rest of an application renders above it.
  const keepPlace = keepLivePlace(state, wasNavigation);
  try {
    // Nothing to keep across a navigation: the lines the reader was among
    // belong to a document that is gone.
    rebuilt = await state.core.rebuild(anchor, { page, keepPlace });
  } catch (err) {
    live.refreshing = false;
    log('live.refresh.error', { error: String(err.message || err).slice(0, 160) });
    return;
  }
  live.snapshotCostMs = state.core.snapshotCostMs;

  if (!keepPlace) {
    state.cursor = 0;
    state.col = 0;
    state.scroll = 0;
  }
  relayout(state);
  if (keepPlace) settleCursorOn(state, rebuilt.settled.block);
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
    source: state.core.source,
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
  if (patches && state.mode === 'browse' && !state.core.live.refreshing) {
    const before = visibleRowsNow(state);
    const touched = applyTextPatches(state, patches);
    if (touched) {
      const t0 = Date.now();
      const repainted = patchVisibleRows(state, before);
      state.core.recordChanges(touched.map((index) => ({ start: index, end: index })));
      count('patched');
      log('live.patch', { patches: patches.length, blocks: touched.length, repainted, ms: Date.now() - t0 });
      return;
    }
    count('patchMissed');
  }

  state.core.live.mutations += (mutations || 0);
  state.core.live.dirty = true;
}

// ---------------------------------------------------------------------------
// Page history
//
// History belongs to a tab, unlike the reader's own tab list. Each history
// entry also keeps the terminal position it was left at, so Back and Forward
// return to the line being read rather than treating a restored page as new.
// Hold live refreshes while moving so the navigation event cannot race this
// deliberate rebuild and leave the old document in the buffer.
// ---------------------------------------------------------------------------

function placesForPage(state, page) {
  if (!state.historyPlaces) state.historyPlaces = new WeakMap();
  let places = state.historyPlaces.get(page);
  if (!places) {
    places = new Map();
    state.historyPlaces.set(page, places);
  }
  return places;
}

function rememberHistoryPlace(state, page, identity = null, url = page.url()) {
  const place = { cursor: state.cursor, col: state.col, scroll: state.scroll };
  const places = placesForPage(state, page);
  if (identity) places.set(identity, place);
  if (url) places.set(`url:${url}`, place);
  return place;
}

function restoreHistoryPlace(state, page, identity = null, url = page.url()) {
  const places = placesForPage(state, page);
  const place = (identity && places.get(identity)) || (url && places.get(`url:${url}`));
  if (!place) return false;
  state.cursor = Math.min(Math.max(place.cursor, 0), Math.max(state.lines.length - 1, 0));
  state.col = place.col;
  state.scroll = place.scroll;
  clampCol(state);
  clampScroll(state);
  return true;
}

async function historyEntryIdentity(page) {
  return page.evaluate(() => globalThis.navigation?.currentEntry?.key
    ? `entry:${globalThis.navigation.currentEntry.key}` : `url:${location.href}`)
    .catch(() => `url:${page.url()}`);
}

async function rememberCurrentHistoryPlace(state, page) {
  // Every deliberate move — an address, a link, a step through history —
  // passes here, which makes it the place to say that a reader who escaped a
  // password prompt would like to be asked again. Escaping one has to stop a
  // page of thirty protected images asking thirty times; it must not mean the
  // realm can never be signed in to again.
  if (state.credentials) state.credentials.reconsider();
  const identity = await historyEntryIdentity(page);
  const place = rememberHistoryPlace(state, page, identity);
  log('history.place.remember', {
    identity, url: page.url().slice(0, 120), cursor: place.cursor, col: place.col, scroll: place.scroll,
  });
  return place;
}

function acknowledgeHistoryNavigation(state, page) {
  // The history command already rebuilt the destination and restored its
  // cursor. The live pulse still holds the URL of the page we left; if that
  // stale baseline survives, the next tick calls this a new navigation and
  // runLiveRefresh deliberately resets the cursor to zero. Advance that
  // baseline here so a later content refresh reanchors instead of going top.
  state.core.live.href = page.url();
  state.core.live.navigated = false;
}

async function traversePageHistory(page, direction, watchMs = 1500) {
  const beforeUrl = page.url();
  const beforeEntry = await page.evaluate(() =>
    (globalThis.navigation?.currentEntry ? globalThis.navigation.currentEntry.key : null));
  await page.evaluate((delta) => window.history.go(delta), direction);

  const deadline = Date.now() + watchMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const entry = await page.evaluate(() =>
      (globalThis.navigation?.currentEntry ? globalThis.navigation.currentEntry.key : null))
      .catch(() => beforeEntry);
    if (page.url() !== beforeUrl || (entry && entry !== beforeEntry)) {
      // Attached Chromium can report the new document and then leave
      // waitForLoadState waiting until its full timeout. Ask the document
      // directly instead; this is the same readiness goto(domcontentloaded)
      // waits for and works through both drivers.
      const loadDeadline = Date.now() + 15000;
      while (Date.now() < loadDeadline) {
        const ready = await page.evaluate(() => document.readyState).catch(() => '');
        if (ready === 'interactive' || ready === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const url = await page.evaluate(() => location.href).catch(() => null);
      if (url && typeof page.setUrl === 'function') page.setUrl(url);
      return true;
    }
  }
  return false;
}

async function moveInHistory(state, page, direction) {
  const backwards = direction < 0;
  const verb = backwards ? 'back' : 'forward';

  while (state.core.live.refreshing) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  state.core.live.refreshing = true;
  try {
    await rememberCurrentHistoryPlace(state, page);
    const moved = await traversePageHistory(page, direction);
    if (!moved) {
      setStatus(state, `No page to go ${verb} to.`);
      return;
    }
    const destinationIdentity = await historyEntryIdentity(page);
    await refresh(state, page, { resetCursor: true });
    const restored = restoreHistoryPlace(state, page, destinationIdentity);
    acknowledgeHistoryNavigation(state, page);
    render(state, page, { force: true });
    setStatus(state, `Went ${verb} to ${page.url()}`);
    log('history.move', {
      direction, url: page.url().slice(0, 120), destinationIdentity,
      restored, cursor: state.cursor, col: state.col, scroll: state.scroll,
    });
  } catch (err) {
    setStatus(state, `Could not go ${verb}: ${err.message.split('\n')[0]}`);
    log('history.failed', { direction, error: String(err.message || err).slice(0, 160) });
  } finally {
    state.core.live.refreshing = false;
  }
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
  if (!page || page === state.core.page) return false;

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

function focusAddressBar(state, page, text = page.url()) {
  state.mode = 'address';
  state.address = { text, caret: text.length, scroll: 0 };
  drawHint(state);
  drawAddress(state, page, { force: true });
}

async function openNewTab(
  state, switchTab = switchToTab, focusAddress = focusAddressBar,
) {
  try {
    const page = await state.core.newTab();
    await switchTab(state, page, { note: 'Opened a new tab' });
    // A browser's new-tab command leaves the user in a blank location bar,
    // ready to type where to go. about:blank is the page's internal address,
    // not text the user should have to erase first.
    focusAddress(state, page, '');
  } catch (err) {
    setStatus(state, `Could not open a new tab: ${err.message.split('\n')[0]}`);
  }
}

// Closing the tab the reader is on, which is only ever theirs to ask for.
//
// The last tab is not closed. A reader left with no tab has no page, no
// buffer and nothing to move to — the browser would still be running with
// nothing in it — so the key does nothing and says why. Quitting is `q`.
async function closeCurrentTab(state) {
  const current = state.core.page;
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
  if (!state.ready || page === state.core.page) return;

  await new Promise((r) => setTimeout(r, NEW_TAB_SETTLE_MS));
  if (page === state.core.page || (page.isClosed && page.isClosed())) return;

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

async function loadMore(state, page) {
  if (state.loadingMore) return;

  // Already asked, already answered. The reader gets the truth immediately
  // instead of the same two and a half seconds of waiting for it.
  if (state.core.noMoreToLoad()) {
    setStatus(state, 'End of page.');
    return;
  }

  state.loadingMore = true;
  // Hold off the live refresh: the page is about to mutate heavily, and a
  // rebuild landing in the middle of this one would fight with it.
  const wasRefreshing = state.core.live.refreshing;
  state.core.live.refreshing = true;
  setStatus(state, 'Loading more…');

  const t0 = Date.now();
  const linesBefore = state.lines.length;
  let asked;

  try {
    asked = await state.core.askForMore(page);
  } catch (err) {
    state.loadingMore = false;
    state.core.live.refreshing = wasRefreshing;
    setStatus(state, 'Could not ask the page for more.');
    log('loadmore.error', { error: String(err.message || err).slice(0, 160) });
    return;
  }

  // Nothing arrived, so there is nothing to rebuild — and a rebuild here does
  // not merely cost a snapshot for no gain, it can lose content. The core has
  // put the scroll back and remembered the answer.
  if (!asked.grew) {
    state.loadingMore = false;
    state.core.live.refreshing = wasRefreshing;
    log('loadmore', {
      ms: Date.now() - t0, grew: false, scrollable: asked.scrollable,
      scrolled: asked.target, added: 0, lines: state.lines.length,
    });
    setStatus(state, 'End of page.');
    return;
  }

  const screen = screenBefore(state);
  const previousTexts = state.core.blocks.map((b) => b.text);
  const anchor = anchorFor(state);

  try {
    await refresh(state, page);
  } catch (err) {
    log('loadmore.error', { error: String(err.message || err).slice(0, 160) });
  }
  restoreCursorAfterRebuild(state, previousTexts, anchor);

  const added = state.lines.length - linesBefore;
  state.core.live.lastPulseMs = 0; // the fingerprint is stale now; re-baseline it
  state.core.live.refreshing = wasRefreshing;
  state.loadingMore = false;

  repaintList(state, page, screen);
  log('loadmore', { ms: Date.now() - t0, grew: true, scrolled: asked.target, added, lines: state.lines.length });

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

  const result = await pulse(page, state.core.live);
  if (result && (result.changed || result.navigated || result.rearmed || result.ms > 50)) {
    log('live.pulse', result);
  }
  // A pulse that cannot run at all is worth knowing about: it is the safety
  // net, and a silent one is no net.
  if (state.core.live.pulseErrors) {
    count('pulseErrors', state.core.live.pulseErrors);
    state.core.live.pulseErrors = 0;
  }
}

function startLiveTicker(state, page) {
  if (state.core.live.ticker) return;
  state.core.live.ticker = setInterval(() => {
    // state.core.page rather than the page this was started for: the reader can
    // move to another tab, and the ticker has to follow them there.
    // Collected before pulsing, so a change the observer already saw is in
    // hand before we go asking whether anything changed.
    state.core.collectLive(state.core.page)
      .then(() => pulseLive(state, state.core.page))
      .then(() => runLiveRefresh(state, state.core.page))
      .catch(() => {});
  }, TICK_MS);
  if (state.core.live.ticker.unref) state.core.live.ticker.unref();
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
  // Resolved against the buffer as it stands now, and in document order, so
  // repeated presses walk down the page rather than around the order things
  // happened to arrive in.
  const targets = state.core.changeTargets();
  if (!targets.length) {
    setStatus(state, 'No recorded changes.');
    return;
  }
  const count = targets.length;
  state.core.changeIndex = (state.core.changeIndex + direction + count) % count;
  const target = targets[state.core.changeIndex];
  const lineIndex = lineForBlock(state, target.block);
  if (lineIndex < 0) {
    setStatus(state, 'Changed area is no longer present.');
    return;
  }
  moveSelection(state, lineIndex, page, 0);
  setStatus(state, `Change ${state.core.changeIndex + 1} of ${count} (${target.size} line${target.size === 1 ? '' : 's'}).`);
}

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

async function handleBrowseKey(chunk, state, page) {
  markInput(state);
  const action = (state.keys || FALLBACK_KEYMAP).actionFor(chunk);
  if (action === 'quit') return 'quit';

  // A reader inside a menu must always have a way out that also shuts it,
  // rather than one that leaves it open and them somewhere else.
  if (action === 'close-popup' && state.core.popup) return closePopup(state, page);

  if (action === 'location-bar') {
    focusAddressBar(state, page);
    return;
  }

  if (action === 'keyboard-wizard') {
    // The live ticker must not paint into the wizard's alternate screen. Let
    // an in-flight refresh finish before switching screens, then hold later
    // snapshots and text patches until the ordinary browser screen returns.
    const beforeSize = termSize();
    state.mode = 'keyboard';
    while (state.core.live.refreshing) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    state.core.live.refreshing = true;
    let saved;
    try {
      saved = await runKeyWizard({ keymap: state.keys, reader: state.keyReader });
    } finally {
      state.core.live.refreshing = false;
      state.mode = 'browse';
    }
    const afterSize = termSize();
    if (afterSize.rows !== beforeSize.rows || afterSize.cols !== beforeSize.cols) {
      relayout(state);
      render(state, page, { force: true });
    }
    setStatus(state, saved ? 'Keyboard bindings saved.' : 'Keyboard bindings unchanged.');
    return;
  }

  if (action === 'refresh') {
    const previous = state.core.blocks.map((b) => b.text);
    const anchor = anchorFor(state);
    const screen = screenBefore(state);
    await refresh(state, page, { anchor });
    noteChanges(state, previous);
    repaintList(state, page, screen);
    setStatus(state, 'Rescanned.');
    return;
  }

  if (action === 'reload-page') {
    const anchor = anchorFor(state);
    const screen = screenBefore(state);
    setStatus(state, `Reloading ${page.url()}…`);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await refresh(state, page, { anchor });
      repaintList(state, page, screen);
      setStatus(state, `Reloaded ${page.url()}.`);
    } catch (err) {
      setStatus(state, `Could not reload the page: ${String(err.message || err).split('\n')[0]}`);
    }
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
  if (action === 'cycle-view') {
    const viewportRow = state.cursor - state.scroll;
    const anchor = anchorFor(state);
    const place = await withTimeout(
      capturePlace(state, (item) => state.core.handleFor(item, page)),
      ACTION_TIMEOUT_MS, 'Marking your place',
    ).catch(() => null);

    const cycle = state.sources;
    state.core.source = cycle[(cycle.indexOf(state.core.source) + 1) % cycle.length];
    await refresh(state, page);

    const kept = await withTimeout(
      restorePlace(state, page, place), ACTION_TIMEOUT_MS, 'Finding your place',
    ).catch(() => null);
    if (!kept) restoreAnchor(state, anchor);
    clampCol(state);
    preserveViewportRow(state, viewportRow);

    render(state, page);
    setStatus(state, kept === 'exact' || (!place && !kept)
      ? `${SOURCE_LABELS[state.core.source]} view.`
      : `${SOURCE_LABELS[state.core.source]} view — nearest place.`);
    return;
  }

  // Moving past the last line is how the reader asks a feed for more.
  if (action === 'next-line') {
    if (atEnd(state)) return loadMore(state, page);
    return moveSelection(state, state.cursor + 1, page);
  }
  if (action === 'previous-line') return moveSelection(state, state.cursor - 1, page);
  if (action === 'next-character') return moveCaretRight(state, page);
  if (action === 'previous-character') return moveCaretLeft(state, page);
  if (action === 'next-screen') {
    if (atEnd(state)) return loadMore(state, page);
    return moveScreen(state, 1, page);
  }
  if (action === 'previous-screen') return moveScreen(state, -1, page);
  if (action === 'top') return moveSelection(state, 0, page);
  if (action === 'bottom') return moveSelection(state, state.lines.length - 1, page);
  if (action === 'line-start') return moveSelection(state, state.cursor, page, 0);
  if (action === 'line-end') {
    const line = currentLine(state);
    return moveSelection(state, state.cursor, page, line ? line.text.length - 1 : 0);
  }

  if (action === 'history-back') return moveInHistory(state, page, -1);
  if (action === 'history-forward') return moveInHistory(state, page, 1);

  if (action === 'bookmarks') return openLibrary(state, page, 'bookmarks');
  if (action === 'add-bookmark') return bookmarkPage(state, page);
  if (action === 'history') return openLibrary(state, page, 'history');
  if (action === 'downloads') return openLibrary(state, page, 'downloads');
  if (action === 'download-link') return downloadCurrentLink(state, page);

  if (action === 'new-tab') return openNewTab(state);
  if (action === 'next-tab') return cycleTab(state, 1);
  if (action === 'previous-tab') return cycleTab(state, -1);
  if (action === 'close-tab') return closeCurrentTab(state);

  if (action === 'next-change') return jumpToChange(state, page, 1);
  if (action === 'previous-change') return jumpToChange(state, page, -1);

  if (action === 'where') {
    const block = currentBlock(state);
    const total = state.lines.length;
    const role = block && block.item ? block.item.role : 'nothing';
    setStatus(state, `Line ${state.cursor + 1} of ${total}, column ${state.col + 1} — ${role}.`);
    return;
  }

  // A page that updates itself is not always welcome: a clock or a ticker
  // would keep marking changes while you are trying to read something else.
  if (action === 'toggle-live') {
    state.core.live.enabled = !state.core.live.enabled;
    setStatus(state, state.core.live.enabled
      ? 'Live updates on.'
      : 'Live updates off — press r to refresh manually.');
    return;
  }

  // A row that speaks is not always wanted. Turning it off leaves the last
  // message standing, which is what the row said before any of this existed.
  if (action === 'toggle-link-address') {
    state.linkAddress = !state.linkAddress;
    setStatus(state, state.linkAddress
      ? 'Link addresses on.'
      : 'Link addresses off.');
    return;
  }

  // The host is news only when it changes. Saying it on every link of a site
  // the reader is already reading is a sentence of nothing, over and over.
  if (action === 'toggle-short-links') {
    state.shortLinks = !state.shortLinks;
    setStatus(state, state.shortLinks
      ? 'Short link addresses on — links on this site say their path alone.'
      : 'Short link addresses off — links say their full address.');
    return;
  }

  if (action === 'real-click') return clickAsHuman(state, page);

  if (action === 'page-keyboard') {
    // Key repeat can leave another copy of the exit chord queued behind the
    // one that just left page mode. Without this short guard that copy is
    // handled in browse mode and immediately puts the reader back in.
    if ((state.pageKeyboardExitUntil || 0) > Date.now()) return;
    state.mode = 'page';
    drawHint(state);
    const exit = actionKeyLabel(state, 'page-keyboard', 'Alt+K');
    setStatus(state, `Webpage keyboard on — Space can play or pause and m can mute or unmute; ${exit} returns to reading.`);
    return;
  }

  if (action === 'find-forward' || action === 'find-backward') {
    state.mode = 'find';
    state.find = { text: '', caret: 0, direction: action === 'find-forward' ? 1 : -1 };
    drawHint(state);
    drawFind(state);
    return;
  }

  if (action === 'repeat-find') {
    if (!state.lastFind) {
      setStatus(state, 'Nothing searched for yet — press / to search.');
      return;
    }
    return runSearch(state, page, state.lastFind.text, state.lastFind.direction);
  }

  if (action === 'next-paragraph' || action === 'previous-paragraph') {
    const direction = action === 'next-paragraph' ? 1 : -1;
    return jumpTo(state, page, findParagraph(state, direction), 'paragraph', direction);
  }

  if (QUICK_ACTIONS[action]) {
    const spec = QUICK_ACTIONS[action];
    return jumpTo(state, page, findQuickNav(state, spec.match, spec.direction), spec.label, spec.direction);
  }

  if (action === 'browser-question') return reopenPendingDialog(state, page);
  if (action === 'activate') return activateCurrent(state, page);

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

// Arm focus observation against the element Enter is about to activate. The
// before-and-after observation window, rather than document.activeElement at
// some unrelated time, ties a destination to this particular action.
async function watchActivationFocus(state, page, item) {
  const scope = item.frame || page;
  let handle = null;
  try {
    handle = await withTimeout(
      state.core.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating focused control');
    return await armActivationFocus(scope, handle);
  } finally {
    if (handle) await handle.dispose().catch(() => {});
  }
}

// Move only to an exact element represented in this view. Focus is the page's
// explicit keyboard destination; guessing at a nearby line would turn that
// useful signal into an unexplained jump.
async function followActivationFocus(state, page, focused) {
  if (!focused || !focused.handle) return null;
  try {
    const block = await exactBlockForElement({
      source: state.core.source,
      blocks: state.core.blocks,
      lines: state.lines,
    }, page, focused.handle, focused.frame);
    const line = lineForBlock(state, block);
    if (line < 0) return null;
    const item = state.core.blocks[block] && state.core.blocks[block].item;
    moveSelection(state, line, page, 0);
    return item && item.name ? item.name : state.core.blocks[block].text;
  } finally {
    await focused.handle.dispose().catch(() => {});
  }
}

async function beginTyping(state, page, item) {
  const handle = await withTimeout(
    state.core.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating field');
  const editable = await handle.evaluate((el) => {
    const tag = el && el.tagName;
    return !!el && !el.disabled && !el.readOnly
      && (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable);
  });
  if (!editable) {
    await handle.dispose().catch(() => {});
    return false;
  }

  await withTimeout(handle.evaluate((el) => el.focus()), ACTION_TIMEOUT_MS, 'Focusing field');
  const info = await readFieldState(handle);
  state.mode = 'type';
  state.typing = { handle, item, text: info.text, caret: info.caret, drawn: null };
  drawHint(state);
  state.typing.drawn = typingText(state).text;
  writeLine(lineRow(state, state.cursor), state.typing.drawn);
  return true;
}

async function activateCurrent(state, page) {
  const item = itemUnderCursor(state);
  if (!item || item.role === 'text') {
    setStatus(state, 'Nothing to activate on this line.');
    return;
  }

  const previousTexts = state.core.blocks.map((b) => b.text);
  const previousUrl = page.url();
  await rememberCurrentHistoryPlace(state, page);
  const anchor = anchorFor(state);
  const screen = screenBefore(state);
  const fragment = LINK_ROLES.has(item.role) ? await state.core.fragmentOf(item, page) : null;
  let focused = null;

  try {
    setStatus(state, `Activating "${item.name}"...`);
    if (item.role === 'slider') {
      const focused = await state.core.focusControl(item, page);
      if (!focused) throw new Error('the browser could not focus that control');
      state.mode = 'control';
      state.controlling = { item };
      drawHint(state);
      setStatus(state, `Controlling "${item.name}" — use arrows, Home or End; Esc to stop.`);
      return;
    }

    // A file input is pressed by naming a file, not by pressing it. Nothing
    // is clicked here: a click would ask the desktop for a chooser that
    // neither the reader nor this program can reach, and on a machine with no
    // portal it would do nothing whatsoever — which is what it used to do.
    if (item.file) {
      const files = await askForFilePaths(state, {
        asking: item.name, multiple: !!item.file.multiple, accept: item.file.accept || '',
      });
      if (!files || !files.length) {
        setStatus(state, `Nothing attached to "${item.name}".`);
        return;
      }
      await state.core.attachFiles(item, files.map((file) => file.path), page);
      log('files.attached', {
        control: String(item.name).slice(0, 60), files: files.length, engine: state.driver.name,
      });
      await refresh(state, page, { anchor });
      repaintList(state, page, screen);
      setStatus(state, attachedNote(files, item.name));
      return;
    }

    if (FIELD_ROLES.has(item.role) && !item.nativeControl) {
      // A native select is a list of choices, not a field to type into. It
      // came through here as a combobox and landed the reader in typing mode
      // over a control that has no text in it — the only thing typing could
      // ever do there was the browser's own prefix matching, which cannot
      // say which of two entries sharing a prefix was meant.
      const listing = await withTimeout(
        state.core.optionsFor(item, page), ACTION_TIMEOUT_MS, 'Reading the choices');
      if (listing) {
        openChooser(state, page, item, listing);
        return;
      }

      // ARIA also calls select-only widgets comboboxes and listboxes. A div or
      // button carrying that role has no text caret to enter: pressing it is
      // how its choices open. Fall through to ordinary activation rather than
      // putting the reader in a typing mode that can never change it.
      if (await beginTyping(state, page, item)) {
        setStatus(state, `Typing into "${item.name}" — Esc to stop, Enter to submit.`);
        return;
      }
    }

    const focusWatch = await watchActivationFocus(state, page, item).catch(() => null);
    let done;
    try {
      done = await state.core.activate(item, page);
    } catch (err) {
      if (focusWatch) await cancelActivationFocus(focusWatch).catch(() => {});
      throw err;
    }
    focused = focusWatch
      ? await focusedByActivation(focusWatch).catch(() => null)
      : null;
    state.statusMsg = done.status || `Activated: ${item.name}`;
    // If this control says it opens something, follow it: the thing it opens
    // is very often rendered at the end of the document rather than here.
    if (item.controls) state.core.followPopup(item.controls);
  } catch (err) {
    const timedOut = err instanceof ActionTimeout;
    setStatus(state, timedOut
      ? `Gave up activating "${item.name}" after ${ACTION_TIMEOUT_MS / 1000}s — it may be inside a bot check or an unreachable frame.`
      : `Error activating "${item.name}": ${err.message.split('\n')[0]}`);
    log('activate.failed', { name: String(item.name).slice(0, 80), timedOut, source: state.core.source });
    return;
  }

  // A fragment link never left the document, whatever it did to the URL, so
  // the buffer still stands and the reader keeps their place — until we move
  // them deliberately, to where the link actually points.
  if (fragment) {
    await refresh(state, page, { anchor });
    repaintList(state, page, screen);
    const focusName = await followActivationFocus(state, page, focused);
    const jumped = focusName || await jumpToFragment(state, page, fragment);
    log('activate.fragment', { hash: fragment.slice(0, 60), jumped: !!jumped, focused: !!focusName });
    setStatus(state, focusName
      ? `Focus moved to "${focusName}".`
      : (jumped
        ? `Moved to ${fragment}.`
        : `"${item.name}" points at ${fragment}, which is not in this view.`));
    return;
  }

  const followed = await reportAfterAction(state, page, {
    previousTexts, previousUrl, anchor, screen, focused,
  });
  if (!followed) moveToPopup(state, page, item);
}

// A control that opened something takes the reader to it. Without this the
// menu is in the buffer and the reader has no way to know where, which on a
// page that renders it into the end of <body> means it may as well not be
// there.
function moveToPopup(state, page, item) {
  if (!item || !item.controls || !state.core.popup) return;
  const line = lineForBlock(state, state.core.popupAt());
  if (line < 0) return;
  moveSelection(state, line, page, 0);
  setStatus(state, `"${item.name}" opened — Esc closes it.`);
}

// What happened after something was pressed: a different page, a part of this
// one rewritten, or nothing at all. Nothing here moves the reader unless the
// page did — a rebuilt buffer keeps their place by content.
async function reportAfterAction(
  state, page, { previousTexts, previousUrl, anchor, screen = null, focused = null },
) {
  const navigated = page.url() !== previousUrl;
  await refresh(state, page, navigated ? { resetCursor: true } : { anchor });

  // A handle belongs to the old document after navigation and cannot be a
  // destination in the new one. Disposal is still owed even though it cannot
  // be followed.
  const focusName = navigated
    ? (focused && focused.handle ? await focused.handle.dispose().catch(() => {}) : null)
    : await followActivationFocus(state, page, focused);
  const regions = navigated ? [] : noteChanges(state, previousTexts);
  // A different page is a different screen, so there is nothing to compare
  // against and everything to draw. Staying on the same one usually rewrites
  // a line or two.
  if (navigated) render(state, page);
  else repaintList(state, page, screen);

  if (navigated) setStatus(state, state.statusMsg);
  else if (focusName) {
    setStatus(state, `${state.statusMsg} — focus moved to "${focusName}".`);
  } else if (regions.length) {
    setStatus(state, `${state.statusMsg} — ${regions.length} area${regions.length === 1 ? '' : 's'} changed, press c to jump.`);
  } else {
    setStatus(state, `${state.statusMsg} — no visible change.`);
  }
  return !!focusName;
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

// Close an open popup the way a person would: by pressing the control that
// opened it. Leaving it open and merely walking away would leave the page in
// a state the reader cannot see and did not choose.
async function closePopup(state, page) {
  const controls = state.core.popup.controls;
  const index = state.core.blocks.findIndex((block) => block.item && block.item.controls === controls);
  const control = index >= 0 ? state.core.blocks[index].item : null;
  state.core.forgetPopup();
  if (!control) {
    await refresh(state, page, { anchor: anchorFor(state) });
    render(state, page, { force: true });
    return;
  }
  try {
    await withTimeout(state.core.activate(control, page), ACTION_TIMEOUT_MS, 'Closing');
  } catch {
    // It may already be gone; the rebuild below is the truth either way.
  }
  await refresh(state, page, { resetCursor: false });
  const line = lineForBlock(state, state.core.blocks.findIndex(
    (block) => block.item && block.item.controls === controls));
  if (line >= 0) state.cursor = line;
  clampCol(state);
  clampScroll(state);
  render(state, page, { force: true });
  setStatus(state, `Closed "${control.name}".`);
}

async function clickAsHuman(state, page) {
  const item = itemUnderCursor(state);
  if (!item) {
    setStatus(state, 'Nothing on this line to click.');
    return;
  }
  if (!state.core.canRealClick()) {
    setStatus(state, `The ${state.core.driver.name} driver cannot send a real click.`);
    return;
  }

  const previousTexts = state.core.blocks.map((b) => b.text);
  const previousUrl = page.url();
  await rememberCurrentHistoryPlace(state, page);
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

    log('click.real', { name: String(item.name).slice(0, 80), ms: Date.now() - started, source: state.core.source });
    state.statusMsg = `Clicked "${item.name}"`;
  } catch (err) {
    const timedOut = err instanceof ActionTimeout;
    setStatus(state, timedOut
      ? `Gave up clicking "${item.name}" after ${ACTION_TIMEOUT_MS / 1000}s.`
      : `Could not click "${item.name}": ${err.message.split('\n')[0]}`);
    log('click.real.failed', { name: String(item.name).slice(0, 80), timedOut, source: state.core.source });
    return;
  }

  await reportAfterAction(state, page, { previousTexts, previousUrl, anchor, screen });
}

// ---------------------------------------------------------------------------
// Choosing from a dropdown
//
// The core splices the entries into the buffer under the control, so they are
// ordinary lines and everything that works on lines works on them. What this
// adds is a mode: movement that cannot wander out of the list, typing that
// filters our own lines rather than being sent at a control that may have no
// key handler at all, and Enter meaning "this one".
// ---------------------------------------------------------------------------

// The first and last screen line the open dropdown occupies.
function chooserLines(state) {
  const chooser = state.core.chooser;
  if (!chooser || !chooser.count) return null;
  let first = -1;
  let last = -1;
  state.lines.forEach((line, index) => {
    if (line.blockIndex < chooser.at || line.blockIndex >= chooser.at + chooser.count) return;
    if (first < 0) first = index;
    last = index;
  });
  return first < 0 ? null : { first, last };
}

function openChooser(state, page, item, listing) {
  const blockIndex = state.lines[state.cursor] ? state.lines[state.cursor].blockIndex : 0;
  state.core.openChooser(blockIndex, listing);
  // Hold off live rebuilds while the list is open: a refresh would replace
  // the block list and take the entries with it, mid-choice.
  state.core.live.refreshing = true;
  state.mode = 'choose';
  state.chooser = { item, from: blockIndex };

  relayout(state);
  const range = chooserLines(state);
  const chosen = listing.options.findIndex((option) => option.selected);
  const offset = chosen >= 0 ? state.core.chooser.shown.indexOf(chosen) : 0;
  state.cursor = range ? Math.min(range.first + Math.max(offset, 0), range.last) : state.cursor;
  clampScroll(state);
  render(state, page, { force: true });
  setStatus(state, `${listing.options.length} choice${listing.options.length === 1 ? '' : 's'} for "${item.name}" — type to filter, Enter to choose, Esc to cancel.`);
}

function closeChooser(state, page, { note }) {
  const from = state.chooser ? state.chooser.from : 0;
  state.core.closeChooser();
  state.core.live.refreshing = false;
  state.mode = 'browse';
  state.chooser = null;
  relayout(state);
  const line = lineForBlock(state, from);
  if (line >= 0) state.cursor = line;
  clampCol(state);
  clampScroll(state);
  render(state, page, { force: true });
  if (note) setStatus(state, note);
}

async function handleChooseKey(chunk, state, page) {
  markInput(state);
  const chooser = state.core.chooser;
  if (!chooser) { state.mode = 'browse'; return; }

  if (keyIs(chunk, 'Escape', state)) {
    closeChooser(state, page, { note: `Left "${state.chooser.item.name}" as it was.` });
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const line = state.lines[state.cursor];
    const item = line ? state.core.blocks[line.blockIndex].item : null;
    if (!item || item.chooserIndex == null) {
      setStatus(state, 'Move to a choice first.');
      return;
    }
    if (item.disabled) {
      setStatus(state, `"${item.name}" is not available.`);
      return;
    }
    const control = state.chooser.item;
    const chosen = item.name;
    let outcome;
    try {
      outcome = await withTimeout(
        state.core.chooseOption(control, item.chooserIndex, page), ACTION_TIMEOUT_MS, 'Choosing');
    } catch (err) {
      closeChooser(state, page, { note: `Could not choose "${chosen}": ${err.message.split('\n')[0]}` });
      return;
    }
    log('chooser.choose', { control: String(control.name).slice(0, 60), chosen: chosen.slice(0, 60), changed: outcome.changed });
    closeChooser(state, page, { note: null });
    // The page may have reacted to the choice — a region list reloading is
    // the ordinary case — so read it again before saying anything.
    await refresh(state, page, { anchor: anchorFor(state) });
    render(state, page, { force: true });
    setStatus(state, outcome.changed ? `Chose "${chosen}".` : `"${chosen}" was already chosen.`);
    return;
  }

  const range = chooserLines(state);
  if (keyIs(chunk, 'ArrowDown', state)) {
    if (range) moveSelection(state, Math.min(state.cursor + 1, range.last), page);
    return;
  }
  if (keyIs(chunk, 'ArrowUp', state)) {
    if (range) moveSelection(state, Math.max(state.cursor - 1, range.first), page);
    return;
  }
  if (keyIs(chunk, 'PageDown', state)) {
    if (range) moveSelection(state, Math.min(state.cursor + viewportHeight(), range.last), page);
    return;
  }
  if (keyIs(chunk, 'PageUp', state)) {
    if (range) moveSelection(state, Math.max(state.cursor - viewportHeight(), range.first), page);
    return;
  }

  if (keyIs(chunk, 'Backspace', state)) {
    refilter(state, page, chooser.filter.slice(0, -1));
    return;
  }
  if (chunk.startsWith(ESC)) return; // an escape sequence we do not use here
  if (chunk >= ' ') {
    refilter(state, page, chooser.filter + chunk);
    return;
  }
}

function refilter(state, page, filter) {
  const shown = state.core.showChooser(filter);
  relayout(state);
  const range = chooserLines(state);
  if (range) state.cursor = range.first;
  clampCol(state);
  clampScroll(state);
  render(state, page, { force: true });
  setStatus(state, filter
    ? `${shown} of ${state.core.chooser.options.length} matching "${filter}".`
    : `${shown} choice${shown === 1 ? '' : 's'}.`);
}

// ---------------------------------------------------------------------------
// The browser's own lists: bookmarks, history, downloads
//
// These are not pages, so they are not read like one. src/library.js takes
// them out of the profile the browser is using, and what arrives here is a
// list of entries that becomes a buffer of its own — the same lines, cursor
// and wrapping as everything else, so a braille display tracks a bookmark
// exactly as it tracks a paragraph.
//
// It borrows the dropdown's shape rather than the page's, because that is
// what a list of a thousand addresses needs: typing filters instead of
// jumping, since a reader looking for a page they saw yesterday knows a word
// of its title and not its position. The tab underneath is left alone and
// live rebuilds are held, so closing the list puts the reader back on the
// page they were reading, where they were reading it.
// ---------------------------------------------------------------------------

function libraryStatus(state) {
  const { rows, blocks, filter, empty } = state.library;
  if (empty) return filter ? `Nothing matching "${filter}".` : 'Nothing here yet.';
  if (filter) return `${blocks.length} of ${rows.length} matching "${filter}".`;
  return `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} — type to filter.`;
}

// Rebuilds the buffer from whatever the filter now admits. The reader is put
// at the top: after a keystroke that changed which entries exist, the line
// they were on is not the line they would be on, and staying at an index is
// staying nowhere in particular.
function showLibrary(state, page, filter) {
  const lib = state.library;
  lib.filter = filter;
  lib.blocks = lib.rows
    .filter((row) => matches(row.text, filter))
    .map((row) => ({ text: row.text, item: { role: 'link', name: row.text }, entry: row.entry }));
  lib.empty = lib.blocks.length === 0;
  if (lib.empty) {
    lib.blocks = [{ text: libraryStatus(state), item: null, entry: null }];
  }
  state.cursor = 0;
  state.col = 0;
  state.scroll = 0;
  relayout(state);
  render(state, page, { force: true });
  setStatus(state, libraryStatus(state));
}

async function openLibrary(state, page, kind) {
  const label = KIND_LABELS[kind];
  // Asking costs a round trip and, on Chromium, a tab of the browser's own
  // that has to load first. Say so: silence is the one thing a reader cannot
  // interpret.
  setStatus(state, `Reading ${label.toLowerCase()}…`);

  const startedAt = Date.now();
  let entries;
  try {
    entries = await state.driver.readLibrary(kind, page);
  } catch (err) {
    const reason = String(err.message || err).split('\n')[0];
    log('library.error', { kind, engine: state.driver.name, error: reason.slice(0, 200) });
    setStatus(state, `Could not read ${label.toLowerCase()}: ${reason}`);
    return;
  }

  // Hold live rebuilds for the same reason the dropdown does: a refresh would
  // replace the buffer, and the buffer is not the page's any more.
  state.core.live.refreshing = true;
  state.mode = 'library';
  const now = Date.now();
  state.library = {
    kind,
    label,
    filter: '',
    rows: entries.map((entry) => ({ text: entryLine(kind, entry, now), entry })),
    blocks: [],
    empty: false,
    // Where the reader was standing on the page, so closing the list is not a
    // second navigation.
    place: {
      cursor: state.cursor, col: state.col, scroll: state.scroll, title: state.title,
    },
  };
  state.title = `${label} — ${entries.length}`;
  log('library.open', {
    kind, entries: entries.length, engine: state.driver.name, ms: Date.now() - startedAt,
  });
  showLibrary(state, page, '');
}

function closeLibrary(state, page, note) {
  const { place } = state.library;
  state.library = null;
  state.mode = 'browse';
  state.core.live.refreshing = false;
  state.title = place.title;
  relayout(state);
  state.cursor = Math.min(place.cursor, Math.max(state.lines.length - 1, 0));
  state.col = place.col;
  state.scroll = place.scroll;
  clampCol(state);
  clampScroll(state);
  render(state, page, { force: true });
  if (note) setStatus(state, note);
}

async function handleLibraryKey(chunk, state, page) {
  markInput(state);
  const lib = state.library;
  if (!lib) { state.mode = 'browse'; return; }

  if (keyIs(chunk, 'Escape', state)) {
    closeLibrary(state, page, `Closed ${lib.label.toLowerCase()}.`);
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const block = currentBlock(state);
    const entry = block && block.entry;
    if (!entry) {
      setStatus(state, 'Move to an entry first.');
      return;
    }
    if (!entry.url) {
      // A download whose source the browser no longer records. The file is on
      // the line; there is simply nowhere to go.
      setStatus(state, `"${entry.title}" has no address recorded.`);
      return;
    }
    // The list closes before the load, so the reader is put back on the tab
    // and then taken to the page — rather than watching an address load
    // behind a list they can still see.
    closeLibrary(state, page, null);
    await loadAddress(state, page, entry.url);
    return;
  }

  const last = state.lines.length - 1;
  if (keyIs(chunk, 'ArrowDown', state)) return moveSelection(state, Math.min(state.cursor + 1, last), page);
  if (keyIs(chunk, 'ArrowUp', state)) return moveSelection(state, Math.max(state.cursor - 1, 0), page);
  if (keyIs(chunk, 'PageDown', state)) return moveScreen(state, 1, page);
  if (keyIs(chunk, 'PageUp', state)) return moveScreen(state, -1, page);
  if (keyIs(chunk, 'Home', state)) return moveSelection(state, 0, page);
  if (keyIs(chunk, 'End', state)) return moveSelection(state, last, page);

  if (keyIs(chunk, 'Backspace', state)) {
    if (!lib.filter) return;
    showLibrary(state, page, lib.filter.slice(0, -1));
    return;
  }
  if (chunk.startsWith(ESC)) return; // an escape sequence this list has no use for
  if (chunk >= ' ') showLibrary(state, page, lib.filter + chunk);
}

// ---------------------------------------------------------------------------
// Attaching a file
//
// A file input is the one control whose activation is not a press. Pressing
// it asks the desktop for a chooser, and that chooser is not the browser's
// own window: it belongs to the XDG portal, in another process, outside even
// the accessibility tree the browser publishes — and on a machine with no
// portal, which is a terminal with the browser under Xvfb, no chooser appears
// at all. Before this, pressing a file input reported "no visible change",
// which was exactly true and completely useless.
//
// So the browser hands it over instead — `Page.setInterceptFileChooserDialog`
// on Chromium, `input.fileDialogOpened` on Firefox, where a WebDriver session
// suppresses the dialog anyway — and the question is asked here, where a
// terminal is better at it than any dialog: a path, with completion, on a
// machine whose filesystem the reader already knows.
//
// Escaping is safe by construction. No dialog was ever drawn, so there is
// nothing left open anywhere; the input simply gets no files, which is what
// cancelling a chooser has always meant.
// ---------------------------------------------------------------------------

// `~` is the reader's own shorthand and the shell would have expanded it.
// Anything relative is relative to where tawb was started, which is the
// directory the reader was standing in when they typed the command.
function expandPath(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const home = os.homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2));
  return path.resolve(trimmed);
}

// What the reader has typed so far, completed as far as it can go without
// guessing. A directory completes with its separator, so the next Tab carries
// on inside it.
function completePath(text) {
  const typed = String(text || '');
  const expanded = expandPath(typed || '.');
  const endsInSeparator = typed.endsWith('/');
  const dir = endsInSeparator ? expanded : path.dirname(expanded);
  const prefix = endsInSeparator ? '' : path.basename(expanded);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { text: typed, note: `${dir} is not a directory anybody can read.` };
  }
  const matching = entries
    .filter((entry) => entry.name.startsWith(prefix))
    .map((entry) => entry.name + (entry.isDirectory() ? '/' : ''));
  if (!matching.length) return { text: typed, note: `Nothing in ${dir} starts with "${prefix}".` };

  // The longest prefix they all share, which is as far as completing can go
  // without choosing for the reader.
  let common = matching[0];
  for (const name of matching.slice(1)) {
    let at = 0;
    while (at < common.length && at < name.length && common[at] === name[at]) at += 1;
    common = common.slice(0, at);
  }
  const base = typed.slice(0, typed.length - prefix.length);
  const completed = base + common;
  if (matching.length === 1) return { text: completed, note: null };
  return {
    text: completed,
    note: `${matching.length} match: ${matching.slice(0, 6).join('  ')}${matching.length > 6 ? ' …' : ''}`,
  };
}

function fileSize(bytes) {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)}MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)}KB`;
  return `${bytes} bytes`;
}

// A path the browser can actually be given, or why not. The engines answer a
// bad path with nothing useful — Chromium accepts it silently and the page
// gets a file that is not there — so it is checked here first.
function fileToAttach(text) {
  const full = expandPath(text);
  if (!full) return { error: 'no file named' };
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return { error: `there is no ${full}` };
  }
  if (stat.isDirectory()) return { error: `${full} is a directory` };
  try {
    fs.accessSync(full, fs.constants.R_OK);
  } catch {
    return { error: `${full} cannot be read` };
  }
  return { path: full, size: stat.size, name: path.basename(full) };
}

function filePromptText(state) {
  const { label, buffer } = state.files;
  return { text: `${label}: ${buffer.text}`, caretCol: label.length + 2 + buffer.caret + 1 };
}

function drawFilePrompt(state) {
  const cols = termSize().cols;
  const { text, caretCol } = filePromptText(state);
  writeStatusRow(state, text);
  moveCursor(statusRow(), Math.min(caretCol, cols));
}

// Asks for a path, and does not return until there is one or the reader has
// said no. Like the password prompt, this takes the keyboard for itself:
// whatever asked for a file is waiting on the answer.
async function askForFilePaths(state, { asking, multiple = false, accept = '' } = {}) {
  if (!state.keyReader) return null;
  const previousMode = state.mode;
  const previousStatus = state.statusMsg;
  const chosen = [];
  state.mode = 'files';
  state.files = {
    asking, multiple, accept, chosen, label: 'File', buffer: { text: '', caret: 0 },
  };
  log('files.prompt', { asking: String(asking || '').slice(0, 60), multiple, accept: accept.slice(0, 40) });

  const token = state.keyReader.claim();
  drawHint(state, { force: true });
  setStatus(state, accept
    ? `${asking || 'This page'} asks for a file (${accept}). Tab completes, Esc cancels.`
    : `${asking || 'This page'} asks for a file. Tab completes, Esc cancels.`);
  drawFilePrompt(state);

  try {
    for (;;) {
      const chunk = await state.keyReader.next(token);
      // No keyboard, no answer. The chooser is left unanswered, which is a
      // chooser cancelled — nothing is open anywhere to be left behind.
      if (chunk === EOF) return chosen.length ? chosen : null;
      markInput(state);
      const buffer = state.files.buffer;

      if (keyIs(chunk, 'Escape', state)) return chosen.length ? chosen : null;

      if (chunk === '\t') {
        const { text, note } = completePath(buffer.text);
        buffer.text = text;
        buffer.caret = text.length;
        if (note) setStatus(state, note);
        drawFilePrompt(state);
        continue;
      }

      if (chunk === '\r' || chunk === '\n') {
        if (!buffer.text.trim()) {
          // Enter on an empty prompt finishes a list of files, or cancels
          // when there is nothing in it yet.
          return chosen.length ? chosen : null;
        }
        const file = fileToAttach(buffer.text);
        if (file.error) {
          setStatus(state, `Not attached: ${file.error}.`);
          drawFilePrompt(state);
          continue;
        }
        chosen.push(file);
        if (!multiple) return chosen;
        buffer.text = '';
        buffer.caret = 0;
        setStatus(state, `${chosen.length} file${chosen.length === 1 ? '' : 's'} so far`
          + ` — another path, or Enter on an empty line to finish.`);
        drawFilePrompt(state);
        continue;
      }

      const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
      if (editing) applyBufferEdit(buffer, editing);
      else if (keyIs(chunk, 'Ctrl+L', state)) {
        buffer.text = '';
        buffer.caret = 0;
      } else if (!chunk.startsWith(ESC) && chunk >= ' ') {
        buffer.text = buffer.text.slice(0, buffer.caret) + chunk + buffer.text.slice(buffer.caret);
        buffer.caret += chunk.length;
      }
      drawFilePrompt(state);
    }
  } finally {
    state.keyReader.release(token);
    state.mode = previousMode;
    state.files = null;
    state.statusMsg = previousStatus;
    drawHint(state, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Asking for one line
//
// The same shape as the file prompt above, without the completion: a label, a
// buffer with the usual editing keys, Enter for the answer and Escape for
// none. It takes the keyboard the way that one does, because whatever asked
// is waiting on the answer and nothing else should be reading keys meanwhile.
// ---------------------------------------------------------------------------

function drawLinePrompt(state) {
  const cols = termSize().cols;
  const { label, buffer } = state.line;
  const text = `${label}: ${buffer.text}`;
  writeStatusRow(state, text);
  moveCursor(statusRow(), Math.min(label.length + 2 + buffer.caret + 1, cols));
}

// Answers with the line, or null when the reader pressed Escape. An empty
// line is an answer in its own right where the caller wants one; callers that
// do not are the ones that check.
async function askForLine(state, { label, initial = '', hint = '' } = {}) {
  if (!state.keyReader) return null;
  const previousMode = state.mode;
  const previousStatus = state.statusMsg;
  state.mode = 'line';
  state.line = { label, buffer: { text: initial, caret: initial.length } };

  const token = state.keyReader.claim();
  drawHint(state, { force: true });
  if (hint) setStatus(state, hint);
  drawLinePrompt(state);

  try {
    for (;;) {
      const chunk = await state.keyReader.next(token);
      if (chunk === EOF) return null;
      markInput(state);
      const buffer = state.line.buffer;

      if (keyIs(chunk, 'Escape', state)) return null;
      if (chunk === '\r' || chunk === '\n') return buffer.text;

      const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
      if (editing) applyBufferEdit(buffer, editing);
      else if (keyIs(chunk, 'Ctrl+L', state)) {
        buffer.text = '';
        buffer.caret = 0;
      } else if (!chunk.startsWith(ESC) && chunk >= ' ') {
        buffer.text = buffer.text.slice(0, buffer.caret) + chunk + buffer.text.slice(buffer.caret);
        buffer.caret += chunk.length;
      }
      drawLinePrompt(state);
    }
  } finally {
    state.keyReader.release(token);
    state.mode = previousMode;
    state.line = null;
    state.statusMsg = previousStatus;
    drawHint(state, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Downloading the link under the cursor
//
// This is a browser action, not a Node fetch. The browser already owns the
// request's cookies, proxy, certificate decisions, filename rules and download
// history; reproducing any one of those here would make a different download.
// Both engines expose the ordinary Alt-click gesture through their real input
// protocol, which starts the download without taking the current tab away.
// ---------------------------------------------------------------------------

async function downloadCurrentLink(state, page) {
  const item = itemUnderCursor(state);
  if (!item || !LINK_ROLES.has(item.role)) {
    setStatus(state, 'Move to a link before downloading.');
    return;
  }

  setStatus(state, `Downloading "${item.name}"…`);
  try {
    const result = await state.core.downloadLink(item, page);
    if (!result.ok) {
      setStatus(state, `Could not download "${item.name}": ${result.reason}.`);
      return;
    }
    log('link.download', {
      name: String(item.name || '').slice(0, 80), href: String(item.href || '').slice(0, 160),
    });
    setStatus(state, `Added "${item.name}" to downloads.`);
  } catch (err) {
    const reason = String(err.message || err).split('\n')[0];
    log('link.download.error', { name: String(item.name || '').slice(0, 80), error: reason.slice(0, 160) });
    setStatus(state, `Could not download "${item.name}": ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Filing the page
//
// Ctrl+D, which is what every browser files a page with. The bookmark goes
// into the browser's own tree — the same one Ctrl+O lists and the same one
// the browser's own star writes to — because a bookmark a reader cannot see
// in their browser is not a bookmark, it is a note in a second program.
//
// A browser offers the page's title as the name and lets you change it before
// it is saved. So does this, with the title already in the buffer: Enter
// accepts it, and Escape files nothing. That last part differs from a
// graphical browser, where Escape dismisses the bubble and leaves the bookmark
// saved — but Escape here has meant "leave this alone" everywhere else,
// including on the browser's own dialogs, and a reader who cannot reopen a
// bubble to undo it needs the key that backs out to back out.
// ---------------------------------------------------------------------------

async function bookmarkPage(state, page) {
  if (typeof state.driver.saveBookmark !== 'function') {
    setStatus(state, `${state.driver.name} cannot be asked to file a bookmark.`);
    return;
  }
  const url = page.url();
  if (!url || /^about:blank$/i.test(url)) {
    setStatus(state, 'There is no page here to bookmark.');
    return;
  }

  // The page's own title, which is what the browser would offer. A page that
  // never titled itself is offered its address, since a bookmark with no name
  // is one nobody will find again.
  const suggested = (state.title || '').trim() || url;
  const name = await askForLine(state, {
    label: 'Bookmark',
    initial: suggested,
    hint: `Bookmark ${shortAddress(url)} — Enter: save  Esc: do not.`,
  });
  if (name === null) { setStatus(state, 'Not bookmarked.'); return; }

  setStatus(state, 'Filing it…');
  let saved;
  try {
    saved = await state.driver.saveBookmark({ url, title: name.trim() || suggested }, page);
  } catch (err) {
    const reason = String(err.message || err).split('\n')[0];
    log('bookmark.error', { engine: state.driver.name, error: reason.slice(0, 200) });
    setStatus(state, `Could not bookmark it: ${reason}`);
    return;
  }

  const where = saved.folder ? ` in ${saved.folder}` : '';
  log('bookmark.save', { engine: state.driver.name, existed: !!saved.existed });
  setStatus(state, saved.existed
    // A browser does not file a page twice; its star opens the editor instead.
    // Saying which name it is already under is what tells the reader they are
    // looking at the same page under a name they chose months ago.
    ? `Already bookmarked as "${saved.title}"${where} — not filed again.`
    : `Bookmarked "${saved.title}"${where}.`);
}

// Back to a question the reader stepped away from.
//
// The dialog is read again rather than replayed: while it was left alone the
// browser may have closed it, or changed what it says — a save-password
// prompt whose username the reader edited in the browser is not the prompt
// they escaped from.
async function reopenPendingDialog(state, page) {
  const pending = state.pendingDialog;
  if (!pending) {
    setStatus(state, 'The browser is not asking anything.');
    return;
  }
  const open = await pending.stillOpen().catch(() => false);
  if (!open) {
    state.pendingDialog = null;
    setStatus(state, 'The browser is no longer asking that.');
    return;
  }
  const again = await pending.reread().catch(() => null);
  await answerNativeDialog(state, again || pending);
}

// What to say afterwards, which is the browser's business as much as ours:
// the page has had its change event by now.
function attachedNote(files, asking) {
  if (!files || !files.length) return `Nothing attached to "${asking}".`;
  if (files.length === 1) {
    return `Attached ${files[0].name} (${fileSize(files[0].size)}) to "${asking}".`;
  }
  return `Attached ${files.length} files to "${asking}": `
    + files.map((file) => file.name).join(', ');
}

// ---------------------------------------------------------------------------
// A dialog the browser drew for itself
//
// The browser asks things in windows of its own: an extension wanting
// consent, a file to be chosen, permission for something. None of them are
// documents, none of them are in either protocol, and a reader of a page
// cannot see one however hard they look — which before this meant a browser
// silently waiting for an answer nobody could give.
//
// It is the same move as the password prompt. The dialog's own words go on
// the terminal, the reader answers there, and the answer presses the dialog's
// own button. Nothing is bypassed and nothing is decided for them: what is on
// screen is what Chrome's own confirmation says, including the list of what
// an extension will be able to do, because that list is the reason the
// question is being asked at all.
//
// It borrows the library's shape — a buffer of its own, with the choices as
// lines to move to and press — so the question can be read at whatever pace
// reading takes, on a braille display or by ear, before anything is answered.
// ---------------------------------------------------------------------------

// Escape presses the button the dialog itself has focused, and says which one
// that was. On Chrome's install prompt that is Cancel, not Add: the browser's
// own idea of the safe answer is the one it would give if Enter were pressed
// blind, and taking it over means keeping that rather than inventing one.
// How long to let the browser act on a press before deciding whether it did.
const PRESS_SETTLE_MS = 400;

function toggleText(toggle) {
  return `[${toggle.checked ? 'x' : ' '}] ${toggle.name}`;
}

function dialogBlocks(dialog) {
  const said = dialog.lines.map((text) => ({ text, item: null, button: null, toggle: null }));
  // What the dialog is about, when that lives in a control rather than in its
  // words — the username and password a "Save password?" prompt is offering
  // to keep. The browser masks the password itself, so what is shown here is
  // what is on the screen a sighted user would be looking at.
  const held = (dialog.fields || [])
    .filter((field) => field.name || field.value)
    .map((field) => ({
      text: field.name && field.value ? `${field.name}: ${field.value}` : (field.value || field.name),
      item: null,
      button: null,
      toggle: null,
    }));
  // Options first, because they change what answering means: Firefox's
  // doorhanger offers "Allow extension to run in private windows", and that
  // is a decision made before the answer rather than after it.
  const options = (dialog.toggles || []).map((toggle) => ({
    text: toggleText(toggle),
    item: { role: 'checkbox', name: toggle.name },
    button: null,
    toggle,
  }));
  const choices = dialog.buttons.map((button) => ({
    text: button.name,
    item: { role: 'button', name: button.name },
    button,
    toggle: null,
  }));
  const gap = { text: '', item: null, button: null, toggle: null };
  if (!choices.length && !options.length) {
    return [...said, ...held, {
      text: '(the browser offers nothing to press)', item: null, button: null, toggle: null,
    }];
  }
  return [
    ...said, ...held, gap,
    ...options, ...(options.length && choices.length ? [gap] : []), ...choices,
  ];
}

function closeNativeDialog(state, page, note) {
  const { place } = state.dialog;
  state.dialog = null;
  state.mode = 'browse';
  state.core.live.refreshing = false;
  state.title = place.title;
  relayout(state);
  state.cursor = Math.min(place.cursor, Math.max(state.lines.length - 1, 0));
  state.col = place.col;
  state.scroll = place.scroll;
  clampCol(state);
  clampScroll(state);
  render(state, page, { force: true });
  if (note) setStatus(state, note);
}

// Asks, and does not return until the dialog has been answered or the reader
// has decided to leave it. The watcher awaits this: one question at a time is
// the only number a single terminal can put to somebody.
async function answerNativeDialog(state, dialog) {
  if (!state.keyReader || state.mode === 'dialog') return;
  const page = state.core.page;
  // Hold live rebuilds for the same reason the library does: a refresh would
  // replace a buffer that is no longer the page's.
  state.core.live.refreshing = true;
  const previousMode = state.mode;
  state.mode = 'dialog';
  state.dialog = {
    ...dialog,
    blocks: dialogBlocks(dialog),
    place: {
      cursor: state.cursor, col: state.col, scroll: state.scroll, title: state.title,
    },
  };
  state.cursor = 0;
  state.col = 0;
  state.scroll = 0;
  state.title = dialog.title || 'The browser is asking';
  relayout(state);
  render(state, page, { force: true });
  drawHint(state, { force: true });
  setStatus(state, 'The browser is asking. Move to an answer and press Enter.');
  log('native.prompt', {
    title: String(dialog.title || '').slice(0, 80),
    buttons: dialog.buttons.map((button) => button.name).join(' / ').slice(0, 80),
  });

  state.pendingDialog = null;
  const token = state.keyReader.claim();
  // Pressed, and then checked. A button that answers "yes, pressed" while the
  // dialog stays where it is has not done anything — the browser can decline
  // a press, and telling the reader their answer went in when it did not is
  // worse than telling them nothing.
  const press = async (button, how) => {
    try {
      await dialog.press(button);
    } catch (err) {
      log('native.press.failed', { button: button.name, error: String(err.message || err).slice(0, 120) });
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, PRESS_SETTLE_MS));
    const answered = !(await dialog.stillOpen().catch(() => false));
    log('native.answered', { button: button.name, how, answered });
    return answered;
  };

  try {
    for (;;) {
      const chunk = await state.keyReader.next(token);
      // The keyboard has gone. The browser is left holding its question,
      // which is the same thing that happens to a sighted user who walks
      // away, and is better than answering it on their behalf.
      if (chunk === EOF) {
        closeNativeDialog(state, page, null);
        return;
      }
      markInput(state);

      if (keyIs(chunk, 'Escape', state)) {
        // Nothing is pressed. Escaping used to press whichever button the
        // dialog had focused, on the grounds that it was the browser's own
        // safe answer — and on Chrome's extension prompt it is, since that
        // focuses Cancel. Then the password prompt turned up, which focuses
        // Save: escaping would have saved a password the reader was trying to
        // walk away from. A key that means "leave this alone" must leave it
        // alone, so the question stays open and Alt+Q comes back to it.
        state.pendingDialog = dialog;
        closeNativeDialog(state, page,
          'Left the browser asking — nothing was pressed. Alt+Q goes back to it.');
        return;
      }

      if (chunk === '\r' || chunk === '\n') {
        const block = currentBlock(state);
        // An option is ticked in place and the dialog stays up: it is part of
        // the question, not an answer to it.
        if (block && block.toggle) {
          const now = await dialog.toggle(block.toggle).catch(() => null);
          if (now == null) {
            setStatus(state, `Could not change "${block.toggle.name}".`);
            continue;
          }
          block.toggle.checked = now;
          block.text = toggleText(block.toggle);
          const at = state.cursor;
          relayout(state);
          state.cursor = Math.min(at, Math.max(state.lines.length - 1, 0));
          render(state, page, { force: true });
          setStatus(state, `${block.toggle.name}: ${now ? 'yes' : 'no'}.`);
          continue;
        }
        const button = block && block.button;
        if (!button) {
          setStatus(state, 'Move to one of the answers first.');
          continue;
        }
        const pressed = await press(button, 'chosen');
        closeNativeDialog(state, page, pressed
          ? `Pressed "${button.name}".`
          : `Pressed "${button.name}", but the browser has not closed the dialog.`);
        return;
      }

      const last = state.lines.length - 1;
      if (keyIs(chunk, 'ArrowDown', state)) { moveSelection(state, Math.min(state.cursor + 1, last), page); continue; }
      if (keyIs(chunk, 'ArrowUp', state)) { moveSelection(state, Math.max(state.cursor - 1, 0), page); continue; }
      if (keyIs(chunk, 'PageDown', state)) { moveScreen(state, 1, page); continue; }
      if (keyIs(chunk, 'PageUp', state)) { moveScreen(state, -1, page); continue; }
      if (keyIs(chunk, 'Home', state)) { moveSelection(state, 0, page); continue; }
      if (keyIs(chunk, 'End', state)) { moveSelection(state, last, page); continue; }

      // Every other key, including the ones that would do something on a
      // page. A reader who presses `q` at a question the browser is holding
      // open should be told why nothing happened rather than left wondering
      // whether the terminal has stopped listening.
      if (!chunk.startsWith(ESC)) {
        setStatus(state, 'Move to an answer and press Enter, or Escape to leave it unanswered.');
      }
    }
  } finally {
    state.keyReader.release(token);
    if (state.dialog) closeNativeDialog(state, page, null);
    if (state.mode === 'dialog') state.mode = previousMode;
    drawHint(state, { force: true });
  }
}

async function handleTypeKey(chunk, state, page) {
  markInput(state);
  const t = state.typing;
  if (!t) { state.mode = 'browse'; return; }
  const oldCaretCol = typingText(state).caretCol;
  const outputGeneration = terminalGeneration;

  if (keyIs(chunk, 'Escape', state)) {
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

  if (keyIs(chunk, 'Tab', state) || keyIs(chunk, 'Shift+Tab', state)) {
    const direction = keyIs(chunk, 'Shift+Tab', state) ? -1 : 1;
    const screen = screenBefore(state);
    const anchor = anchorFor(state);
    state.mode = 'browse';
    state.typing = null;
    await t.handle.dispose().catch(() => {});
    await refresh(state, page, { anchor });
    repaintList(state, page, screen);

    const action = direction > 0 ? 'next-focusable' : 'previous-focusable';
    const spec = QUICK_ACTIONS[action];
    const found = findQuickNav(state, spec.match, direction);
    if (!found) {
      setStatus(state, `No ${direction > 0 ? 'next' : 'previous'} control.`);
      return;
    }
    moveSelection(state, found.line, page, found.col);
    const block = currentBlock(state);
    const item = block && block.item;
    const name = item ? item.name : spec.label;
    // Tab between editable fields stays in typing mode. Buttons, links and
    // select-only widgets stay in forms mode: they are not activated merely
    // by receiving focus, but Tab can continue through the form from them.
    if (item && FIELD_ROLES.has(item.role) && await beginTyping(state, page, item)) {
      setStatus(state, `Typing into "${name}" — Tab: next control, Esc: stop, Enter: submit.`);
      return;
    }
    state.mode = 'forms';
    drawHint(state);
    setStatus(state, `${direction > 0 ? 'Next' : 'Previous'} control: ${name}.`);
    return;
  }

  if (chunk === '\r' || chunk === '\n') {
    const previousUrl = page.url();
    await rememberCurrentHistoryPlace(state, page);
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

  const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
  if (editing) {
    await sendFieldEdit(page.keyboard, editing);
  } else if (chunk.startsWith(ESC) || chunk < ' ') {
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
  patchEditedLine(row, t.drawn, text, {
    // Browser editing is asynchronous. Use nano's relative update when no
    // concurrent refresh touched the terminal, and an absolute start when one
    // did; either way the complete edit is one write.
    currentCol: terminalGeneration === outputGeneration ? oldCaretCol : null,
    finalCol: caretCol,
  });
  t.drawn = text;
}

async function handleFormsKey(chunk, state, page) {
  markInput(state);
  if (keyIs(chunk, 'Escape', state)) {
    state.mode = 'browse';
    drawHint(state);
    setStatus(state, 'Left forms mode.');
    return;
  }
  if (chunk === '\r' || chunk === '\n') {
    await activateCurrent(state, page);
    return;
  }
  if (!keyIs(chunk, 'Tab', state) && !keyIs(chunk, 'Shift+Tab', state)) return;

  const direction = keyIs(chunk, 'Shift+Tab', state) ? -1 : 1;
  const screen = screenBefore(state);
  const anchor = anchorFor(state);
  await refresh(state, page, { anchor });
  repaintList(state, page, screen);
  const spec = QUICK_ACTIONS[direction > 0 ? 'next-focusable' : 'previous-focusable'];
  const found = findQuickNav(state, spec.match, direction);
  if (!found) {
    setStatus(state, `No ${direction > 0 ? 'next' : 'previous'} control.`);
    return;
  }
  moveSelection(state, found.line, page, found.col);
  const block = currentBlock(state);
  const item = block && block.item;
  const name = item ? item.name : spec.label;
  if (item && FIELD_ROLES.has(item.role) && await beginTyping(state, page, item)) {
    setStatus(state, `Typing into "${name}" — Tab: next control, Esc: stop, Enter: submit.`);
    return;
  }
  state.mode = 'forms';
  setStatus(state, `${direction > 0 ? 'Next' : 'Previous'} control: ${name}.`);
}

async function handleControlKey(chunk, state, page) {
  markInput(state);
  const controlling = state.controlling;
  if (!controlling) { state.mode = 'browse'; return; }

  if (keyIs(chunk, 'Escape', state) || chunk === '\r' || chunk === '\n') {
    state.mode = 'browse';
    state.controlling = null;
    drawHint(state);
    setStatus(state, `Stopped controlling "${controlling.item.name}".`);
    return;
  }

  const names = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
  const name = names.find((candidate) => keyIs(chunk, candidate, state));
  if (!name) return;

  let adjusted;
  try {
    adjusted = await state.core.adjustControl(controlling.item, name, page);
  } catch (err) {
    setStatus(state, `Could not adjust "${controlling.item.name}": ${String(err.message || err).split('\n')[0]}`);
    return;
  }
  const screen = screenBefore(state);
  await refresh(state, page, { anchor: anchorFor(state) });
  repaintList(state, page, screen);
  if (!adjusted.changed) {
    setStatus(state, `The page ignored ${name} on "${controlling.item.name}".`);
  } else if (adjusted.fallback) {
    setStatus(state, `Adjusted "${controlling.item.name}" with its visual slider because it ignored ${name}.`);
  } else {
    setStatus(state, `Adjusted "${controlling.item.name}" with ${name}.`);
  }
}

async function handlePageKey(chunk, state, page) {
  markInput(state);
  const keys = state.keys || FALLBACK_KEYMAP;

  // The same configurable key enters and leaves this mode. Everything else,
  // including Escape, Ctrl+L, arrows and ordinary browse-mode commands, is
  // deliberately the webpage's rather than ours.
  if (keys.actionFor(chunk) === 'page-keyboard') {
    state.mode = 'browse';
    state.pageKeyboardExitUntil = Date.now() + 1500;
    // Do not hold the keyboard while taking a potentially multi-second
    // snapshot. Besides making the exit feel broken, key repeat queued a
    // second toggle behind that wait and re-entered page mode as soon as the
    // snapshot ended. The ordinary live-refresh path already knows how to
    // rebuild without racing subsequent input, so ask it to do so when the
    // reader becomes idle.
    if (state.core.live) {
      state.core.live.dirty = true;
      state.core.live.lastPulseMs = 0;
    }
    drawHint(state);
    setStatus(state, state.core.live && state.core.live.enabled
      ? 'Webpage keyboard off — the page will rescan when you pause.'
      : 'Webpage keyboard off — press r to rescan.');
    return;
  }

  const name = browserKeyForTerminalSequence(chunk, keys);
  if (!name) {
    setStatus(state, 'That terminal key cannot be sent to the webpage.');
    log('key.passthrough.unknown', { bytes: JSON.stringify(chunk) });
    return;
  }

  try {
    await page.keyboard.press(name);
  } catch (err) {
    setStatus(state, `Could not send ${keys.nameForSequence(chunk)} to the webpage: ${String(err.message || err).split('\n')[0]}`);
  }
}

async function handleFindKey(chunk, state, page) {
  markInput(state);
  const find = state.find;

  if (keyIs(chunk, 'Escape', state) || keyIs(chunk, 'Ctrl+C', state)) {
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

  const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
  if (editing) applyBufferEdit(find, editing);
  else if (!chunk.startsWith(ESC) && chunk >= ' ') {
    find.text = find.text.slice(0, find.caret) + chunk + find.text.slice(find.caret);
    find.caret += chunk.length;
  }

  drawFind(state);
}

// Going somewhere, from wherever the address came from — the address bar, or
// a line in one of the browser's own lists.
async function loadAddress(state, page, url) {
  await rememberCurrentHistoryPlace(state, page);
  setStatus(state, `Loading ${url} — Esc: stop.`);
  const went = await navigateInterruptibly(state, page, url);
  if (went.cancelled) {
    render(state, page, { force: true });
    setStatus(state, `Stopped loading ${url}.`);
    return went;
  }
  // Read the tab whether or not the navigation succeeded: a refusal leaves
  // the browser's own warning page in it, and that page is where the reader
  // finds out why and how to go on anyway.
  if (went.ok) await refresh(state, page, { resetCursor: true });
  else await settleAfterFault(state, page);
  render(state, page, { force: true });
  setStatus(state, went.ok
    ? `Loaded ${page.url()}`
    : `${url} was refused — ${went.fault}. The browser's own warning is on screen.`);
  return went;
}

async function handleAddressKey(chunk, state, page) {
  markInput(state);
  const a = state.address;

  if (keyIs(chunk, 'Escape', state)) {
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
    // An address bar takes an address when it is given one and searches when
    // it is not — see address.js for which is which. Words are not an address
    // with a scheme missing, and treating them as one is how a browser sends
    // you nowhere.
    const resolved = resolveAddress(target, { search: state.search || DEFAULT_SEARCH });
    if (resolved.error) { drawAddress(state, page, { force: true }); parkCursor(state); return; }
    // https://user:password@host is deprecated for subresources in Chrome and
    // interrupted by a confirmation of its own in Firefox, so the pair is
    // taken out here and used to answer the challenge instead. It also keeps
    // the password out of the address this session then goes on holding.
    const { url, username, password } = splitCredentials(resolved.url);
    if (username && state.credentials) {
      state.credentials.remember({ url }, { username, password: password || '' });
    }
    // Say that a search happened. A reader who typed a host name with a typo
    // in it is otherwise handed a results page with no account of why.
    if (resolved.searched) setStatus(state, `Searching for "${resolved.words}"…`);
    await loadAddress(state, page, url);
    return;
  }

  const editing = editAction(chunk, state.keys || FALLBACK_KEYMAP);
  if (editing) applyBufferEdit(a, editing);
  else if (keyIs(chunk, 'Ctrl+L', state)) {
    a.text = '';
    a.caret = 0;
  } else if (!chunk.startsWith(ESC) && chunk >= ' ') {
    a.text = a.text.slice(0, a.caret) + chunk + a.text.slice(a.caret);
    a.caret += chunk.length;
  }

  drawAddress(state, page, { edit: true });
}

// ---------------------------------------------------------------------------

async function main() {
  const logPath = ARGS.log ? enableLog({ directory: ARGS.logDir }) : null;
  if (ARGS.keyboard) {
    await runKeyWizard();
    return;
  }

  const keys = new Keymap();
  log('start', {
    url: START_URL, logPath, connect: ARGS.connect || null, engine: ARGS.engine,
  });

  // Either attach to a browser the user is already running, or start an
  // ordinary one ourselves. There is deliberately no Playwright-launched
  // fallback: that browser announces itself as automated, and sites that
  // react to it leave the reader stuck on pages that never resolve.
  //
  // This is before the full-screen interface takes the terminal. If the wait
  // lasts ten seconds, give it one stable, screen-reader-friendly status line;
  // browser-specific startup phases replace it as they advance. A normal
  // quick start stays quiet.
  const startup = startupStatus();
  startup.update(`Starting ${ARGS.engine === 'firefox' ? 'Firefox' : 'Chromium'}…`);
  let driver;
  try {
    driver = await timed('browser.start', { engine: ARGS.engine }, () =>
      openDriver({
        engine: ARGS.engine,
        connect: ARGS.connect,
        profile: ARGS.profile,
        keepBrowser: ARGS.keepBrowser,
        log,
        onStartup: startup.update,
      }));
  } finally {
    startup.finish();
  }
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

  const sources = ALL_SOURCES.filter(
    (source) => !['ax', 'inspect'].includes(source) || driver.capabilities?.ax !== false);
  const core = new Core({ driver, page, source: sources[0], sources, browserPort });
  const state = {
    core,
    keys,
    keyReader: null,
    credentials: null,
    sources,
    browserPort,
    // Where words typed in the address bar go looking. See --search.
    search: ARGS.search || DEFAULT_SEARCH,
    // The browser itself, which is what answers for its own bookmarks,
    // history and downloads. Each engine reaches them its own way; see
    // driver.js.
    driver,
    // Nothing may follow a tab until the first page is drawn: the browser
    // reports the tab we open ourselves at startup as new, like any other.
    ready: false,
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    statusMsg: '',
    // 'browse' | 'choose' | 'library' | 'type' | 'control' | 'page' | 'address'
    // | 'find' | 'auth' | 'dialog' | 'line' | 'keyboard'
    mode: 'browse',
    typing: null,
    controlling: null,
    chooser: null,
    // One of the browser's own lists, while it is open. See openLibrary().
    library: null,
    // A dialog the browser drew for itself, while the reader is answering it.
    // See answerNativeDialog().
    dialog: null,
    // A file the browser is waiting to be given. See askForFilePaths().
    files: null,
    // One line being typed on the status line — a bookmark's name, so far.
    // See askForLine().
    line: null,
    // A question the browser asked that the reader stepped away from, kept so
    // Alt+Q can go back to it. See answerNativeDialog().
    pendingDialog: null,
    // The watch that notices one. Null where the browser cannot describe its
    // own windows, which is not an error — see driver.watchNativeDialogs.
    nativeWatch: null,
    address: null,
    find: null,
    lastFind: null,
    auth: null,
    title: '',
    drawn: { title: null, address: null, hint: null, status: null },
    linkAddress: ARGS.linkAddress,
    shortLinks: ARGS.shortLinks,
    escapeUnicode: ARGS.escapeUnicode,
    statusHeldUntil: 0,
    loadingMore: false,
    pageKeyboardExitUntil: 0,
    // Until the reader acts, dynamic startup content should continue to open
    // at its beginning rather than following a transient first item downward.
    inputSeen: false,
    historyPlaces: new WeakMap(),
  };
  relayout(state);

  // The terminal is taken before the first navigation rather than after it,
  // because the address the reader started with may be the protected one, and
  // a password prompt with no keyboard to answer it on is a page that never
  // loads.
  setupRawInput();
  const keyReader = new KeyReader(process.stdin);
  state.keyReader = keyReader;
  writeTerminal('\x1b[2J');

  // Passwords are asked for here rather than in a browser dialog the reader
  // cannot see. Nothing is written down: what the reader types answers this
  // session's challenges and goes no further.
  const credentials = new Credentials({
    ask: (challenge, info) => askForPassword(state, challenge, info),
    log,
  });
  state.credentials = credentials;
  await driver.attachAuth((challenge, id) => credentials.answer(challenge, id)).catch(() => {});

  // A file chooser the browser was about to ask the desktop for. It never
  // gets that far: the browser hands it over, the reader names a file here,
  // and the input is given it. Escaping leaves the input with no files, which
  // is a cancelled chooser and leaves nothing open anywhere.
  //
  // This is the path for a chooser raised by something other than the input
  // itself — the "Upload" button that clicks a hidden input, which is most of
  // the upload widgets on the web and has no control a reader could find.
  if (driver.attachFileChooser) {
    await driver.attachFileChooser(async (request) => {
      const files = await askForFilePaths(state, {
        asking: 'The page', multiple: !!request.multiple,
      });
      if (!files || !files.length) {
        // Told, rather than left: Firefox holds a chooser it has not been
        // answered about and will raise no other until it is.
        await request.cancel().catch(() => {});
        setStatus(state, 'No file given to the page.');
        return;
      }
      await request.setFiles(files.map((file) => file.path)).catch((err) => {
        setStatus(state, `The browser refused the file: ${String(err.message || err).split('\n')[0]}`);
        throw err;
      });
      log('files.given', { files: files.length, engine: driver.name });
      setStatus(state, attachedNote(files, 'the page'));
    }).catch(() => {});
  }

  // The browser's own dialogs, answered here too. An extension asking for
  // consent is drawn in a window rather than a document — the same problem
  // the password prompt has, and the same answer: the question is read out on
  // the terminal and the reader's choice presses the browser's own button.
  //
  // Nothing is arranged if the browser cannot describe its windows. That is
  // an ordinary state of affairs — a browser somebody else started, a machine
  // with no D-Bus — and it costs a reader who never installs anything nothing
  // at all.
  state.nativeWatch = driver.watchNativeDialogs
    ? await driver.watchNativeDialogs((dialog) => answerNativeDialog(state, dialog)).catch(() => null)
    : null;

  // Claim whichever tab we ended up on, including one we just opened and one
  // in a browser we started: the session that joins later is the one that
  // needs to know to leave it alone.
  await core.adoptTab(page);
  let opening = { ok: true, fault: null };
  if (!adopted) {
    opening = await timed('goto', { url: START_URL }, () => navigate(page, START_URL));
  }
  await core.rescan();
  if (!opening.ok && !core.blocks.length) await settleAfterFault(state, page);
  state.title = await readTitle(page);
  relayout(state);
  render(state, page, { force: true });
  if (!opening.ok) {
    setStatus(state, `${START_URL} was refused — ${opening.fault}. `
      + "The browser's own warning is on screen.");
  }

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
    if (state.mode === 'keyboard') return; // the wizard owns its alternate screen
    relayout(state);
    writeTerminal('\x1b[2J');
    render(state, state.core.page, { force: true });
  });

  const counterTimer = setInterval(() => {
    flushCounters({
      refreshes: state.core.live.refreshes, lines: state.lines.length, source: state.core.source,
    });
  }, 5000);
  if (counterTimer.unref) counterTimer.unref();

  let running = true;
  while (running) {
    const chunk = await keyReader.next();
    // Nothing can be read for somebody who has no keyboard. Leaving by the
    // same door as `q` is what makes the browser be told, the tab claim be
    // given back and the terminal be put right.
    if (chunk === EOF) { log('input.eof', {}); running = false; break; }
    markInput(state);

    const t0 = Date.now();
    let result;
    // state.core.page, not the page this loop began with: `<` and `>` move the
    // reader between tabs and every handler must act on the one they are on.
    const current = state.core.page;
    if (state.mode === 'choose') result = await handleChooseKey(chunk, state, current);
    else if (state.mode === 'library') result = await handleLibraryKey(chunk, state, current);
    else if (state.mode === 'type') result = await handleTypeKey(chunk, state, current);
    else if (state.mode === 'forms') result = await handleFormsKey(chunk, state, current);
    else if (state.mode === 'control') result = await handleControlKey(chunk, state, current);
    else if (state.mode === 'page') result = await handlePageKey(chunk, state, current);
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
  if (state.nativeWatch) state.nativeWatch.stop();
  keyReader.close();
  flushCounters({ refreshes: state.core.live.refreshes });
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
  writeTerminal('\n');
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
  restoreInvocationDirectory();

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
  handleBrowseKey, handleTypeKey, handleFormsKey, handleControlKey, handlePageKey,
  handleAddressKey, handleFindKey, browserKeyForTerminalSequence,
  findText, runSearch,
  render, drawList, drawAddress, drawHint, drawStatus, setStatus,
  patchEditedLine, moveSelection, moveScreen, preserveViewportRow,
  moveCaretLeft, moveCaretRight, lineRow, relayout, viewportHeight,
  itemUnderCursor, linkTarget, shortTarget,
  findQuickNav, findParagraph, currentLine, currentBlock, QUICK_ACTIONS,
  clickAsHuman, reportAfterAction,
  expandPath, completePath, fileToAttach, fileSize, attachedNote,
  anchorFor, restoreAnchor, capturePlace, restorePlace, jumpToChange, activateCurrent, ALL_SOURCES,
  attachLive, onLiveEvent, runLiveRefresh, patchVisibleRows, reanchorQuietly,
  markInput, keepLivePlace,
  screenBefore, repaintList, visibleRowsNow,
  applyTextPatches, loadMore, atEnd,
  historyEntryIdentity, rememberHistoryPlace, rememberCurrentHistoryPlace,
  restoreHistoryPlace, acknowledgeHistoryNavigation, traversePageHistory, moveInHistory,
  switchToTab, focusAddressBar, openNewTab, cycleTab, closeCurrentTab, onNewTab,
  sameDocumentFragment, findBlockWithText, jumpToFragment,
  renderRow, typingText, parseArgs, restoreInvocationDirectory, onExternalNavigation, readTitle, drawTitle,
  navigate, navigateInterruptibly, navigationFault, settleAfterFault,
  handleAuthKey, authPromptText, askForPassword,
  openLibrary, closeLibrary, showLibrary, handleLibraryKey,
  askForLine, bookmarkPage, downloadCurrentLink, drawLinePrompt,
};
