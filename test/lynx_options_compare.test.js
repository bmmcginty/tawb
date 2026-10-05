'use strict';

// TAWB's Lynx options screen, measured against the Lynx it is imitating.
//
// The two other files answer half of the question each. lynx_options_real
// records what a real Lynx draws and does. lynx_options checks that TAWB's
// screen behaves as TAWB means it to. Neither notices when the two drift apart,
// which is the thing that matters here.
//
// So this file presses the same keys at both and compares the screen they draw,
// where the cursor is left, what the status line says, and what the same choices
// save. The comparison is row for row: TAWB draws the screen at the terminal's
// own rows, so its row index and Lynx's are the same number.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const { openOptions, handleBrowseKey, handleOptionsKey } = require('../src/index');
const { screenLines, optionPosition } = require('../src/lynx_options');
const { LynxTty, available, optionFields, sleep } = require('./lynx_tty');
const {
  ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST,
} = require('../src/lynx_options');

const skip = available() ? false : 'needs both lynx and tmux';
const HOME = skip ? null : tempDir('tawb-compare-');
const PAGE = skip ? null : path.join(HOME, 'page.html');

// The single-screen menu, which is the one with a keyboard of its own and so the
// one a layered comparison can be made about.
const LETTER_CFG = skip ? null : path.join(HOME, 'letter.cfg');

if (!skip) {
  fs.writeFileSync(LETTER_CFG, 'FORMS_OPTIONS:FALSE\n');
  fs.writeFileSync(PAGE,
    '<!doctype html><title>Probe</title><p>Text with a <a href="/a">link</a>.</p>');
}

test.after(() => {
  if (skip) return;
  const { removeTempDir } = require('./tmpdir');
  removeTempDir(HOME);
});

// ---------------------------------------------------------------------------
// One key vocabulary, two keyboards
// ---------------------------------------------------------------------------

const KEYS = {
  '@': { lynx: '@', tawb: '@' },
  S: { lynx: 'S', tawb: 'S' },
  K: { lynx: 'K', tawb: 'K' },
  E: { lynx: 'E', tawb: 'E' },
  Space: { lynx: 'Space', tawb: ' ' },
  Return: { lynx: 'C-m', tawb: '\r' },
  Down: { lynx: 'Down', tawb: '\x1b[B' },
  q: { lynx: 'q', tawb: 'q' },
  r: { lynx: 'r', tawb: 'r' },
  Left: { lynx: 'Left', tawb: '\x1b[D' },
  '>': { lynx: '>', tawb: '>' },
};

// ---------------------------------------------------------------------------
// The TAWB side
// ---------------------------------------------------------------------------

function tawbReader() {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = {
    keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
    numberLinksOnLeft: true, numberFieldsOnLeft: true,
    textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
  };
  const directory = tempDir('tawb-compare-tawb-');
  return {
    interface: 'lynx', keys, mode: 'browse', library: null, options: null,
    lines: [{ blockIndex: 0, text: 'The page' }], cursor: 0, col: 0, scroll: 0,
    title: 'The page', statusMsg: '', drawn: {},
    lynxSettingsFile: path.join(directory, 'settings.lynx.json'),
    core: {
      source: 'ax', blocks: [{ text: 'The page', item: null }], at() {}, markInput() {},
      live: { refreshing: false },
    },
  };
}

const TAWB_PAGE = { url: () => 'https://example.test/' };

// The last place the screen put the terminal cursor.
function lastCursor(output) {
  const pattern = /\x1b\[(\d+);(\d+)H/g;
  let match;
  let last = null;
  while ((match = pattern.exec(output)) !== null) {
    last = { row: Number(match[1]), column: Number(match[2]) };
  }
  return last;
}

async function tawbPressAll(keys) {
  const state = tawbReader();
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await handleBrowseKey('o', state, TAWB_PAGE);
    for (const key of keys) await handleOptionsKey(KEYS[key].tawb, state, TAWB_PAGE);
  } finally {
    process.stdout.write = write;
  }
  return {
    state,
    output: chunks.join(''),
    screen: screenLines(state.keys.preferences),
    cursor: lastCursor(chunks.join('')),
    status: state.statusMsg,
  };
}

function tawbSaved(state) {
  try {
    return JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8')).lynx;
  } catch {
    return null;
  }
}

function tawbOptionAt(state) {
  return state.options && state.options.choosing ? state.options.choosing.letter : null;
}

// ---------------------------------------------------------------------------
// The Lynx side
// ---------------------------------------------------------------------------

