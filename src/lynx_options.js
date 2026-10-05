'use strict';

const { KNOWN_SETTINGS } = require('./lynx_settings');

// Lynx's single-screen Options menu, in Lynx's own lines.
//
// Every row here is a line a real Lynx prints on an 80-column terminal, with
// the spacing and column positions it uses. Some rows carry more than one
// option; each option's value is written at the column Lynx puts it, so what a
// reader sees is the screen they know rather than a list of the same settings.
//
// Choosing a letter does not change a value. It offers to: the value is shown
// and the reader either changes it and presses RETURN or leaves it with q. The
// words for all of that are Lynx's too.

const KEYPAD_CHOICES = [
  ['NUMBERS_AS_ARROWS', 'Numbers act as arrows'],
  ['LINKS_ARE_NUMBERED', 'Links are numbered'],
  ['FIELDS_ARE_NUMBERED', 'Form fields are numbered'],
  ['LINKS_AND_FIELDS_ARE_NUMBERED', 'Links and form fields are numbered'],
];

// A boolean is a list of two values like any other; what makes it different is
// that any key moves to the next one, where a longer list is walked with the
// arrow keys.
const ON_OFF = [[false, 'OFF'], [true, 'ON']];
const SEARCH_CHOICES = [
  ['CASE_INSENSITIVE', 'CASE INSENSITIVE'],
  ['CASE_SENSITIVE', 'CASE SENSITIVE'],
];

// Keypad mode and the numbering preferences it drives are one setting with two
// derived halves, which is what Lynx's set_numbers_as_arrows does.
function keypadSideEffects(preferences) {
  const mode = preferences.keypadMode;
  preferences.numberLinks = mode === 'LINKS_ARE_NUMBERED'
    || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
  preferences.numberFields = mode === 'FIELDS_ARE_NUMBERED'
    || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
}

// `fixed` is a value TAWB has no setting for and does not pretend to: what Lynx
// would show is shown, and choosing it says where the option really lives.
const OPTIONS = [
  { letter: 'E', label: '(E)ditor', fixed: 'NONE' },
  { letter: 'D', label: '(D)ISPLAY variable', fixed: 'NONE' },
  { letter: 'L', label: 'mu(L)ti-bookmarks', fixed: 'OFF' },
  { letter: 'B', label: '(B)ookmark file', fixed: 'lynx_bookmarks.html' },
  { letter: 'F', label: '(F)TP sort criteria', fixed: 'By Filename' },
  { letter: 'P', label: '(P)ersonal mail address', fixed: 'NONE' },
  { letter: 'S', label: '(S)earching type', choices: SEARCH_CHOICES, key: 'searchCase' },
  { letter: 'G', label: 'preferred document lan(G)uage', fixed: 'en' },
  { letter: 'H', label: 'preferred document c(H)arset', fixed: 'NONE' },
  { letter: 'C', label: 'display (C)haracter set', fixed: 'Western (ISO-8859-1)' },
  { letter: 'O', label: 'Raw 8-bit or CJK m(O)de', fixed: 'ON' },
  { letter: '&', label: 'show color (&)', fixed: 'ON' },
  { letter: 'V', label: '(V)I keys', fixed: 'OFF' },
  { letter: 'M', label: 'e(M)acs keys', fixed: 'OFF' },
  { letter: 'W', label: 'sho(W) dot files', fixed: 'OFF' },
  { letter: 'T', label: 'popups for selec(T) fields', fixed: 'ON' },
  { letter: '@', label: 'show cursor (@)', choices: ON_OFF, key: 'showCursor', boolean: true },
  {
    letter: 'K',
    label: '(K)eypad mode',
    choices: KEYPAD_CHOICES,
    key: 'keypadMode',
    sideEffects: keypadSideEffects,
  },
  { letter: 'N', label: 'li(N)e edit style', fixed: 'Default Binding' },
  { letter: 'I', label: 'l(I)st directory style', fixed: 'Mixed style' },
  { letter: 'U', label: '(U)ser mode', fixed: 'Novice' },
  { letter: '!', label: 'verbose images (!)', fixed: 'ON' },
  { letter: 'A', label: 'user (A)gent', fixed: 'TAWB' },
];

const BY_LETTER = new Map(OPTIONS.map((option) => [option.letter, option]));

const ANY_KEY_CHANGE = 'Hit any key to change value; RETURN to accept.';
const VALUE_ACCEPTED = 'Value accepted!';
const CANCELLED = 'Cancelled!!!';
const CHOICE_LIST = '(Choice list) Hit return and use arrow keys and return to select option.';
const SELECT_LINE = "  Select capital letter of option line, '>' to save, or 'r' to return to Lynx.";
const COMMAND_PROMPT = 'Command: ';
const NOT_CHANGEABLE = 'That option belongs to Lynx or the browser and is not changed by TAWB.';

