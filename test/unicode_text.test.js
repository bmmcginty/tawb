'use strict';

// Presentation of Unicode punctuation, differenced between the JavaScript
// original and the Crystal port. The mapping is deliberately conservative:
// listed punctuation gets an ASCII spelling, while unmapped symbols and
// non-Latin punctuation are left alone.

const test = require('node:test');
const assert = require('node:assert');

const javascript = require('../src/unicode_text');
const { escapeNonAscii } = require('../src/unicode_escape');
const { unicodeImplementations } = require('./crystal_impl');

const SAMPLE = '“Smart” ‘quotes’ — it’s 1–2… ½ 3×4 • café 中文 😀 。';

for (const implementation of unicodeImplementations(javascript)) {
  test(`${implementation.name}: typographic punctuation has an ASCII spelling`, () => {
    assert.equal(implementation.asciiPunctuation(SAMPLE),
      '"Smart" \'quotes\' -- it\'s 1-2... 1/2 3x4 * café 中文 😀 。');
  });

  test(`${implementation.name}: full Unicode leaves punctuation and symbols alone`, () => {
    assert.equal(implementation.presentText(SAMPLE, { unicode: 'full' }), SAMPLE);
  });

  test(`${implementation.name}: escaping follows ASCII punctuation`, () => {
    const input = '“café”…';
    assert.equal(implementation.presentText(input, { unicode: 'ascii', escape: true }),
      `"caf${escapeNonAscii('é')}"...`);
  });

  test(`${implementation.name}: full Unicode can still be escaped`, () => {
    assert.equal(implementation.presentText('“é”', { unicode: 'full', escape: true }),
      escapeNonAscii('“é”'));
  });

  test(`${implementation.name}: displayed caret offsets account for replacements`, () => {
    const value = 'a…“é”';
    for (const offset of [0, 1, 2, 3, 4, 5, 6]) {
      assert.equal(
        implementation.presentOffset(value, offset, { unicode: 'ascii' }),
        javascript.presentOffset(value, offset, { unicode: 'ascii' }),
        `offset ${offset}`);
    }
    assert.equal(implementation.presentOffset(value, 2, { unicode: 'ascii' }), 4);
    assert.equal(implementation.presentOffset(value, 3, { unicode: 'ascii', escape: true }), 5);
  });
}
