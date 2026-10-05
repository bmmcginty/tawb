'use strict';

// The number prompt's arithmetic, tested where it now lives. Everything here
// was already exercised through src/index.js; these tests pin the same answers
// at the module boundary and add the cases the loop could not reach directly.

const test = require('node:test');
const assert = require('node:assert');

const { parseLynxNumberExpression, relativeLinkNumber } = require('../src/lynx_number');

test('a plain number asks to follow that item', () => {
  assert.deepEqual(parseLynxNumberExpression('12'),
    { number: 12, command: 'follow', relative: 0 });
});

test('p and g choose page movement and move-without-activation', () => {
  assert.deepEqual(parseLynxNumberExpression('3p'),
    { number: 3, command: 'page', relative: 0 });
  assert.deepEqual(parseLynxNumberExpression('4G'),
    { number: 4, command: 'move', relative: 0 });
});

test('a sign may come before or after the command letter', () => {
  assert.deepEqual(parseLynxNumberExpression('2+p'),
    { number: 2, command: 'page', relative: 1 });
  assert.deepEqual(parseLynxNumberExpression('2p-'),
    { number: 2, command: 'page', relative: -1 });
  assert.deepEqual(parseLynxNumberExpression('4-g'),
    { number: 4, command: 'move', relative: -1 });
});

test('two command letters, or any other text, is not an expression', () => {
  assert.equal(parseLynxNumberExpression('3pg'), null);
  assert.equal(parseLynxNumberExpression('p'), null);
  assert.equal(parseLynxNumberExpression(''), null);
  assert.equal(parseLynxNumberExpression('1.5'), null);
});

test('a relative step measures from the item on the reader\'s own line', () => {
  const prompt = {
    cursor: 4,
    targets: [
      { number: 1, line: 0 }, { number: 2, line: 3 }, { number: 3, line: 6 },
    ],
  };
  assert.equal(relativeLinkNumber(prompt, 1, 1), 3);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 2);
});

test('standing on a numbered line measures from that number', () => {
  const prompt = {
    cursor: 3,
    targets: [
      { number: 1, line: 0 }, { number: 2, line: 3 }, { number: 3, line: 6 },
    ],
  };
  assert.equal(relativeLinkNumber(prompt, 1, 1), 3);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 1);
});

test('the column breaks the tie when several numbers share a line', () => {
  const prompt = {
    cursor: 2, col: 10,
    targets: [
      { number: 1, line: 2, col: 4 },
      { number: 2, line: 2, col: 20 },
      { number: 3, line: 2, col: 40 },
    ],
  };
  // The item at column 4 is the nearest one behind the reader, so the step
  // is measured from its number: one forward is 2, one back is 0.
  assert.equal(relativeLinkNumber(prompt, 1, 1), 2);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 0);
});

test('with nothing before the reader the edge answers are Lynx\'s', () => {
  const prompt = { cursor: 0, col: 0, targets: [{ number: 5, line: 3 }] };
  assert.equal(relativeLinkNumber(prompt, 1, 1), 1);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 4);
  const empty = { cursor: 0, targets: [] };
  assert.equal(relativeLinkNumber(empty, 1, 1), 1);
  assert.equal(relativeLinkNumber(empty, 1, -1), -1);
});
