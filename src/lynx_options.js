'use strict';

const { KNOWN_SETTINGS } = require('./lynx_settings');

// Lynx's Options screen, in Lynx's words.
//
// The screen is a list of options, each named by a capital letter inside its
// own label, and each holding one value. Choosing the letter does not change
// the value: it offers to, and the reader either changes it and presses RETURN
// or leaves it with q. The words for all of that are Lynx's, so a reader who
// knows the screen already knows this one.
//
// An option TAWB cannot honor still appears here. It is named, not hidden, and
// saying so is more useful than a screen that quietly has fewer options than
// the program the reader came from.

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
// derived halves; Lynx's own set_numbers_as_arrows/reset_numbers_as_arrows do
// the same thing.
function keypadSideEffects(preferences) {
  const mode = preferences.keypadMode;
  preferences.numberLinks = mode === 'LINKS_ARE_NUMBERED'
    || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
  preferences.numberFields = mode === 'FIELDS_ARE_NUMBERED'
    || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
}

// The labels are Lynx's, letter and all, in Lynx's order. `fixed` is a value
// TAWB has no setting for and does not pretend to: what Lynx would show is
// shown, and choosing it says where the option really lives.
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
  { letter: 'C', label: 'display (C)haracter set', fixed: 'UNICODE (UTF-8)' },
  { letter: 'O', label: 'Raw 8-bit or CJK m(O)de', fixed: 'OFF' },
  { letter: '&', label: 'show color (&)', fixed: 'OFF' },
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
  { letter: 'X', label: 'local e(X)ecution links', fixed: 'ALWAYS OFF' },
];

const BY_LETTER = new Map(OPTIONS.map((option) => [option.letter, option]));

// Lynx's own words for the three moments of choosing.
const ANY_KEY_CHANGE = 'Hit any key to change value; RETURN to accept.';
const VALUE_ACCEPTED = 'Value accepted!';
const CANCELLED = 'Cancelled!!!';
const CHOICE_LIST = '(Choice list) Hit return and use arrow keys and return to select option.';
const SELECT_LINE = "Select capital letter of option line, '>' to save, or 'r' to return to Lynx.";
const NOT_CHANGEABLE = 'That option belongs to Lynx or the browser and is not changed by TAWB.';

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

// One row per option, in Lynx's order. The label is padded to the column Lynx
// aligns its values at, so the screen reads as a column of values even though
// TAWB draws each option on a line of its own.
const LABEL_WIDTH = 31;

function optionRows(preferences = {}) {
  return OPTIONS.map((option) => ({
    letter: option.letter,
    option,
    text: `${option.label.padEnd(LABEL_WIDTH)}: ${optionValue(option, preferences)}`,
  }));
}

function persistableOptions(preferences = {}) {
  return Object.fromEntries(Object.entries(preferences)
    .filter(([name]) => KNOWN_SETTINGS.has(name)));
}

module.exports = {
  OPTIONS, KEYPAD_CHOICES, SEARCH_CHOICES,
  ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST, SELECT_LINE, NOT_CHANGEABLE,
  optionForLetter, choiceIndex, optionValue, applyChoice, optionRows, persistableOptions,
};