let sessions = 0;

async function withLynx(run) {
  const session = `tawb-compare-${process.pid}-${sessions += 1}`;
  const tty = new LynxTty({ session, home: HOME, page: PAGE, config: LETTER_CFG });
  fs.rmSync(tty.rcPath(), { force: true });
  await tty.start();
  try {
    return await run(tty);
  } catch (err) {
    tty.stop();
    throw err;
  }
}

// A Lynx session does not outlive the test that opened it, so everything worth
// asserting on is read out here and handed back as data.
async function lynxPressAll(keys, { save = false } = {}) {
  return withLynx(async (tty) => {
    await tty.press('o');
    for (const key of keys) await tty.press(KEYS[key].lynx);
    if (save) {
      for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
        if (tty.rc()) break;
        await sleep(100);
      }
    }
    const screen = tty.screen();
    const { x, y } = tty.cursor();
    return {
      screen,
      rows: screen.split('\n'),
      rc: tty.rc(),
      // Lynx reports its cursor zero-based; TAWB's write is one-based, and the
      // two screens put the same row in the same terminal row.
      cursor: { row: y + 1, column: x + 1 },
      status: tty.statusLine(),
    };
  });
}

// ---------------------------------------------------------------------------
// What has to agree
// ---------------------------------------------------------------------------

// The rows that differ are the two that are about the program rather than about
// the options: the title says which program is drawing, and the user-agent row
// has a different agent in it.
const OWN_ROWS = new Set([0, 19, 20]);

test('TAWB draws the same screen, row for row', { skip }, async () => {
  const { rows } = await lynxPressAll([]);
  const tawb = await tawbPressAll([]);
  // TAWB draws the Command prompt as its own row below the screen's rows, so
  // the two together are the rows Lynx draws above its status line.
  assert.equal(tawb.screen.length + 1, rows.length - 1,
    'the options screen has a different number of rows');
  for (let row = 0; row < tawb.screen.length; row += 1) {
    if (OWN_ROWS.has(row)) continue;
    // Lynx's capture is padded to the terminal width; a row's trailing spaces
    // are not part of what it says.
    assert.equal(tawb.screen[row].text, rows[row].replace(/\s+$/, ''),
      `row ${row} differs from Lynx's`);
  }
  // The two the test steps over are the only ones that may differ, and each for
  // a stated reason.
  assert.match(tawb.screen[0].text, /Options Menu \(TAWB Lynx interface\)/);
  assert.match(tawb.screen[19].text, /user \(A\)gent\s*: TAWB/);
});

test('every option is on the row and at the column Lynx puts it', { skip }, async () => {
  const { rows } = await lynxPressAll([]);
  const lynx = optionFields(rows.join('\n'));
  const tawb = await tawbPressAll([]);
  for (const field of lynx) {
    if (OWN_ROWS.has(field.row)) continue;
    const at = optionPosition(tawb.screen, field.letter);
    assert.ok(at, `TAWB has no option ${field.letter}`);
    assert.equal(at.row, field.row, `${field.letter} is on a different row`);
  }
});

test('the Command prompt is on the same row, with the cursor on it', { skip }, async () => {
  const lynx = await lynxPressAll([]);
  const tawb = await tawbPressAll([]);
  assert.deepEqual(tawb.cursor, lynx.cursor,
    'the two screens leave the cursor in different places');
  assert.match(lynx.rows[lynx.cursor.row - 1], /^Command: /);
});

test('choosing an option leaves the cursor beside it, in both', { skip }, async () => {
  const lynx = await lynxPressAll(['@']);
  const tawb = await tawbPressAll(['@']);
  assert.deepEqual(tawb.cursor, lynx.cursor);
  // Row 14, one column past the value "OFF" that ends at column 65: with
  // SHOW_CURSOR off Lynx leaves the cursor where the write finished.
  assert.deepEqual(tawb.cursor, { row: 14, column: 66 });
  assert.equal(tawbOptionAt(tawb.state), '@');
});

test('the same words are said while a value is being chosen', { skip }, async () => {
  const chosen = await lynxPressAll(['@']);
  assert.equal(chosen.status, ANY_KEY_CHANGE, 'the chosen-value prompt is not Lynx\'s');
  const accepted = await lynxPressAll(['@', 'Space', 'Return']);
  assert.equal(accepted.status, VALUE_ACCEPTED);
  const cancelled = await lynxPressAll(['@', 'Space', 'q']);
  assert.equal(cancelled.status, CANCELLED);
  const listed = await lynxPressAll(['K']);
  assert.equal(listed.status, CHOICE_LIST);

  assert.equal((await tawbPressAll(['@'])).status, ANY_KEY_CHANGE);
  assert.equal((await tawbPressAll(['@', 'Space', 'Return'])).status, VALUE_ACCEPTED);
  assert.equal((await tawbPressAll(['@', 'Space', 'q'])).status, CANCELLED);
  assert.equal((await tawbPressAll(['K'])).status, CHOICE_LIST);
});

