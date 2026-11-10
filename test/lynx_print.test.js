'use strict';

// Lynx's Printing Options screen and the one option it offers: saving the
// page as it is displayed. The screen is a fixed menu, like the Options menu,
// not the page list underneath it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const { functionForAction } = require('../src/lynx_keymap');
const { ScreenStack } = require('../src/screen_stack');
const printScreen = require('../src/lynx_print_screen');
const { ANSI_REVERSE, ANSI_RESET } = require('../src/lynx_display');
const {
  openPrint, closePrint, handlePrintKey, savePathTarget,
} = require('../src/index');

const PAGE = { url: () => 'https://example.test/articles/one.html' };

function reader(overrides = {}) {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  return {
    interface: 'lynx', keys, mode: 'browse', title: 'The article',
    lines: [
      { blockIndex: 0, text: 'First line', displayIndent: 2, displayPrefix: '[', displaySuffix: ']' },
      { blockIndex: 1, text: 'Second line' },
    ],
    cursor: 1, col: 0, scroll: 0, statusMsg: '', drawn: {},
    screens: new ScreenStack(), printMenu: null,
    core: { live: { refreshing: false }, blocks: [], at() {}, markInput() {} },
    ...overrides,
  };
}

function host() {
  const events = [];
  const moved = [];
  return {
    events, moved,
    writeLine(row, text) { events.push(`row ${row}:${text}`); },
    resetScrollRegion() { events.push('reset'); },
    moveCursor(row, col) { moved.push([row, col]); },
  };
}

function keyboard(keys) {
  const queue = [...keys];
  return {
    claim() { return 'token'; },
    release() {},
    async next() {
      if (!queue.length) throw new Error('the prompt asked for a key nobody pressed');
      return queue.shift();
    },
  };
}

async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

function press(state, key) {
  return quietly(() => handlePrintKey(key, state, PAGE));
}

test('p is PRINT in the Lynx keyboard, and the default p stays paragraph', () => {
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  const ordinary = new Keymap({ terminfo: {}, load: false });
  assert.equal(lynx.actionFor('p'), 'print-page');
  assert.equal(ordinary.actionFor('p'), 'next-paragraph');
  assert.equal(functionForAction('print-page'), 'PRINT');
});

test('the screen is Lynx\'s Printing Options with one standard option', () => {
  const lines = printScreen.screenLines({ url: PAGE.url(), lineCount: 2 });
  assert.deepEqual(lines.map((line) => line.text), [
    '              Printing Options (TAWB Lynx interface)',
    '',
    '   Document: https://example.test/articles/one.html',
    '   Number of lines: 2',
    '   Number of pages: 1 page (approximately)',
    '',
    'Standard print options:',
    '   Save to a local file',
    '',
    'Local additions:',
  ]);
  const row = printScreen.optionRow(lines);
  assert.equal(lines[row].option, 'save');
  assert.equal(lines.filter((line) => line.option).length, 1);
});

test('the page count is approximate, and never zero', () => {
  assert.equal(printScreen.pageCountFor(0), 1);
  assert.equal(printScreen.pageCountFor(66), 1);
  assert.equal(printScreen.pageCountFor(67), 2);
  assert.equal(printScreen.pageLabel(132), '2 pages (approximately)');
});

test('the selected option is the only row drawn in reverse video', () => {
  const lines = printScreen.screenLines({ url: PAGE.url(), lineCount: 1 });
  const row = printScreen.optionRow(lines);
  assert.equal(printScreen.renderPrintRow(lines[row], 'save'),
    ANSI_REVERSE + lines[row].text + ANSI_RESET);
  assert.equal(printScreen.renderPrintRow(lines[0], 'save'), lines[0].text);
});

test('drawing puts the cursor on the option and the command line at the bottom', () => {
  const state = reader();
  state.printMenu = { url: PAGE.url(), lineCount: 2, selected: 'save' };
  const draw = host();
  printScreen.drawPrintScreen(draw, state);
  assert.ok(draw.events.includes(`row 8:${ANSI_REVERSE}   Save to a local file${ANSI_RESET}`));
  assert.ok(draw.events.includes(`row 23:${printScreen.INSTRUCTION}`));
  assert.deepEqual(draw.moved.at(-1), [8, 4]);
});

test('the default filename comes from the address, then the title', () => {
  assert.equal(printScreen.saveFilename('The article', PAGE.url()), 'one.txt');
  assert.equal(printScreen.saveFilename('A title', 'https://example.test/'), 'a-title.txt');
  assert.equal(printScreen.saveFilename('', 'https://example.test/'), 'page.txt');
});

test('saving writes the displayed Lynx rows, with their markers', () => {
  const state = {
    lines: [
      { text: 'First line', displayIndent: 2, displayPrefix: '[', displaySuffix: ']' },
      { text: 'Second line' },
    ],
  };
  assert.equal(printScreen.pageText(state.lines), '  [First line]\nSecond line\n');
  assert.equal(printScreen.pageText([]), '');
});

test('the menu opens and closes on the screen stack', async () => {
  const state = reader();
  await quietly(() => openPrint(state, PAGE));
  assert.equal(state.mode, 'print');
  assert.equal(state.screens.top().mode, 'print');
  assert.equal(state.core.live.refreshing, true);
  await press(state, 'q');
  assert.equal(state.mode, 'browse');
  assert.equal(state.printMenu, null);
  assert.equal(state.screens.top().mode, 'page');
  assert.equal(state.core.live.refreshing, false);
  assert.equal(state.statusMsg, 'Printing cancelled.');
});

test('Enter saves the page under the name the reader types', async () => {
  const directory = tempDir('tawb-lynx-print-');
  const file = path.join(directory, 'saved.txt');
  const state = reader();
  state.keyReader = keyboard(['\x0c', file, '\r']);
  await quietly(() => openPrint(state, PAGE));
  await press(state, '\r');
  assert.equal(state.mode, 'print', 'saving returns to the print menu, as Lynx does');
  assert.equal(state.statusMsg, `Saved 2 lines to ${file}.`);
  assert.equal(fs.readFileSync(file, 'utf8'), '  [First line]\nSecond line\n');
});

test('an existing file is not overwritten without a yes', async () => {
  const directory = tempDir('tawb-lynx-print-overwrite-');
  const file = path.join(directory, 'saved.txt');
  fs.writeFileSync(file, 'keep me\n');
  const state = reader();
  state.keyReader = keyboard(['\x0c', file, '\r', 'n']);
  await quietly(() => openPrint(state, PAGE));
  await press(state, '\r');
  assert.equal(state.statusMsg, 'Save cancelled.');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me\n');

  state.keyReader = keyboard(['\x0c', file, '\r', 'y']);
  await press(state, '\r');
  assert.equal(state.statusMsg, `Saved 2 lines to ${file}.`);
  assert.equal(fs.readFileSync(file, 'utf8'), '  [First line]\nSecond line\n');
});

test('a path that cannot be written is refused before anything is created', () => {
  assert.deepEqual(savePathTarget(''), { error: 'no filename given' });
  assert.match(savePathTarget('/does/not/exist/file.txt').error, /not a directory/);
  assert.match(savePathTarget('/').error, /is a directory|not a directory/);
});

test('Escape in the filename prompt cancels without closing the menu', async () => {
  const state = reader();
  state.keyReader = keyboard(['\x1b']);
  await quietly(() => openPrint(state, PAGE));
  await press(state, '\r');
  assert.equal(state.mode, 'print');
  assert.equal(state.statusMsg, 'Save cancelled.');
});
