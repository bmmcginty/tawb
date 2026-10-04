'use strict';

const { KNOWN_SETTINGS } = require('./lynx_settings');

const KEYPAD_CHOICES = [
  ['NUMBERS_AS_ARROWS', 'Numbers act as arrows'],
  ['LINKS_ARE_NUMBERED', 'Links are numbered'],
  ['FIELDS_ARE_NUMBERED', 'Form fields are numbered'],
  ['LINKS_AND_FIELDS_ARE_NUMBERED', 'Links and form fields are numbered'],
];

function onOff(value) { return value ? 'ON' : 'OFF'; }

function optionRows(preferences = {}) {
  const keypad = KEYPAD_CHOICES.find(([value]) => value === preferences.keypadMode);
  const search = preferences.searchCase === 'CASE_SENSITIVE'
    ? 'CASE SENSITIVE' : 'CASE INSENSITIVE';
  const unavailable = 'not applicable (browser owned)';
  const imported = 'from imported Lynx map';
  return [
    '         Options Menu (TAWB Lynx interface)',
    '',
    `(E)ditor                     : ${unavailable}`,
    `(D)ISPLAY variable           : ${unavailable}`,
    `mu(L)ti-bookmarks            : ${unavailable}`,
    `(B)ookmark file              : ${unavailable}`,
    `(F)TP sort criteria          : ${unavailable}`,
    `(P)ersonal mail address      : ${unavailable}`,
    `(S)earching type             : ${search}`,
    `display (C)haracter set      : ${unavailable}`,
    `preferred document lan(G)uage: ${unavailable}`,
    `preferred document c(H)arset : ${unavailable}`,
    `(^A)ssume charset if unknown : ${unavailable}`,
    `Raw 8-bit or CJK m(O)de      : ${unavailable}`,
    `show color (&)               : OFF`,
    `(V)I keys                    : ${imported}`,
    `e(M)acs keys                 : ${imported}`,
    `sho(W) dot files             : ${unavailable}`,
    `popups for selec(T) fields   : ON`,
    `show cursor (@)              : ${onOff(preferences.showCursor)}`,
    `(K)eypad mode                : ${(keypad || KEYPAD_CHOICES[0])[1]}`,
    `li(N)e edit style            : ${imported}`,
    `Ke(Y)board layout            : ${unavailable}`,
    `l(I)st directory style       : ${unavailable}`,
    `(U)ser mode                  : Advanced`,
    `verbose images (!)           : ON`,
    `user (A)gent                 : ${unavailable}`,
    `local e(X)ecution links      : ALWAYS OFF`,
    '',
    "Select capital letter of option to change; '>' to save, or 'r' to return.",
  ].map((text) => ({ text, entry: null }));
}

function cycleOption(preferences, key) {
  const option = String(key).toUpperCase();
  if (option === '@') {
    preferences.showCursor = !preferences.showCursor;
    return 'show cursor';
  }
  if (option === 'S') {
    preferences.searchCase = preferences.searchCase === 'CASE_SENSITIVE'
      ? 'CASE_INSENSITIVE' : 'CASE_SENSITIVE';
    return 'searching type';
  }
  if (option === 'K') {
    const current = KEYPAD_CHOICES.findIndex(([value]) => value === preferences.keypadMode);
    const next = KEYPAD_CHOICES[(current + 1) % KEYPAD_CHOICES.length][0];
    preferences.keypadMode = next;
    preferences.numberLinks = next === 'LINKS_ARE_NUMBERED'
      || next === 'LINKS_AND_FIELDS_ARE_NUMBERED';
    preferences.numberFields = next === 'FIELDS_ARE_NUMBERED'
      || next === 'LINKS_AND_FIELDS_ARE_NUMBERED';
    return 'keypad mode';
  }
  return null;
}

function persistableOptions(preferences = {}) {
  return Object.fromEntries(Object.entries(preferences)
    .filter(([name]) => KNOWN_SETTINGS.has(name)));
}

module.exports = { KEYPAD_CHOICES, optionRows, cycleOption, persistableOptions };
