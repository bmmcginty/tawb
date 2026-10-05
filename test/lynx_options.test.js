'use strict';

// The Lynx Options menu, drawn as Lynx draws it.
//
// It is a fixed screen rather than a document: its own rows, its own columns, a
// Command prompt on the row above the status line, and the terminal cursor left
// there. The lines below are the ones a real Lynx prints on an 80-column
// terminal, which lynx_options_real.test.js records from the program itself.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const {
  openOptions, handleBrowseKey, handleOptionsKey, findText,
} = require('../src/index');
const {
  screenLines, optionPosition, optionForLetter, COMMAND_ROW,
  ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST, SELECT_LINE, NOT_CHANGEABLE,
} = require('../src/lynx_options');

const PAGE = { url: () => 'https://example.test/page' };

function reader(preferences = {}) {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = {
    keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
    numberLinksOnLeft: true, numberFieldsOnLeft: true,
    textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
    ...preferences,
  };
  return {
    interface: 'lynx', keys, mode: 'browse', library: null, options: null,
    lines: [{ blockIndex: 0, text: 'The page' }], cursor: 0, col: 0, scroll: 0,
    title: 'The page', statusMsg: '', drawn: {},
    lynxSettingsFile: path.join(tempDir('tawb-options-screen-'), 'settings.lynx.json'),
    core: {
      source: 'ax', blocks: [{ text: 'The page', item: null }], at() {}, markInput() {},
      live: { refreshing: false },
    },
  };
}

// The terminal as the screen wrote it: the writes are kept rather than drawn.
function capture(run) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { run(); } finally { process.stdout.write = write; }
  return chunks.join('');
}

async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

async function press(state, ...sequence) {
  for (const chunk of sequence) await quietly(() => handleOptionsKey(chunk, state, PAGE));
}

function screen(state) {
  return screenLines(state.keys.preferences);
}

function rowText(state, row) {
  return screen(state)[row].text;
}

// ---------------------------------------------------------------------------
// The screen itself
// ---------------------------------------------------------------------------

// Lynx's own lines, from the capture in the test that drives the real program.
// Two rows differ by design: the title says which program is drawing, and the
// user-agent row is short because TAWB's agent is one word.
const STOCK_SCREEN = [
  '              Options Menu (TAWB Lynx interface)',
  '',
  '     (E)ditor                     : NONE',
  '     (D)ISPLAY variable           : NONE',
  '     mu(L)ti-bookmarks: OFF       (B)ookmark file: lynx_bookmarks.html',
  '     (F)TP sort criteria          : By Filename',
  '     (P)ersonal mail address      : NONE',
  '     (S)earching type             : CASE INSENSITIVE',
  '     preferred document lan(G)uage: en',
  '     preferred document c(H)arset : NONE',
  '     display (C)haracter set      : Western (ISO-8859-1)',
  '     Raw 8-bit or CJK m(O)de      : ON      show color (&)  : ON',
  '     (V)I keys: OFF   e(M)acs keys: OFF     sho(W) dot files: OFF',
  '     popups for selec(T) fields   : ON      show cursor (@) : OFF',
  '     (K)eypad mode                : Numbers act as arrows',
  '     li(N)e edit style            : Default Binding',
  '',
  '     l(I)st directory style       : Mixed style',
  '     (U)ser mode                  : Novice        verbose images (!) : ON',
  '     user (A)gent                 : TAWB',
  '',
  "  Select capital letter of option line, '>' to save, or 'r' to return to Lynx.",
];

test('the screen is Lynx\'s lines, row for row', () => {
  const state = reader();
  assert.deepEqual(screen(state).map((line) => line.text), STOCK_SCREEN);
  // The Command prompt is on the row after the last of them, one row above the
  // status line, exactly where Lynx puts it.
  assert.equal(COMMAND_ROW, STOCK_SCREEN.length);
});

test('every option is where Lynx puts it, column and all', () => {
  const lines = screen(reader());
  const at = (letter) => optionPosition(lines, letter);
  assert.deepEqual({ row: at('E').row, column: at('E').column }, { row: 2, column: 36 });
  assert.deepEqual({ row: at('L').row, column: at('L').column }, { row: 4, column: 24 });
  assert.deepEqual({ row: at('B').row, column: at('B').column }, { row: 4, column: 51 });
  assert.deepEqual({ row: at('&').row, column: at('&').column }, { row: 11, column: 62 });
  assert.deepEqual({ row: at('M').row, column: at('M').column }, { row: 12, column: 36 });
  assert.deepEqual({ row: at('W').row, column: at('W').column }, { row: 12, column: 62 });
  assert.deepEqual({ row: at('T').row, column: at('T').column }, { row: 13, column: 36 });
  assert.deepEqual({ row: at('@').row, column: at('@').column }, { row: 13, column: 62 });
  assert.deepEqual({ row: at('!').row, column: at('!').column }, { row: 18, column: 71 });
});

test('the two options on one row each keep their own value', () => {
  const state = reader();
  const lines = screenLines({ ...state.keys.preferences, showCursor: true });
  // Row 13 carries the select-popups option and the cursor option.
  assert.match(lines[13].text, /popups for selec\(T\) fields   : ON/);
  assert.match(lines[13].text, /show cursor \(@\) : ON/);
  // The value column of each is where its line says it is.
  assert.equal(lines[13].text.slice(optionPosition(lines, '@').column).startsWith('ON'), true);
});

// ---------------------------------------------------------------------------
// Opening and leaving
// ---------------------------------------------------------------------------

