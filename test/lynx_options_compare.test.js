'use strict';

// TAWB's Lynx interface, measured against the Lynx it is imitating.
//
// The two other files answer half of the question each. lynx_options_real
// records what a real Lynx does when keys are pressed at it. lynx_options
// checks that TAWB's own screen behaves as TAWB means it to. Neither notices
// when the two drift apart, which is the thing that matters here: a reader who
// knows Lynx should be able to press the same keys and get the same result.
//
// So this file presses the same keys at both and compares three things that
// must agree — which option the cursor is on (counted in reading order, since
// the two draw the screen differently on purpose), what the status line says,
// and what the same choices leave in the settings file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const { openOptions, handleBrowseKey, handleLibraryKey } = require('../src/index');
const { LynxTty, available, optionFields, sleep } = require('./lynx_tty');
const {
  ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST, SELECT_LINE,
} = require('../src/lynx_options');

const skip = available() ? false : 'needs both lynx and tmux';
const HOME = skip ? null : tempDir('tawb-compare-');
const PAGE = skip ? null : path.join(HOME, 'page.html');

// The single-screen menu, which is the one with a keymap of its own and so the
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

// The same acts, named the way each side names them: tmux key names for Lynx,
// the bytes a terminal would send for TAWB.
const KEYS = {
  '@': { lynx: '@', tawb: '@' },
  S: { lynx: 'S', tawb: 'S' },
  K: { lynx: 'K', tawb: 'K' },
  I: { lynx: 'I', tawb: 'I' },
  Space: { lynx: 'Space', tawb: ' ' },
  Return: { lynx: 'C-m', tawb: '\r' },
  Down: { lynx: 'Down', tawb: '\x1b[B' },
  Up: { lynx: 'Up', tawb: '\x1b[A' },
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
    interface: 'lynx', keys, mode: 'browse', library: null,
    lines: [{ blockIndex: 0, text: 'The page' }], cursor: 0, col: 0, scroll: 0,
    title: 'The page', statusMsg: '', drawn: { title: null, address: null, hint: null },
    lynxSettingsFile: path.join(directory, 'settings.lynx.json'),
    core: {
      source: 'ax', blocks: [{ text: 'The page', item: null }], at() {}, markInput() {},
      live: { refreshing: false },
    },
  };
}

async function tawbPressAll(keys) {
  const state = tawbReader();
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await handleBrowseKey('o', state, { url: () => 'https://example.test/' });
    for (const key of keys) await handleLibraryKey(KEYS[key].tawb, state, {
      url: () => 'https://example.test/',
    });
  } finally {
    process.stdout.write = write;
  }
  return state;
}

function tawbSaved(state) {
  try {
    return JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8')).lynx;
  } catch {
    return null;
  }
}

// The option the cursor is on, counted the way a reader counts options on the
// two screens: first to last, top to bottom, left to right. TAWB gives every
// option a row and Lynx packs three to a row, so the row number cannot be
// compared — the position in the reading order can, and is what a reader
// actually walks.
function tawbOptionAt(state) {
  const row = state.library.rows[state.cursor];
  return row ? row.letter : null;
}

function lynxOptionAt(screen, cursorY) {
  const fields = optionFields(screen);
  const line = String(screen).split('\n')[cursorY] || '';
  const on = fields.filter((field) => line.includes(field.label.split(':')[0].trim()));
  return on.length ? on[0].letter : null;
}

// The reading-order index of an option, which is the position both screens
// agree on.
function tawbReadingOrder(state, letter) {
  return state.library.rows.findIndex((row) => row.letter === letter);
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
  } finally {
    tty.stop();
  }
}

// A Lynx session does not outlive the test that opened it — the pane is killed
// on the way out — so everything worth asserting on is read out here, inside
// the session, and handed back as data.
async function lynxPressAll(keys, { save = false } = {}) {
  return withLynx(async (tty) => {
    await tty.press('o');
    const seen = [];
    for (const key of keys) seen.push(await tty.press(KEYS[key].lynx));
    if (save) {
      for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
        if (tty.rc()) break;
        await sleep(100);
      }
    }
    const screen = tty.screen();
    return {
      screen,
      rows: screen.split('\n'),
      seen,
      rc: tty.rc(),
      cursor: tty.cursor(),
      status: tty.statusLine(),
    };
  });
}

