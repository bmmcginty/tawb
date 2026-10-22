'use strict';

// The input reader, differenced between the JavaScript original and the
// Crystal port: the same chunks written at the same moments, the same waits
// between them, and the same keys must come out — combined keys separated,
// split sequences joined, Escape told from Alt, claims honoured, and the end
// of the stream delivered as a keystroke of its own.
//
// Each check runs one scenario script. The script steps are the things a
// reader's callers do: write, wait, claim, park a wait for later, and ask
// for the next key. An observation is a key, or null when the stream ended.

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { KeyReader, EOF } = require('../src/input');
const { inputImplementations } = require('./crystal_impl');

for (const implementation of inputImplementations({ KeyReader, EOF })) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('the input reader separates combined keys and joins split sequences', async () => {
    const observations = await implementation.scenario({
      escape_ms: 80,
      script: [
        { op: 'write', chunk: 'ab\x1b[' },
        { op: 'next' },
        { op: 'next' },
        { op: 'write', chunk: '6~z\x1b[6^' },
        { op: 'next' },
        { op: 'next' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['a', 'b', '\x1b[6~', 'z', '\x1b[6^'],
      'older CSI final bytes are complete keys too');
  });

  check('an Alt key split by network scheduling stays one key', async () => {
    const observations = await implementation.scenario({
      escape_ms: 80,
      script: [
        { op: 'write', chunk: '\x1b' },
        { op: 'wait', ms: 45 },
        { op: 'write', chunk: 'k' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1bk']);
  });

  check('an Alt-prefixed function key stays one key', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: '\x1b\x1b[24~' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b\x1b[24~'],
      'Alt+F12 is not Alt+Escape followed by the characters of the F12 sequence');
  });

  check('an Alt prefix split from its function key still joins', async () => {
    const observations = await implementation.scenario({
      escape_ms: 80,
      script: [
        { op: 'write', chunk: '\x1b\x1b' },
        { op: 'wait', ms: 10 },
        { op: 'write', chunk: '[24~' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b\x1b[24~']);
  });

  check('a double Escape with nothing after it is still Alt+Escape', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: '\x1b\x1b' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b\x1b']);
  });

  check('escape strings and their payloads stay one key', async () => {
    const cases = [
      '\x1b]0;title\x07',
      '\x1bP1;2|payload\x1b\\',
      '\x1bXpayload\x1b\\',
      '\x1b^payload\x1b\\',
      '\x1b_payload\x1b\\',
      '\x1b\x1b]0;title\x07',
    ];
    for (const chunk of cases) {
      const observations = await implementation.scenario({
        escape_ms: 5,
        script: [
          { op: 'write', chunk },
          { op: 'next' },
          { op: 'close' },
        ],
      });
      assert.deepEqual(observations, [chunk], JSON.stringify(chunk));
    }
  });

  check('an X10 mouse report keeps its payload', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: '\x1b[Mabc' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b[Mabc']);
  });

  check('an unfinished introducer is still a key of its own', async () => {
    for (const chunk of ['\x1b[', '\x1bO', '\x1b]']) {
      const observations = await implementation.scenario({
        escape_ms: 5,
        script: [
          { op: 'write', chunk },
          { op: 'next' },
          { op: 'close' },
        ],
      });
      assert.deepEqual(observations, [chunk], JSON.stringify(chunk));
    }
  });

  check('Alt with a non-ASCII character is one key', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: '\x1bé' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1bé']);
  });

  check('the input reader distinguishes Escape from Alt keys', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: '\x1b' },
        { op: 'next' },
        { op: 'write', chunk: '\x1ba' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b', '\x1ba']);
  });

  check('a claim takes the keyboard from the reading loop and gives it back', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'park', id: 'loop' },
        { op: 'write', chunk: 'j' },
        { op: 'await', id: 'loop' },
        { op: 'park', id: 'waiting' },
        { op: 'claim', owner: 'prompt' },
        { op: 'write', chunk: 'bob\r' },
        { op: 'next', owner: 'prompt' },
        { op: 'next', owner: 'prompt' },
        { op: 'next', owner: 'prompt' },
        { op: 'next', owner: 'prompt' },
        { op: 'release', owner: 'prompt' },
        { op: 'write', chunk: 'k' },
        { op: 'await', id: 'waiting' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['j', 'b', 'o', 'b', '\r', 'k'],
      'the loop resumes with the next key after the prompt');
  });

  check('a claim drops what was typed before the prompt appeared', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'write', chunk: 'gg' },
        { op: 'claim', owner: 'prompt' },
        { op: 'write', chunk: 'x' },
        { op: 'next', owner: 'prompt' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['x']);
  });

  check('the end of the stream answers everyone still waiting for a key', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'park', id: 'loop' },
        { op: 'claim', owner: 'prompt' },
        { op: 'park', id: 'prompt', owner: 'prompt' },
        { op: 'write', chunk: '\x1b' },
        { op: 'end' },
        { op: 'await', id: 'prompt' },
        { op: 'next', owner: 'prompt' },
        { op: 'await', id: 'loop' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, ['\x1b', null, null, null],
      'the Escape held back for the Alt test was still delivered, then the keyboard is gone for everyone');
  });

  check('an operation winning a key race does not steal the next key', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'next_or', id: 'race', resolve: 'loaded' },
        { op: 'await', id: 'race' },
        { op: 'write', chunk: 'j' },
        { op: 'next' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, [{ value: 'loaded' }, 'j']);
  });

  check('a key can interrupt an operation', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'next_or', id: 'race' },
        { op: 'write', chunk: 'x' },
        { op: 'await', id: 'race' },
        { op: 'close' },
      ],
    });
    assert.deepEqual(observations, [{ key: 'x' }]);
  });

  check('a reader that has been closed answers rather than hanging', async () => {
    const observations = await implementation.scenario({
      escape_ms: 5,
      script: [
        { op: 'close' },
        { op: 'next' },
      ],
    });
    assert.deepEqual(observations, [null]);
  });
}

// Pausing the stream is Node's own bookkeeping: the standalone keyboard
// wizard removes its listener when it leaves, and a still-flowing stdin
// would keep the event loop alive with nothing left that can consume input.
// The Crystal reader has no event loop to keep alive, so there is nothing
// to difference here.
test('closing releases the input stream', () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  reader.close();
  assert.equal(stream.isPaused(), true, 'closing releases the input stream');
});
