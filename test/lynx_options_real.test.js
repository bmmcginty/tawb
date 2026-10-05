'use strict';

// The Options screen, as the real Lynx draws and drives it.
//
// The unit tests say what TAWB thinks the option keys do. These say what Lynx
// actually does, by pressing the keys at Lynx and reading the screen, the
// cursor and the options file it writes. They are the ground truth the
// comparison test in lynx_options_compare.test.js measures TAWB against.
//
// Lynx has two options screens, and which one appears is a configuration
// choice, not a terminal accident:
//
//   FORMS_OPTIONS:TRUE   (the default) a five-page HTML form rendered by the
//                        ordinary browser, with links, fields, checkboxes and
//                        its own Accept/Reset links.
//   FORMS_OPTIONS:FALSE  the single-screen menu with a "Command:" prompt,
//                        where one capital letter selects an option.
//
// Both are exercised, because both are things a reader can be looking at.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { LynxTty, available, optionFields, sleep } = require('./lynx_tty');

const skip = available() ? false : 'needs both lynx and tmux';

const HOME = skip ? null : tempDir('tawb-real-options-');
const PAGE = skip ? null : path.join(HOME, 'page.html');

function configFile(name, text) {
  const file = path.join(HOME, name);
  fs.writeFileSync(file, text);
  return file;
}

if (!skip) {
  fs.writeFileSync(PAGE, [
    '<!doctype html><html><head><title>Probe Page</title></head><body>',
    '<h1>Probe</h1><p>Text with a <a href="https://example.com/a">link</a>.</p>',
    '</body></html>',
  ].join('\n'));

  test.before(() => { fs.writeFileSync(path.join(HOME, '.lynxrc'), ''); });
}

const LETTER_CFG = skip ? null : configFile('letter.cfg', 'FORMS_OPTIONS:FALSE\n');
const FORMS_CFG = skip ? null : configFile('forms.cfg', 'FORMS_OPTIONS:TRUE\n');
const CURSOR_CFG = skip ? null : configFile('cursor.cfg', 'FORMS_OPTIONS:FALSE\nSHOW_CURSOR:TRUE\n');

test.after(() => {
  if (skip) return;
  const { removeTempDir } = require('./tmpdir');
  removeTempDir(HOME);
});

let sessions = 0;

// "(S)earching type" is the same option as "Searching type"; the letter is
// drawn inside the word it names. Asking whether two screens name the same
// option means comparing that word, not the letter's position in it.
function plainLabel(label) {
  return String(label).replace(/\(([^)]*)\)/, '$1');
}

// Every test gets its own pane under its own name, so a failure in one leaves
// nothing behind for the next, and the whole file can be read top to bottom.
async function lynx({ config = LETTER_CFG, name = 'letter' } = {}) {
  const session = `tawb-probe-${process.pid}-${name}-${sessions += 1}`;
  const tty = new LynxTty({ session, home: HOME, page: PAGE, config });
  tty.removeRc();
  await tty.start();
  try {
    return tty;
  } catch (err) {
    tty.stop();
    throw err;
  }
}

async function withLynx(options, run) {
  const tty = await lynx(options);
  try {
    return await run(tty);
  } finally {
    tty.stop();
  }
}

// ---------------------------------------------------------------------------
// The letter screen
// ---------------------------------------------------------------------------

test('the letter options screen is one fixed page with a Command prompt', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    assert.match(tty.line(0), /Options Menu \(Lynx Version/);

    // Nothing is said until something is chosen; the prompt sits one row above
    // the status line, and that is where the cursor is.
    assert.equal(tty.statusLine(), '');
    assert.match(tty.line(tty.rows - 2), /^Command: /);
    assert.deepEqual(tty.cursor(), { x: 9, y: tty.rows - 2 });

    // The screen names the two ways out and the one way to keep what changed.
    const prompt = tty.line(tty.rows - 3);
    assert.match(prompt, /Select capital letter of option line/);
    assert.match(prompt, /'>' to save/);
    assert.match(prompt, /'r' to return to Lynx\./);
  });
});