// ---------------------------------------------------------------------------
// What has to agree
// ---------------------------------------------------------------------------

test('the same option letters name the same options', { skip }, async () => {
  const { screen } = await lynxPressAll([]);
  const lynx = optionFields(screen);
  const tawb = await tawbPressAll([]);
  const tawbLetters = tawb.library.rows.map((row) => row.letter);

  // Every option Lynx draws must be on TAWB's screen, in the same reading
  // order. TAWB may have one more: (X) local execution is compiled in here and
  // absent there, and TAWB cannot ask a build what it was compiled with.
  const lynxLetters = lynx.map((field) => field.letter);
  const present = tawbLetters.filter((letter) => lynxLetters.includes(letter));
  assert.deepEqual(present, lynxLetters,
    'the options TAWB and Lynx share are not in the same reading order');

  const extra = tawbLetters.filter((letter) => !lynxLetters.includes(letter));
  assert.deepEqual(extra, ['X'],
    'TAWB shows an option this Lynx does not, beyond the build-conditional one');
});

test('the same keys leave the cursor on the same option', { skip }, async () => {
  // The canonical reading order comes from the untouched screen, because a
  // choice list opens a box over the options below it and changes what the
  // screen says without changing what the list is.
  const baselineScreen = (await lynxPressAll([])).screen;
  const baseline = optionFields(baselineScreen);
  const rowOf = (letter) => baseline.find((field) => field.letter === letter).row;
  const indexOf = (letter) => baseline.findIndex((field) => field.letter === letter);

  for (const [scenario, keys, letter] of [
    ['show cursor', ['@'], '@'],
    ['keypad mode', ['K'], 'K'],
    ['searching type', ['S'], 'S'],
    ['list directory style', ['I'], 'I'],
  ]) {
    const { cursor } = await lynxPressAll(keys);
    const tawb = await tawbPressAll(keys);

    assert.ok(indexOf(letter) >= 0, `${scenario}: Lynx has no option ${letter}`);
    assert.equal(cursor.y, rowOf(letter),
      `${scenario}: Lynx left the cursor on another row`);
    assert.equal(tawbReadingOrder(tawb, letter), indexOf(letter),
      `${scenario}: TAWB puts ${letter} in a different reading position`);
    assert.equal(tawbOptionAt(tawb), letter,
      `${scenario}: TAWB left the cursor somewhere other than ${letter}`);
  }
});

test('the same words are said while a value is being chosen', { skip }, async () => {
  // Lynx's own status lines, read out of Lynx, compared with the constants
  // TAWB uses for the same moments.
  const chosen = await lynxPressAll(['@']);
  assert.equal(chosen.status, ANY_KEY_CHANGE,
    'the chosen-value prompt is not Lynx\'s');

  const accepted = await lynxPressAll(['@', 'Space', 'Return']);
  assert.equal(accepted.status, VALUE_ACCEPTED);

  const cancelled = await lynxPressAll(['@', 'Space', 'q']);
  assert.equal(cancelled.status, CANCELLED);
  assert.match(cancelled.rows[13], /show cursor \(@\) : OFF/,
    'cancelling a change left the changed value standing in Lynx itself');

  const listed = await lynxPressAll(['K']);
  assert.equal(listed.status, CHOICE_LIST);

  // The same words on TAWB's side, produced by the same keys.
  const tawbChosen = await tawbPressAll(['@']);
  assert.equal(tawbChosen.statusMsg, ANY_KEY_CHANGE);
  const tawbAccepted = await tawbPressAll(['@', 'Space', 'Return']);
  assert.equal(tawbAccepted.statusMsg, VALUE_ACCEPTED);
  const tawbCancelled = await tawbPressAll(['@', 'Space', 'q']);
  assert.equal(tawbCancelled.statusMsg, CANCELLED);
  const tawbListed = await tawbPressAll(['K']);
  assert.equal(tawbListed.statusMsg, CHOICE_LIST);
});