// The screen, one entry per row, in the order Lynx draws it. A row with
// `fields` holds one or more options: `[letter, valueColumn, prefix]`, where
// the prefix is everything Lynx prints before that option's value — including
// the spaces that follow the value before it.
const SCREEN_ROWS = [
  { text: '              Options Menu (TAWB Lynx interface)' },
  { text: '' },
  { fields: [['E', 36, '     (E)ditor                     : ']] },
  { fields: [['D', 36, '     (D)ISPLAY variable           : ']] },
  { fields: [['L', 24, '     mu(L)ti-bookmarks: '], ['B', 51, '       (B)ookmark file: ']] },
  { fields: [['F', 36, '     (F)TP sort criteria          : ']] },
  { fields: [['P', 36, '     (P)ersonal mail address      : ']] },
  { fields: [['S', 36, '     (S)earching type             : ']] },
  { fields: [['G', 36, '     preferred document lan(G)uage: ']] },
  { fields: [['H', 36, '     preferred document c(H)arset : ']] },
  { fields: [['C', 36, '     display (C)haracter set      : ']] },
  { fields: [['O', 36, '     Raw 8-bit or CJK m(O)de      : '], ['&', 62, '      show color (&)  : ']] },
  { fields: [['V', 16, '     (V)I keys: '], ['M', 36, '   e(M)acs keys: '], ['W', 62, '     sho(W) dot files: ']] },
  { fields: [['T', 36, '     popups for selec(T) fields   : '], ['@', 62, '      show cursor (@) : ']] },
  { fields: [['K', 36, '     (K)eypad mode                : ']] },
  { fields: [['N', 36, '     li(N)e edit style            : ']] },
  { text: '' },
  { fields: [['I', 36, '     l(I)st directory style       : ']] },
  { fields: [['U', 36, '     (U)ser mode                  : '], ['!', 71, '        verbose images (!) : ']] },
  { fields: [['A', 36, '     user (A)gent                 : ']] },
  // Lynx wraps a long user-agent string onto this row. TAWB's is one word, so
  // the row stays blank and the rows below keep their Lynx positions.
  { text: '' },
  { text: SELECT_LINE },
];

// The row the Command prompt is on, counting the screen's own rows from zero.
const COMMAND_ROW = SCREEN_ROWS.length;

function optionForLetter(letter) {
  return BY_LETTER.get(String(letter)) || null;
}

function choiceIndex(option, preferences) {
  if (!option.choices) return -1;
  const current = preferences[option.key];
  return option.choices.findIndex(([value]) => value === current);
}

function optionValue(option, preferences) {
  if (option.fixed !== undefined) return option.fixed;
  const index = choiceIndex(option, preferences);
  return option.choices[index < 0 ? 0 : index][1];
}

function applyChoice(option, preferences, index) {
  const [value] = option.choices[index];
  preferences[option.key] = value;
  if (option.sideEffects) option.sideEffects(preferences);
}

// The screen for these preferences: one line per row, and where on each line
// every option's value begins and ends. Nothing here knows about highlighting
// or cursors; that is the terminal's business.
function screenLines(preferences = {}) {
  return SCREEN_ROWS.map((row) => {
    if (row.text !== undefined) return { text: row.text, fields: [] };
    let text = '';
    const fields = [];
    for (const [letter, column, prefix] of row.fields) {
      text += prefix;
      const start = text.length;
      text += optionValue(optionForLetter(letter), preferences);
      fields.push({ letter, column, start, end: text.length });
    }
    return { text, fields };
  });
}

// Where an option's value is on the screen: its row, and the column its value
// starts at.
function optionPosition(lines, letter) {
  for (let row = 0; row < lines.length; row += 1) {
    const field = lines[row].fields.find((candidate) => candidate.letter === letter);
    if (field) return { row, column: field.start, field };
  }
  return null;
}

function persistableOptions(preferences = {}) {
  return Object.fromEntries(Object.entries(preferences)
    .filter(([name]) => KNOWN_SETTINGS.has(name)));
}

module.exports = {
  OPTIONS, SCREEN_ROWS, KEYPAD_CHOICES, SEARCH_CHOICES,
  ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST, SELECT_LINE,
  COMMAND_PROMPT, COMMAND_ROW, NOT_CHANGEABLE,
  optionForLetter, choiceIndex, optionValue, applyChoice,
  screenLines, optionPosition, persistableOptions,
};