test('the letter screen offers every option Lynx documents', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    const fields = optionFields(tty.screen());
    const letters = new Set(fields.map((field) => field.letter));
    // The options this build of Lynx always shows. Three more are
    // conditional and absent without the features they describe compiled in:
    // (^A) assume charset needs advanced user mode, (Y) keyboard layout needs
    // EXP_KEYBOARD_LAYOUT, and (X) local execution needs EXEC_LINKS or
    // EXEC_SCRIPTS.
    for (const letter of ['E', 'D', 'L', 'B', 'F', 'P', 'S', 'G', 'H',
      'C', 'O', '&', 'V', 'M', 'W', 'T', '@', 'K', 'N', 'I', 'U', '!', 'A']) {
      assert.ok(letters.has(letter), `the letter screen has no option for ${letter}`);
    }
    // The label travels with the letter; a letter without its name is not a
    // match even if the set of letters is.
    const byLetter = new Map(fields.map((field) => [field.letter, plainLabel(field.label)]));
    assert.match(byLetter.get('@'), /show cursor/);
    assert.match(byLetter.get('S'), /searching type/i);
    assert.match(byLetter.get('K'), /keypad mode/i);
    assert.match(byLetter.get('U'), /user mode/i);
    assert.match(byLetter.get('!'), /verbose images/);
  });
});

test('a boolean option is chosen, changed, and accepted, as Lynx draws it', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    assert.match(tty.line(13), /show cursor \(@\) : OFF/);

    // Choosing the option does not change it. It offers to, and says how.
    await tty.press('@');
    assert.equal(tty.statusLine(), 'Hit any key to change value; RETURN to accept.');
    assert.match(tty.line(13), /show cursor \(@\) : OFF/);

    // Any key changes the value, and only RETURN keeps it.
    await tty.press('Space');
    assert.match(tty.line(13), /show cursor \(@\) : ON/);
    await tty.press('C-m');
    assert.equal(tty.statusLine(), 'Value accepted!');
    assert.deepEqual(tty.cursor(), { x: 9, y: tty.rows - 2 },
      'accepting a value puts the cursor back on the Command prompt');
    assert.match(tty.line(13), /show cursor \(@\) : ON/);
  });
});

test('a chosen option is abandoned with q or Left, and the old value stands', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    await tty.press('@');
    await tty.press('Space');
    assert.match(tty.line(13), /show cursor \(@\) : ON/);
    await tty.press('q');
    assert.equal(tty.statusLine(), 'Cancelled!!!');
    assert.match(tty.line(13), /show cursor \(@\) : OFF/,
      'a cancelled change leaves the value that was there');
  });
});

test('the searching type is a value chosen the same way', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    assert.match(tty.line(7), /\(S\)earching type\s*: CASE INSENSITIVE/);
    await tty.press('S');
    assert.equal(tty.statusLine(), 'Hit any key to change value; RETURN to accept.');
    await tty.press('Space');
    assert.match(tty.line(7), /\(S\)earching type\s*: CASE SENSITIVE/);
    await tty.press('C-m');
    assert.equal(tty.statusLine(), 'Value accepted!');
  });
});

test('an option with a list of values opens a choice list', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    assert.match(tty.line(14), /\(K\)eypad mode\s*: Numbers act as arrows/);
    await tty.press('K');
    assert.equal(tty.statusLine(),
      '(Choice list) Hit return and use arrow keys and return to select option.');
    // A list is walked and then taken, where a plain value is changed by any
    // key and taken with RETURN. The arrow key is the one that chooses here.
    await tty.press('Down');
    await tty.press('C-m');
    assert.equal(tty.statusLine(), 'Value accepted!');
    assert.match(tty.line(14), /\(K\)eypad mode\s*: Links are numbered/);
    await tty.press('>');
    let saved = null;
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      saved = tty.rc();
      if (saved) break;
      await sleep(100);
    }
    assert.equal((saved || {}).keypad_mode, 'LINKS_ARE_NUMBERED');
  });
});

