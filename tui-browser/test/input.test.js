'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { KeyReader } = require('../src/input');

test('the input reader separates combined keys and joins split sequences', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  stream.write('ab\x1b[');
  assert.equal(await reader.next(), 'a');
  assert.equal(await reader.next(), 'b');
  stream.write('6~z\x1b[6^');
  assert.equal(await reader.next(), '\x1b[6~');
  assert.equal(await reader.next(), 'z');
  assert.equal(await reader.next(), '\x1b[6^', 'older CSI final bytes are complete keys too');
  reader.close();
});

test('the input reader distinguishes Escape from Alt keys', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  stream.write('\x1b');
  assert.equal(await reader.next(), '\x1b');
  stream.write('\x1ba');
  assert.equal(await reader.next(), '\x1ba');
  reader.close();
});