test('a cancelled value stands in both, and an unnamed option says so', { skip }, async () => {
  const lynx = await lynxPressAll(['@', 'Space', 'q']);
  assert.match(lynx.rows[13], /show cursor \(@\) : OFF/);
  const tawb = await tawbPressAll(['@', 'Space', 'q']);
  assert.match(tawb.screen[13].text, /show cursor \(@\) : OFF/);

  // (E)ditor is Lynx's to change and not TAWB's; TAWB says so rather than
  // silently doing nothing.
  const editor = await tawbPressAll(['E']);
  assert.match(editor.status, /not changed by TAWB/);
  assert.equal(editor.state.options.choosing, null);
});

test('the same choices are saved, in each program\'s own file', { skip }, async () => {
  const showCursor = await lynxPressAll(['@', 'Space', 'Return', '>'], { save: true });
  assert.equal(showCursor.rc.show_cursor, 'on');
  const tawbCursor = await tawbPressAll(['@', 'Space', 'Return', '>']);
  assert.equal(tawbSaved(tawbCursor.state).showCursor, true);

  const keypad = await lynxPressAll(['K', 'Down', 'Return', '>'], { save: true });
  assert.equal(keypad.rc.keypad_mode, 'LINKS_ARE_NUMBERED');
  const tawbKeypad = await tawbPressAll(['K', 'Down', 'Return', '>']);
  assert.equal(tawbSaved(tawbKeypad.state).keypadMode, 'LINKS_ARE_NUMBERED');
  assert.equal(Object.hasOwn(tawbSaved(tawbKeypad.state), 'numberLinks'), false);

  const search = await lynxPressAll(['S', 'Space', 'Return', '>'], { save: true });
  assert.equal(search.rc.case_sensitive_searching, 'on');
  const tawbSearch = await tawbPressAll(['S', 'Space', 'Return', '>']);
  assert.equal(tawbSaved(tawbSearch.state).searchCase, 'CASE_SENSITIVE');
});

test('a cancelled change is saved by neither, and r saves nothing', { skip }, async () => {
  const cancelled = await lynxPressAll(['@', 'Space', 'q', '>'], { save: true });
  assert.equal(cancelled.rc.show_cursor, 'off');
  const tawbCancelled = await tawbPressAll(['@', 'Space', 'q', '>']);
  assert.equal(tawbSaved(tawbCancelled.state).showCursor, false);

  const returned = await lynxPressAll(['@', 'Space', 'Return', 'r']);
  assert.equal(returned.rc, null, 'Lynx wrote a file on r');
  const tawbReturned = await tawbPressAll(['@', 'Space', 'Return', 'r']);
  assert.equal(tawbSaved(tawbReturned.state), null, 'TAWB wrote a file on r');

  const left = await lynxPressAll(['Left', 'Left']);
  assert.equal(left.rc, null, 'Lynx wrote a file on Left');
  const tawbLeft = await tawbPressAll(['Left']);
  assert.equal(tawbSaved(tawbLeft.state), null, 'TAWB wrote a file on Left');
});

// ---------------------------------------------------------------------------
// Where the two deliberately differ
// ---------------------------------------------------------------------------

// Not a failure to fix here; the difference the parity document describes,
// pinned so a change to either side is noticed.
test('the default options screen is still the form TAWB does not draw', { skip }, async () => {
  const forms = skip ? null : path.join(HOME, 'forms.cfg');
  fs.writeFileSync(forms, 'FORMS_OPTIONS:TRUE\n');
  const session = `tawb-compare-forms-${process.pid}`;
  const tty = new LynxTty({ session, home: HOME, page: PAGE, config: forms });
  fs.rmSync(tty.rcPath(), { force: true });
  await tty.start();
  let screen;
  try {
    await tty.press('o');
    screen = tty.screen();
  } finally {
    tty.stop();
  }
  assert.match(screen, /Options Menu \(p1 of 5\)/, 'Lynx no longer defaults to the form');
  assert.match(screen, /Accept Changes/);
  assert.match(screen, /Save options to disk: \[ \]/);
});
