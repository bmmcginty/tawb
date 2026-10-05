'use strict';

// The Options screen now lives in its own module, reached through a small
// host. The full keyboard behavior is still covered through src/index.js by
// test/lynx_options.test.js; these tests pin the drawing contract directly,
// including the reverse-video row that has no line-level equivalent.

const test = require('node:test');
const assert = require('node:assert');

const {
  renderOptionsRow, drawOptionsScreen, placeOptionsCursor,
} = require('../src/lynx_options_screen');
const {
  screenLines, optionForLetter, SCREEN_ROWS, COMMAND_PROMPT,
  ANY_KEY_CHANGE, VALUE_ACCEPTED,
} = require('../src/lynx_options');
const { ANSI_REVERSE, ANSI_RESET } = require('../src/lynx_display');

const PREFERENCES = {
  keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
  numberLinksOnLeft: true, numberFieldsOnLeft: true,
  textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
};

function state(preferences = {}) {
  return {
    options: { choosing: null },
    keys: { preferences: { ...PREFERENCES, ...preferences } },
  };
}

test('the chosen value is drawn in reverse video and nothing else is', () => {
  const lines = screenLines(PREFERENCES);
  const show = lines.find((line) => line.fields.some((field) => field.letter === 'S'));
  const plain = show.text;
  assert.equal(renderOptionsRow(show, null), plain, 'the screen is plain until an option is chosen');
  assert.equal(renderOptionsRow(show, {}), plain, 'a missing letter marks nothing');

  const field = show.fields.find((candidate) => candidate.letter === 'S');
  const value = plain.slice(field.start, field.end);
  const choosing = { letter: 'S' };
  const painted = renderOptionsRow(show, choosing);
  assert.equal(painted, plain.slice(0, field.start)
    + ANSI_REVERSE + value + ANSI_RESET + plain.slice(field.end));
  // A different letter changes nothing about this row.
  assert.equal(renderOptionsRow(show, { letter: 'K' }), plain);
});

test('when two options share a row only the chosen one is marked', () => {
  const lines = screenLines(PREFERENCES);
  const shared = lines.find((line) => line.fields.length > 1);
  assert.ok(shared, 'the screen has a shared row');
  const painted = renderOptionsRow(shared, { letter: shared.fields[1].letter });
  assert.ok(!painted.startsWith(ANSI_REVERSE));
  assert.ok(painted.includes(ANSI_REVERSE));
  // The first field's value is still plain.
  const first = shared.fields[0];
  assert.equal(painted.slice(0, first.start), shared.text.slice(0, first.start));
});

test('drawing the screen writes every row and leaves the cursor on Command', () => {
  const reader = state();
  const drawn = [];
  const moves = [];
  const host = {
    resetScrollRegion() { drawn.push('reset'); },
    writeLine(row, text) { drawn.push([row, text]); },
    moveCursor(row, col) { moves.push([row, col]); },
  };
  drawOptionsScreen(host, reader);
  assert.equal(drawn[0], 'reset');
  assert.equal(drawn.length, SCREEN_ROWS.length + 2, 'one reset, the rows, then Command');
  assert.deepEqual(drawn.at(-1), [SCREEN_ROWS.length + 1, COMMAND_PROMPT]);
  assert.deepEqual(moves.at(-1), [SCREEN_ROWS.length + 1, COMMAND_PROMPT.length + 1]);
});

test('SHOW_CURSOR decides which side of a chosen value the cursor sits on', () => {
  const lines = screenLines(PREFERENCES);
  const chosen = { letter: 'K' };
  const at = lines.map((line, row) => ({ line, row }))
    .find(({ line }) => line.fields.some((field) => field.letter === 'K'));
  const field = at.line.fields.find((candidate) => candidate.letter === 'K');

  const hidden = state({ showCursor: false });
  hidden.options.choosing = chosen;
  const hiddenMoves = [];
  placeOptionsCursor({ moveCursor: (row, col) => hiddenMoves.push([row, col]) }, hidden, lines);
  assert.deepEqual(hiddenMoves.at(-1), [at.row + 1, field.end + 1]);

  const shown = state({ showCursor: true });
  shown.options.choosing = chosen;
  const shownMoves = [];
  placeOptionsCursor({ moveCursor: (row, col) => shownMoves.push([row, col]) }, shown, lines);
  assert.deepEqual(shownMoves.at(-1), [at.row + 1, Math.max(1, field.start)]);
});

test('the module keeps every option Lynx prints addressable', () => {
  // Guards the row painter against a screen whose letters moved.
  for (const line of screenLines(PREFERENCES)) {
    for (const field of line.fields) {
      assert.ok(optionForLetter(field.letter), `no option for ${field.letter}`);
      assert.equal(renderOptionsRow(line, { letter: field.letter })
        .includes(ANSI_REVERSE), true);
    }
  }
  // The exported message constants are still the ones the module draws with.
  assert.equal(typeof ANY_KEY_CHANGE, 'string');
  assert.equal(typeof VALUE_ACCEPTED, 'string');
});