// The whole point of the screen: what is chosen, changed and accepted is what
// the settings file holds afterwards — in each program's own format, saying
// the same thing.
test('the same choices are saved, in each program\'s own file', { skip }, async () => {
  const showCursor = await lynxPressAll(['@', 'Space', 'Return', '>'], { save: true });
  assert.equal(showCursor.rc.show_cursor, 'on');
  const tawbCursor = await tawbPressAll(['@', 'Space', 'Return', '>']);
  assert.equal(tawbSaved(tawbCursor).showCursor, true);

  const keypad = await lynxPressAll(['K', 'Down', 'Return', '>'], { save: true });
  assert.equal(keypad.rc.keypad_mode, 'LINKS_ARE_NUMBERED');
  const tawbKeypad = await tawbPressAll(['K', 'Down', 'Return', '>']);
  assert.equal(tawbSaved(tawbKeypad).keypadMode, 'LINKS_ARE_NUMBERED');
  // The numbering preferences are derived from the mode, not saved beside it.
  assert.equal(Object.hasOwn(tawbSaved(tawbKeypad), 'numberLinks'), false);

  const search = await lynxPressAll(['S', 'Space', 'Return', '>'], { save: true });
  assert.equal(search.rc.case_sensitive_searching, 'on');
  const tawbSearch = await tawbPressAll(['S', 'Space', 'Return', '>']);
  assert.equal(tawbSaved(tawbSearch).searchCase, 'CASE_SENSITIVE');
});

test('a cancelled change is saved by neither, and r saves nothing', { skip }, async () => {
  const cancelled = await lynxPressAll(['@', 'Space', 'q', '>'], { save: true });
  assert.equal(cancelled.rc.show_cursor, 'off');
  const tawbCancelled = await tawbPressAll(['@', 'Space', 'q', '>']);
  assert.equal(tawbSaved(tawbCancelled).showCursor, false);

  const returned = await lynxPressAll(['@', 'Space', 'Return', 'r']);
  assert.equal(returned.rc, null, 'Lynx wrote a file on r');
  const tawbReturned = await tawbPressAll(['@', 'Space', 'Return', 'r']);
  assert.equal(tawbSaved(tawbReturned), null, 'TAWB wrote a file on r');

  const left = await lynxPressAll(['Left', 'Left']);
  assert.equal(left.rc, null, 'Lynx wrote a file on Left');
  const tawbLeft = await tawbPressAll(['Left']);
  assert.equal(tawbSaved(tawbLeft), null, 'TAWB wrote a file on Left');
});

// ---------------------------------------------------------------------------
// Where the two deliberately differ
// ---------------------------------------------------------------------------

// These are not failures to fix here; they are the differences the parity
// document describes, pinned so that a change to either side is noticed.
test('the differences that remain are the known ones', { skip }, async () => {
  const { screen, cursor, rows } = await lynxPressAll([]);
  const tawb = await tawbPressAll([]);

  // Lynx opens on a Command prompt line at the bottom of a fixed screen, with
  // nothing chosen; TAWB opens on the first option, because it has no prompt
  // line to sit on.
  assert.deepEqual(cursor, { x: 9, y: rows.length - 2 },
    'Lynx no longer opens on its Command prompt');
  assert.equal(tawbOptionAt(tawb), 'E',
    'TAWB no longer opens on the first option');
  assert.match(rows[rows.length - 2], /^Command: /);

  // Lynx packs up to three options onto one row; TAWB gives each its own.
  const lynxRows = new Set(optionFields(screen).map((field) => field.column));
  assert.ok(lynxRows.size < tawb.library.rows.length,
    'the layouts were expected to differ');

  // And the default options screen is not this one at all: Lynx renders a
  // five-page form, which TAWB does not implement. See docs/lynx-parity.md.
  assert.equal(SELECT_LINE, tawb.statusMsg);
});
