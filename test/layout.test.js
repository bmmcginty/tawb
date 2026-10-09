'use strict';

const test = require('node:test');
const assert = require('node:assert');
const javascript = require('../src/layout');
const { layoutImplementations } = require('./crystal_impl');

for (const implementation of layoutImplementations(javascript)) {
  const { wrapWithOffsets, spansWithin, layoutLines } = implementation;
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('word wrapping retains browser UTF-16 offsets', () => {
    assert.deepEqual(wrapWithOffsets('one two three', 7), [
      { text: 'one', start: 0, end: 3 },
      { text: 'two', start: 4, end: 7 },
      { text: 'three', start: 8, end: 13 },
    ]);
    assert.deepEqual(wrapWithOffsets('abcdefgh', 3), [
      { text: 'abc', start: 0, end: 3 },
      { text: 'def', start: 3, end: 6 },
      { text: 'gh', start: 6, end: 8 },
    ]);
    assert.deepEqual(wrapWithOffsets('😀x y', 3), [
      { text: '😀x', start: 0, end: 3 },
      { text: 'y', start: 4, end: 5 },
    ]);
  });

  check('newlines split rows and other controls become spaces', () => {
    assert.deepEqual(wrapWithOffsets('a\nb\tc', 10), [
      { text: 'a', start: 0, end: 1 },
      { text: 'b c', start: 2, end: 5 },
    ]);
  });

  check('wrapped rows clip composite spans to row-relative offsets', () => {
    assert.deepEqual(spansWithin([
      { blockIndex: 1, start: 1, end: 5 },
      { blockIndex: 2, start: 6, end: 9 },
    ], 3, 7), [
      { blockIndex: 1, start: 0, end: 2 },
      { blockIndex: 2, start: 3, end: 4 },
    ]);
  });

  check('line layout reserves margins and number markers while wrapping', () => {
    const lines = layoutLines([{
      text: 'Alpha Beta',
      displayIndent: 3,
      displayPrefix: '[1]',
      displaySuffix: '',
      spans: [
        { blockIndex: 0, start: 0, end: 5 },
        { blockIndex: 1, start: 6, end: 10 },
      ],
    }], 10);
    assert.deepEqual(lines.map(({ text, start, end, displayPrefix, continuation }) => ({
      text, start, end, displayPrefix, continuation,
    })), [
      { text: 'Alph', start: 0, end: 4, displayPrefix: '[1]', continuation: false },
      { text: 'a', start: 4, end: 5, displayPrefix: '', continuation: true },
      { text: 'Beta', start: 6, end: 10, displayPrefix: '', continuation: true },
    ]);
    assert.deepEqual(lines.map((line) => line.spans), [
      [{ blockIndex: 0, start: 0, end: 4 }],
      [{ blockIndex: 0, start: 0, end: 1 }],
      [{ blockIndex: 1, start: 0, end: 4 }],
    ]);
  });
}