test('opening draws the screen with the cursor on the Command prompt', async () => {
  const state = reader();
  const output = capture(() => openOptions(state, PAGE));
  assert.equal(state.mode, 'options');
  assert.equal(state.statusMsg, '');
  // Row 23 is the Command prompt row (1-based), and the cursor sits after it.
  assert.ok(output.includes('\x1b[23;10H'), 'the cursor is not on the Command prompt');
  assert.ok(output.includes('Command: '), 'the prompt was not drawn');
  assert.ok(output.includes('user (A)gent'), 'the screen was not drawn');
});

test('r leaves with the choices kept for the session', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, '@', ' ', '\r', 'r');
  assert.equal(state.mode, 'browse');
  assert.equal(state.options, null);
  assert.equal(state.keys.preferences.showCursor, true);
});

test('Left leaves with nothing changed', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, '@', ' ', '\r', '\x1b[D');
  assert.equal(state.mode, 'browse');
  assert.equal(state.keys.preferences.showCursor, false);
});

test('greater-than saves what was decided and leaves', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, '@', ' ', '\r', '>');
  assert.equal(state.mode, 'browse');
  assert.equal(state.statusMsg, 'Options saved.');
  const document = JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8'));
  assert.equal(document.lynx.showCursor, true);
  assert.equal(document.lynx.searchCase, 'CASE_INSENSITIVE');
  assert.equal(Object.hasOwn(document.lynx, 'numberLinks'), false,
    'derived values do not become independent settings');
});

test('a value chosen and not accepted is not saved', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, '@', ' ', 'q', '>');
  const document = JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8'));
  assert.equal(document.lynx.showCursor, false,
    'a cancelled value was written as if it had been accepted');
});

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

test('a boolean is chosen, changed and accepted, and the screen shows it', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));

  const chosen = capture(() => handleOptionsKey('@', state, PAGE));
  assert.equal(state.statusMsg, ANY_KEY_CHANGE);
  assert.equal(state.keys.preferences.showCursor, false, 'choosing changed nothing yet');
  // The value under the cursor is shown in reverse video while it is provisional.
  assert.ok(chosen.includes('\x1b[7mOFF\x1b[0m'), 'the chosen value was not highlighted');

  await quietly(() => handleOptionsKey(' ', state, PAGE));
  assert.equal(state.keys.preferences.showCursor, true);
  assert.match(rowText(state, 13), /show cursor \(@\) : ON/);

  await quietly(() => handleOptionsKey('\r', state, PAGE));
  assert.equal(state.statusMsg, VALUE_ACCEPTED);
  assert.equal(state.keys.preferences.showCursor, true);
  assert.equal(state.options.choosing, null);
});

test('with SHOW_CURSOR on, the cursor sits beside the value being chosen', async () => {
  const state = reader({ showCursor: true });
  await quietly(() => openOptions(state, PAGE));
  const output = capture(() => handleOptionsKey('@', state, PAGE));
  // The value is at column 62 (0-based), so the cursor is at column 61 (0-based)
  // on row 14 — one based, that is column 62 of row 14.
  assert.ok(output.includes('\x1b[14;62H'), 'the cursor is not beside the value');
});

test('a cancelled value is put back and the screen says so', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, '@', ' ');
  assert.equal(state.keys.preferences.showCursor, true);
  await quietly(() => handleOptionsKey('q', state, PAGE));
  assert.equal(state.statusMsg, CANCELLED);
  assert.equal(state.keys.preferences.showCursor, false);
  assert.match(rowText(state, 13), /show cursor \(@\) : OFF/);
});

test('the searching type is a boolean, changed the same way', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, 'S', ' ', '\r');
  assert.equal(state.keys.preferences.searchCase, 'CASE_SENSITIVE');
  assert.match(rowText(state, 7), /: CASE SENSITIVE/);
});

test('an option with several values walks a list with the arrows', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await quietly(() => handleOptionsKey('K', state, PAGE));
  assert.equal(state.statusMsg, CHOICE_LIST);
  await press(state, '\x1b[B', '\r');
  assert.equal(state.statusMsg, VALUE_ACCEPTED);
  assert.equal(state.keys.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
  assert.equal(state.keys.preferences.numberLinks, true);
  assert.equal(state.keys.preferences.numberFields, false);
  assert.match(rowText(state, 14), /: Links are numbered/);
});

test('an option TAWB cannot change still names itself', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await quietly(() => handleOptionsKey('E', state, PAGE));
  assert.equal(state.statusMsg, NOT_CHANGEABLE);
  assert.equal(state.options.choosing, null);
  assert.equal(state.mode, 'options');
});

test('the classic menu requires its displayed capital letter', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await press(state, 'k');
  assert.equal(state.options.choosing, null, 'lowercase k chose the Keypad option');
  assert.equal(state.statusMsg, '');
});

test('o opens the screen in the Lynx interface', async () => {
  const state = reader();
  await quietly(() => handleBrowseKey('o', state, PAGE));
  assert.equal(state.mode, 'options');
  assert.ok(state.options);
});

test('Lynx Searching Type is absolute while the default interface keeps smart case', () => {
  const state = reader();
  state.lines = [{ text: 'start' }, { text: 'Lynx browser' }];
  state.keys.preferences.searchCase = 'CASE_INSENSITIVE';
  assert.deepEqual(findText(state, 'LYNX', 1), { line: 1, col: 0, wrapped: false });
  state.keys.preferences.searchCase = 'CASE_SENSITIVE';
  assert.equal(findText(state, 'LYNX', 1), null);

  state.interface = 'default';
  assert.deepEqual(findText(state, 'lynx', 1), { line: 1, col: 0, wrapped: false });
  assert.equal(findText(state, 'LYNX', 1), null);
});

test('the select line is content, on the row above the Command prompt', () => {
  const state = reader();
  assert.equal(screen(state)[screen(state).length - 1].text, SELECT_LINE);
  assert.equal(optionForLetter('Z'), null);
});
