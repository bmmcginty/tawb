'use strict';

// The Lynx Options menu, differenced between the JavaScript original and the
// Crystal port: the screen is Lynx's own lines row for row, every value sits
// where Lynx puts it, choosing is provisional until RETURN, and the terminal
// sees the same byte-level calls through a fake host.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { lynxOptionsImplementations } = require('./crystal_impl');

const implementations = lynxOptionsImplementations(
  require('../src/lynx_options'),
  require('../src/lynx_options_screen'),
  require('../src/lynx_settings'),
);

const PREFERENCES = {
  keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
  numberLinksOnLeft: true, numberFieldsOnLeft: true,
  textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
};

// Lynx's own lines, from the capture driven against the real program. Two
// rows differ by design: the title says which program is drawing, and the
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

const eventsOf = (result, kind) => result.events.filter((entry) => entry[0] === kind);
const lineEvents = (result) => eventsOf(result, 'line');

for (const implementation of implementations) {
  test(`${implementation.name}: the screen is Lynx's lines, row for row`, () => {
    const lines = implementation.model('screen_lines', { preferences: PREFERENCES });
    assert.deepEqual(lines.map((line) => line.text), STOCK_SCREEN);
    assert.equal(implementation.model('constants').commandRow, STOCK_SCREEN.length);
  });

  test(`${implementation.name}: every option is where Lynx puts it, column and all`, () => {
    const lines = implementation.model('screen_lines', { preferences: PREFERENCES });
    const at = (letter) => {
      for (let row = 0; row < lines.length; row += 1) {
        const field = lines[row].fields.find((candidate) => candidate.letter === letter);
        if (field) return { row, column: field.start };
      }
      return null;
    };
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

  test(`${implementation.name}: the two options on one row each keep their own value`, () => {
    const lines = implementation.model('screen_lines', {
      preferences: { ...PREFERENCES, showCursor: true },
    });
    assert.match(lines[13].text, /popups for selec\(T\) fields   : ON/);
    assert.match(lines[13].text, /show cursor \(@\) : ON/);
    const at = lines[13].fields.find((field) => field.letter === '@');
    assert.equal(lines[13].text.slice(at.start).startsWith('ON'), true);
  });

  test(`${implementation.name}: drawing the screen writes every row and leaves the cursor on Command`, () => {
    const result = implementation.screen({ keys: [] });
    const lines = lineEvents(result);
    const cursors = eventsOf(result, 'cursor');
    assert.deepEqual(result.events[0], ['clear'], 'opening clears the screen first');
    assert.deepEqual(result.events[1], ['reset']);
    assert.equal(lines.length, STOCK_SCREEN.length + 1, 'the rows, then Command');
    assert.deepEqual(lines.at(-1), ['line', STOCK_SCREEN.length + 1, 'Command: ']);
    assert.deepEqual(cursors.at(-1), ['cursor', STOCK_SCREEN.length + 1, 'Command: '.length + 1]);
    assert.equal(result.mode, 'options');
    assert.deepEqual(result.events.at(-1), ['cursor', STOCK_SCREEN.length + 1, 'Command: '.length + 1],
      'the cursor is left on the Command prompt');
  });

  test(`${implementation.name}: SHOW_CURSOR decides which side of a chosen value the cursor sits on`, () => {
    const hidden = implementation.screen({ keys: ['@'] });
    // The value runs from column 62 to 65, so the cursor is after it.
    assert.deepEqual(eventsOf(hidden, 'cursor').at(-1), ['cursor', 14, 66]);
    assert.equal(hidden.preferences.showCursor, false, 'choosing changed nothing yet');

    const shown = implementation.screen({ keys: ['@'], preferences: { showCursor: true } });
    assert.deepEqual(eventsOf(shown, 'cursor').at(-1), ['cursor', 14, 62]);
  });

  test(`${implementation.name}: the chosen value is drawn in reverse video and nothing else is`, () => {
    const result = implementation.screen({ keys: ['@'] });
    const painted = lineEvents(result).map((entry) => entry[2])
      .filter((text) => text.includes('\x1b[7m'));
    assert.equal(painted.length, 1, 'only one row carries the highlight');
    assert.ok(painted[0].includes('\x1b[7mOFF\x1b[0m'), 'the value is highlighted');
    // The other value on that row stays plain.
    assert.equal(painted[0].split('\x1b[7m').length, 2);
  });

  test(`${implementation.name}: r leaves with the choices kept for the session`, () => {
    const result = implementation.screen({ keys: ['@', ' ', '\r', 'r'] });
    assert.equal(result.mode, 'browse');
    assert.equal(result.choosing, null);
    assert.equal(result.preferences.showCursor, true);
    assert.deepEqual(result.written, [], 'leaving with r writes nothing');
  });

  test(`${implementation.name}: Left leaves with nothing changed`, () => {
    const result = implementation.screen({ keys: ['@', ' ', '\r', '[ArrowLeft]'] });
    assert.equal(result.mode, 'browse');
    assert.equal(result.preferences.showCursor, false);
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.equal(statuses.includes('Options unchanged.'), true);
  });

  test(`${implementation.name}: greater-than saves what was decided and leaves`, () => {
    const file = path.join(tempDir(`tawb-options-save-${implementation.name}-`), 'settings.lynx.json');
    const result = implementation.screen({ keys: ['@', ' ', '\r', '>'], settingsFile: file });
    assert.equal(result.mode, 'browse');
    assert.equal(result.events.filter((entry) => entry[0] === 'status').at(-1)[1], 'Options saved.');
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(document.lynx.showCursor, true);
    assert.equal(document.lynx.searchCase, 'CASE_INSENSITIVE');
    assert.equal(Object.hasOwn(document.lynx, 'numberLinks'), false,
      'derived values do not become independent settings');
    assert.equal(result.settingsFileExists, true);
  });

  test(`${implementation.name}: a value chosen and not accepted is not saved`, () => {
    const file = path.join(tempDir(`tawb-options-cancel-${implementation.name}-`), 'settings.lynx.json');
    const result = implementation.screen({ keys: ['@', ' ', 'q', '>'], settingsFile: file });
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(document.lynx.showCursor, false,
      'a cancelled value was written as if it had been accepted');
    assert.equal(result.preferences.showCursor, false);
  });

  test(`${implementation.name}: a boolean is chosen, changed and accepted, and the screen shows it`, () => {
    const result = implementation.screen({ keys: ['@', ' ', '\r'] });
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.ok(statuses.includes('Hit any key to change value; RETURN to accept.'));
    assert.ok(statuses.includes('Value accepted!'));
    assert.equal(result.preferences.showCursor, true);
    assert.equal(result.choosing, null);
    const row = lineEvents(result).filter((entry) => entry[1] === 14).at(-1)[2];
    assert.match(row, /show cursor \(@\) : ON/);
  });

  test(`${implementation.name}: a cancelled value is put back and the screen says so`, () => {
    const result = implementation.screen({ keys: ['@', ' ', 'q'] });
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.equal(statuses.at(-1), 'Cancelled!!!');
    assert.equal(result.preferences.showCursor, false);
    const row = lineEvents(result).filter((entry) => entry[1] === 14).at(-1)[2];
    assert.match(row, /show cursor \(@\) : OFF/);
  });

  test(`${implementation.name}: the searching type is a boolean, changed the same way`, () => {
    const result = implementation.screen({ keys: ['S', ' ', '\r'] });
    assert.equal(result.preferences.searchCase, 'CASE_SENSITIVE');
    const row = lineEvents(result).filter((entry) => entry[1] === 8).at(-1)[2];
    assert.match(row, /: CASE SENSITIVE/);
  });

  test(`${implementation.name}: an option with several values walks a list with the arrows`, () => {
    const result = implementation.screen({ keys: ['K', '[ArrowDown]', '\r'] });
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.ok(statuses.includes('(Choice list) Hit return and use arrow keys and return to select option.'));
    assert.ok(statuses.includes('Value accepted!'));
    assert.equal(result.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
    assert.equal(result.preferences.numberLinks, true);
    assert.equal(result.preferences.numberFields, false);
    const row = lineEvents(result).filter((entry) => entry[1] === 15).at(-1)[2];
    assert.match(row, /: Links are numbered/);
  });

  test(`${implementation.name}: an option TAWB cannot change still names itself`, () => {
    const result = implementation.screen({ keys: ['E'] });
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.equal(statuses.at(-1),
      'That option belongs to Lynx or the browser and is not changed by TAWB.');
    assert.equal(result.choosing, null);
    assert.equal(result.mode, 'options');
  });

  test(`${implementation.name}: the classic menu requires its displayed capital letter`, () => {
    const result = implementation.screen({ keys: ['k'] });
    assert.equal(result.choosing, null, 'lowercase k chose the Keypad option');
    const statuses = eventsOf(result, 'status').map((entry) => entry[1]);
    assert.deepEqual(statuses, [''], 'open said nothing, and the unbound key said less');
  });

  test(`${implementation.name}: derived numbering follows the keypad mode when applied directly`, () => {
    const applied = implementation.model('apply_choice', {
      letter: 'K', index: 1, preferences: PREFERENCES,
    });
    assert.equal(applied.keypadMode, 'LINKS_ARE_NUMBERED');
    assert.equal(applied.numberLinks, true);
    assert.equal(applied.numberFields, false);
    // Persisting the same preferences drops the derived halves.
    const persisted = implementation.model('persistable', { preferences: applied });
    assert.equal(Object.hasOwn(persisted, 'numberLinks'), false);
    assert.deepEqual(Object.keys(persisted).sort(), [
      'keypadMode', 'numberFieldsOnLeft', 'numberLinksOnLeft',
      'searchCase', 'showCursor', 'textfieldsNeedActivation',
    ]);
  });
}
