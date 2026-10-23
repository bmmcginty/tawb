'use strict';

const { escapeNonAscii } = require('./unicode_escape');

// How page text is presented when the terminal does not need the original
// Unicode punctuation. The mapping is deliberately presentation-only: the
// core keeps the page's own characters for activation, searching and form
// submission, and only what is drawn passes through here.
//
// `full` leaves every character alone. The default is `ascii`, which turns the
// typographic punctuation and symbols below into the characters a terminal
// font and a speech synthesizer are least likely to misread. Anything not in
// the table is left alone: a CJK punctuation mark or an emoji has no honest
// ASCII spelling, and replacing it with "?" loses more than it gains.
const ASCII_PUNCTUATION = new Map([
  // Quotes, apostrophes and primes.
  [0x00ab, '<<'], [0x00bb, '>>'],
  [0x2018, "'"], [0x2019, "'"], [0x201a, "'"], [0x201b, "'"],
  [0x201c, '"'], [0x201d, '"'], [0x201e, '"'], [0x201f, '"'],
  [0x2032, "'"], [0x2033, '"'], [0x2034, "'"], [0x2035, '`'], [0x2036, "'"],
  [0x2039, '<'], [0x203a, '>'],
  [0x00b4, "'"], [0x02b9, "'"], [0x02bc, "'"], [0x02c8, "'"],

  // Dashes and hyphens.
  [0x00ad, ''], [0x2010, '-'], [0x2011, '-'], [0x2012, '-'],
  [0x2013, '-'], [0x2014, '--'], [0x2015, '--'],
  [0x2043, '-'], [0x2052, '-'], [0x2212, '-'],
  [0xfe58, '-'], [0xfe63, '-'], [0xff0d, '-'],

  // Ellipses and leaders.
  [0x2024, '.'], [0x2025, '..'], [0x2026, '...'],

  // Spaces that are visually indistinguishable from an ordinary one.
  [0x00a0, ' '], [0x2000, ' '], [0x2001, ' '], [0x2002, ' '],
  [0x2003, ' '], [0x2004, ' '], [0x2005, ' '], [0x2006, ' '],
  [0x2007, ' '], [0x2008, ' '], [0x2009, ' '], [0x200a, ' '],
  [0x202f, ' '], [0x205f, ' '], [0x3000, ' '],

  // Zero-width formatting characters, which only add invisible width.
  [0x200b, ''], [0x200c, ''], [0x200d, ''], [0xfeff, ''],

  // Bullets and dot punctuation.
  [0x00b7, '.'], [0x2022, '*'], [0x2023, '*'], [0x2027, '-'],
  [0x2219, '*'], [0x25cf, '*'], [0x25e6, '*'],

  // Fractions.
  [0x00bc, '1/4'], [0x00bd, '1/2'], [0x00be, '3/4'],
  [0x2150, '1/7'], [0x2151, '1/9'], [0x2152, '1/10'], [0x2153, '1/3'],
  [0x2154, '2/3'], [0x2155, '1/5'], [0x2156, '2/5'], [0x2157, '3/5'],
  [0x2158, '4/5'], [0x2159, '1/6'], [0x215a, '5/6'], [0x215b, '1/8'],
  [0x215c, '3/8'], [0x215d, '5/8'], [0x215e, '7/8'],
  [0x2044, '/'], [0x2215, '/'],

  // Mathematical and relational signs.
  [0x00b1, '+-'], [0x00d7, 'x'], [0x00f7, '/'], [0x2248, '~='],
  [0x2260, '!='], [0x2264, '<='], [0x2265, '>='],
  [0x2190, '<-'], [0x2191, '^'], [0x2192, '->'], [0x2193, 'v'],
  [0x2194, '<->'], [0x21d0, '<='], [0x21d2, '=>'], [0x21d4, '<=>'],

  // Copyright and trademark marks.
  [0x00a9, '(C)'], [0x00ae, '(R)'], [0x2122, '(TM)'],

  // Other common punctuation.
  [0x00a1, '!'], [0x00bf, '?'], [0x2020, '+'], [0x2021, '++'],
  [0x2030, '0/00'], [0x2031, '0/000'], [0x2038, '^'], [0x203b, '*'],
  [0x203c, '!!'], [0x203d, '?!'], [0x2042, '***'], [0x2045, '['],
  [0x2046, ']'], [0x2047, '??'], [0x2048, '?!'], [0x2049, '!?'],
  [0x204e, '*'], [0x2051, '**'], [0x2053, '~'],
]);

function asciiPunctuation(value) {
  let out = '';
  for (const character of String(value ?? '')) {
    const replacement = ASCII_PUNCTUATION.get(character.codePointAt(0));
    out += replacement === undefined ? character : replacement;
  }
  return out;
}

function presentText(value, { unicode = 'ascii', escape = false } = {}) {
  const text = unicode === 'full' ? String(value ?? '') : asciiPunctuation(value);
  return escape ? escapeNonAscii(text) : text;
}

// The display width of the first `offset` UTF-16 units of *value* after the
// same presentation transform used for the page. Caret offsets come from the
// browser in UTF-16 units, while ASCII replacements can change their length.
function presentOffset(value, offset, { unicode = 'ascii', escape = false } = {}) {
  const prefix = String(value ?? '').slice(0, offset);
  if (unicode === 'full' && !escape) return prefix.length;
  const shown = presentText(prefix, { unicode, escape });
  return shown.length;
}

module.exports = { ASCII_PUNCTUATION, asciiPunctuation, presentText, presentOffset };
