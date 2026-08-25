'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { KeyReader, EOF } = require('../src/input');

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
  assert.equal(stream.isPaused(), true, 'closing releases the input stream');
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

test('a claim takes the keyboard from the reading loop and gives it back', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });

  // The loop is waiting for a key, as it always is between keystrokes.
  let loopSaw = null;
  const loop = reader.next().then((key) => { loopSaw = key; });

  stream.write('j');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loopSaw, 'j');

  const waiting = reader.next();
  const token = reader.claim();
  stream.write('bob\r');
  const typed = [];
  for (let i = 0; i < 4; i += 1) typed.push(await reader.next(token));
  assert.deepEqual(typed, ['b', 'o', 'b', '\r']);

  reader.release(token);
  stream.write('k');
  assert.equal(await waiting, 'k', 'the loop resumes with the next key after the prompt');
  await loop;
  reader.close();
});

test('a claim drops what was typed before the prompt appeared', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  stream.write('gg');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const token = reader.claim();
  stream.write('x');
  assert.equal(await reader.next(token), 'x');
  reader.close();
});

test('the end of the stream answers everyone still waiting for a key', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });

  // A prompt holds the keyboard; the reading loop is parked behind it. Both
  // are waiting on a keyboard that is about to stop existing.
  const loop = reader.next();
  const token = reader.claim();
  const prompt = reader.next(token);

  // A last real keystroke, then the stream ends under both of them.
  stream.write('\x1b');
  stream.end();

  assert.equal(await prompt, '\x1b', 'the Escape held back for the Alt test was still delivered');
  assert.equal(await reader.next(token), EOF, 'and then the keyboard is gone');
  assert.equal(await loop, EOF, 'including for the loop parked behind the claim');
  assert.equal(await reader.next(), EOF, 'asking again says the same thing rather than hanging');
  reader.close();
});

test('a reader that has been closed answers rather than hanging', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  reader.close();
  assert.equal(await reader.next(), EOF);
});
