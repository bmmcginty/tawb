'use strict';

// Lynx's Printing Options screen, and the one option TAWB implements.
//
// Real Lynx opens this screen from `p` (PRINT) and offers saving, mailing,
// printing to the screen, and printing to a printer. TAWB keeps the same
// screen and the same route to a file, but only offers the first of those:
// saving the page as it is displayed. The screen is drawn directly, like the
// Options menu, so its rows and cursor are the reader's screen rather than the
// page list underneath it.

const { ANSI_REVERSE, ANSI_RESET } = require('./lynx_display');

const TITLE = '              Printing Options (TAWB Lynx interface)';
const SAVE_LABEL = '   Save to a local file';
const INSTRUCTION = "Commands: Use arrow keys to move, '?' for help, 'q' to quit, '<-' to go back.";
const ONLY_OPTION = 'Save to a local file is the only print option TAWB offers.';
const CANCELLED = 'Printing cancelled.';
const FILE_PROMPT_LABEL = 'Enter a filename';
const PAGE_LINES = 66;

function pageCountFor(lineCount) {
  const count = Math.max(0, Number(lineCount) || 0);
  return Math.max(1, Math.ceil(count / PAGE_LINES));
}

function pageLabel(lineCount) {
  const pages = pageCountFor(lineCount);
  return `${pages} page${pages === 1 ? '' : 's'} (approximately)`;
}

function screenLines({ url = '', lineCount = 0 } = {}) {
  return [
    { text: TITLE, option: null },
    { text: '', option: null },
    { text: `   Document: ${url}`, option: null },
    { text: `   Number of lines: ${Math.max(0, Number(lineCount) || 0)}`, option: null },
    { text: `   Number of pages: ${pageLabel(lineCount)}`, option: null },
    { text: '', option: null },
    { text: 'Standard print options:', option: null },
    { text: SAVE_LABEL, option: 'save' },
    { text: '', option: null },
    { text: 'Local additions:', option: null },
  ];
}

function optionRow(lines) {
  return lines.findIndex((line) => line.option === 'save');
}

function renderPrintRow(line, selected) {
  if (!line.option || line.option !== selected) return line.text;
  return `${ANSI_REVERSE}${line.text}${ANSI_RESET}`;
}

function drawPrintScreen(host, state) {
  const menu = state.printMenu;
  if (!menu) return;
  const lines = screenLines(menu);
  host.resetScrollRegion();
  lines.forEach((line, row) => {
    host.writeLine(row + 1, renderPrintRow(line, menu.selected));
  });
  const rows = state.rows || 24;
  const instructionRow = Math.max(lines.length + 1, rows - 1);
  host.writeLine(instructionRow, INSTRUCTION);
  placePrintCursor(host, state, lines);
}

function placePrintCursor(host, state, lines = screenLines(state.printMenu)) {
  const row = optionRow(lines);
  if (row < 0) return;
  const text = lines[row].text;
  const first = text.search(/\S/);
  host.moveCursor(row + 1, Math.max(1, first + 1));
}

function openPrint(host, state, page) {
  state.core.live.refreshing = true;
  state.mode = 'print';
  if (state.screens) state.screens.push({ mode: 'print', kind: 'lynx-print' });
  state.printMenu = {
    url: page.url(),
    lineCount: state.lines.length,
    selected: 'save',
    place: { cursor: state.cursor, col: state.col, scroll: state.scroll, title: state.title },
  };
  host.clearScreen();
  drawPrintScreen(host, state);
  host.setStatus(state, '');
  placePrintCursor(host, state);
}

function closePrint(host, state, page, note) {
  const menu = state.printMenu;
  if (!menu) return;
  const { place } = menu;
  state.printMenu = null;
  state.mode = 'browse';
  if (state.screens) state.screens.pop('print');
  state.core.live.refreshing = false;
  state.title = place.title;
  host.relayout(state);
  state.cursor = Math.min(place.cursor, Math.max(state.lines.length - 1, 0));
  state.col = place.col;
  state.scroll = place.scroll;
  host.clampCol(state);
  host.clampScroll(state);
  host.clearScreen();
  host.render(state, page, { force: true });
  if (note) host.setStatus(state, note);
}

// What one key does on the Printing Options screen. Saving is handed back to
// the caller because it needs a filename prompt, which owns the keyboard and
// belongs with the reader loop rather than with this fixed screen.
function handlePrintKey(host, chunk, state, page) {
  const menu = state.printMenu;
  if (!menu) return null;

  if (chunk === 'q' || chunk === 'Q'
      || host.keyIs(chunk, 'ArrowLeft', state) || host.keyIs(chunk, 'Escape', state)) {
    closePrint(host, state, page, CANCELLED);
    return 'close';
  }
  if (chunk === '?' || chunk === 'h' || chunk === 'H') {
    host.setStatus(state, ONLY_OPTION);
    placePrintCursor(host, state);
    return null;
  }
  if (host.keyIs(chunk, 'Enter', state)
      || host.keyIs(chunk, 'ArrowRight', state)) {
    return 'save';
  }
  if (host.keyIs(chunk, 'ArrowUp', state) || host.keyIs(chunk, 'ArrowDown', state)) {
    host.setStatus(state, ONLY_OPTION);
    placePrintCursor(host, state);
  }
  return null;
}

// The filename Lynx offers before the reader types: the address's last path
// component, or the title when the address has none, in lower case with the
// usual unsafe characters replaced. It always ends in .txt because what is
// saved is text, not the original page.
function saveFilename(title, url = '') {
  let leaf = '';
  try {
    const pathname = new URL(url).pathname || '';
    leaf = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    leaf = '';
  }
  let base = leaf || String(title || '').trim();
  base = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  base = base.toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  if (!base) base = 'page';
  return `${base}.txt`;
}

// The page as the reader sees it: the same margin, marker and suffix the
// Lynx display puts around each row, with no terminal styling.
function pageText(lines = []) {
  return lines.map((line) => {
    const indent = ' '.repeat(line.displayIndent || 0);
    return indent + (line.displayPrefix || '') + (line.text || '') + (line.displaySuffix || '');
  }).join('\n') + (lines.length ? '\n' : '');
}

module.exports = {
  TITLE, SAVE_LABEL, INSTRUCTION, ONLY_OPTION, CANCELLED, FILE_PROMPT_LABEL,
  PAGE_LINES, pageCountFor, pageLabel, screenLines, optionRow, renderPrintRow,
  drawPrintScreen, placePrintCursor, openPrint, closePrint, handlePrintKey,
  saveFilename, pageText,
};