test('show cursor puts the terminal cursor on the value being chosen', { skip }, async () => {
  await withLynx({ config: CURSOR_CFG }, async (tty) => {
    await tty.press('o');
    await tty.press('@');
    // Column 62 is where the value begins; with SHOW_CURSOR on Lynx sits one
    // column to its left, and leaves it there until the choice is accepted.
    assert.deepEqual(tty.cursor(), { x: 61, y: 13 });
    await tty.press('C-m');
    assert.deepEqual(tty.cursor(), { x: 9, y: tty.rows - 2 });
  });
});

// ---------------------------------------------------------------------------
// Keeping and leaving
// ---------------------------------------------------------------------------

test('greater-than saves the changed options and returns to the page', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    await tty.press('@');
    await tty.press('Space');
    await tty.press('C-m');
    await tty.press('>');

    // The file is written after the screen is restored, so the wait is on the
    // file rather than on the screen.
    let saved = null;
    for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
      saved = tty.rc();
      if (saved) break;
      await sleep(100);
    }
    assert.ok(saved, 'Lynx saved no options file at all');
    assert.equal(saved.show_cursor, 'on');
    // Leaving the options screen puts the page back, and Lynx says what it
    // did on the way out: either the save confirmation or its key bar.
    assert.match(tty.statusLine(), /Options saved!|H\)elp O\)ptions/);
    assert.equal(tty.rc().case_sensitive_searching, 'off');
  });
});

test('r returns to the page and saves nothing', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    await tty.press('@');
    await tty.press('Space');
    await tty.press('C-m');
    await tty.press('r');
    assert.equal(tty.rc(), null, 'r is a return, not a save');
    assert.match(tty.statusLine(), /H\)elp O\)ptions/);
  });
});

test('Left from the Command prompt leaves without saving', { skip }, async () => {
  await withLynx({}, async (tty) => {
    await tty.press('o');
    // The first Left is Lynx saying the screen is left with 'r'; the second
    // is the leaving. Both are part of the one gesture, and neither saves.
    await tty.press('Left');
    assert.match(tty.statusLine(), /'r' to return to Lynx/);
    assert.equal(tty.rc(), null);
    await tty.press('Left');
    assert.match(tty.statusLine(), /H\)elp O\)ptions/);
    assert.match(tty.line(0), /Probe Page/);
  });
});

// ---------------------------------------------------------------------------
// The default options screen
// ---------------------------------------------------------------------------

// Lynx's default is the forms-based options menu, which is not a screen at all
// but an HTML form in five pages, rendered by the same code that renders any
// other document. It is the one most readers see when they press `o`.
test('by default the options menu is a five-page form', { skip }, async () => {
  await withLynx({ config: FORMS_CFG, name: 'forms' }, async (tty) => {
    await tty.press('o');
    const screen = tty.screen();
    assert.match(screen, /Options Menu \(p1 of 5\)/);
    assert.match(screen, /Accept Changes/);
    assert.match(screen, /Reset Changes/);
    assert.match(screen, /Save options to disk: \[ \]/);
    assert.match(screen, /\(options marked with \(!\) will not be saved\)/);
    // The default page is the general preferences.
    assert.match(screen, /User mode\s*: \[Novice/);
    assert.match(screen, /Type of Search\s*: \[Case insensitive\]/);
    // With SHOW_CURSOR off, Lynx hides the cursor in the corner rather than on
    // the page, and this is a page.
    assert.deepEqual(tty.cursor(), { x: tty.cols - 1, y: tty.rows - 1 });
  });
});

test('the forms options menu is paged in both directions', { skip }, async () => {
  await withLynx({ config: FORMS_CFG, name: 'forms-pages' }, async (tty) => {
    await tty.press('o');
    await tty.press('NPage');
    assert.match(tty.screen(), /Options Menu \(p2 of 5\)/);
    await tty.press('PPage');
    assert.match(tty.screen(), /Options Menu \(p1 of 5\)/);
  });
});
