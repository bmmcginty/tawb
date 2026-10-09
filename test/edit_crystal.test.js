'use strict';

// The field-editing buffer, differenced between the JavaScript original and
// the Crystal port: the same keymap answers, the same buffer edits, the same
// key sequences sent into a real field. A caret that moves differently on
// one runtime would type differently on both.

const test = require('node:test');
const assert = require('node:assert');

const editModule = require('../src/edit');
const keysModule = require('../src/keys');
const { editImplementations } = require('./crystal_impl');

const ORDINARY = { profile: 'default', terminfo: {}, load: false };

// A few of the keys each operation is bound to by default; the full tables
// are the keymap suite's business, not this one's.
const KEYSTROKES = [
  ['\x01', 'edit-line-start', 'line-start'],
  ['\x05', 'edit-line-end', 'line-end'],
  ['\x02', 'edit-previous-character', 'character-backward'],
  ['\x06', 'edit-next-character', 'character-forward'],
  ['\x7f', 'edit-backspace', 'backspace'],
  ['\x04', 'edit-delete', 'delete-forward'],
  ['\x1bb', 'edit-previous-word', 'word-backward'],
  ['\x1bf', 'edit-next-word', 'word-forward'],
  ['\x17', 'edit-backspace-word', 'delete-word-backward'],
  ['\x1bd', 'edit-delete-word', 'delete-word-forward'],
  ['\x15', 'edit-kill-start', 'delete-line-backward'],
  ['\x0b', 'edit-kill-end', 'delete-line-forward'],
];

const EDITS = [
  'line-start', 'line-end', 'character-backward', 'character-forward',
  'backspace', 'delete-forward', 'word-backward', 'word-forward',
  'delete-word-backward', 'delete-word-forward',
  'delete-line-backward', 'delete-line-forward',
];

for (const implementation of editImplementations(editModule, keysModule)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('every editing operation is exposed through the keymap', async () => {
    for (const [stroke, action, operation] of KEYSTROKES) {
      assert.equal(await implementation.actionFor(ORDINARY, stroke), operation, stroke);
      assert.ok(EDITS.includes(operation), operation);
    }
    // A key the editing keyboard does not claim is no editing action at all.
    assert.equal(await implementation.actionFor(ORDINARY, 'g'), null);
    // A reassigned key gives up its editing meaning.
    const reassigned = {
      ...ORDINARY,
      bindings: { 'edit-next-word': ['x'] },
    };
    assert.equal(await implementation.actionFor(reassigned, '\x1bf'), null);
    assert.equal(await implementation.actionFor(reassigned, 'x'), 'word-forward');
  });

  check('readline character and line movement edits an internal prompt', async () => {
    let buffer = { text: 'alpha beta', caret: 10 };
    buffer = await implementation.apply(buffer, 'line-start');
    assert.deepEqual(buffer, { ok: true, text: 'alpha beta', caret: 0 });
    buffer = await implementation.apply(buffer, 'character-forward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha beta', caret: 1 });
    buffer = await implementation.apply(buffer, 'line-end');
    assert.deepEqual(buffer, { ok: true, text: 'alpha beta', caret: 10 });
    buffer = await implementation.apply(buffer, 'character-backward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha beta', caret: 9 });
  });

  check('readline word movement and deletion edits an internal prompt', async () => {
    let buffer = { text: 'alpha beta gamma', caret: 16 };
    buffer = await implementation.apply(buffer, 'word-backward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha beta gamma', caret: 11 });
    buffer = await implementation.apply(buffer, 'delete-word-backward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha gamma', caret: 6 });
    buffer = await implementation.apply(buffer, 'delete-word-forward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha ', caret: 6 });
  });

  check('readline kill and delete keys edit an internal prompt', async () => {
    let buffer = { text: 'alpha beta', caret: 5 };
    buffer = await implementation.apply(buffer, 'delete-line-forward');
    assert.deepEqual(buffer, { ok: true, text: 'alpha', caret: 5 });
    buffer = await implementation.apply(buffer, 'delete-line-backward');
    assert.deepEqual(buffer, { ok: true, text: '', caret: 0 });

    buffer = { text: 'xy', caret: 0 };
    buffer = await implementation.apply(buffer, 'delete-forward');
    assert.deepEqual(buffer, { ok: true, text: 'y', caret: 0 });
    buffer = await implementation.apply(buffer, 'backspace');
    assert.deepEqual(buffer, { ok: true, text: 'y', caret: 0 },
      'backspace at the beginning is harmless');
  });

  check('an unknown operation is refused and a clamped caret stays inside', async () => {
    assert.deepEqual(await implementation.apply({ text: 'ab', caret: 2 }, 'no-such-edit'),
      { ok: false, text: 'ab', caret: 2 });
    assert.deepEqual(await implementation.apply({ text: 'ab', caret: 99 }, 'character-forward'),
      { ok: true, text: 'ab', caret: 2 });
    assert.deepEqual(await implementation.apply({ text: 'ab', caret: -3 }, 'backspace'),
      { ok: true, text: 'ab', caret: 0 }, 'backspace below the start is harmless too');
  });

  check('word movement crosses whitespace and stops at it', async () => {
    assert.equal(implementation.wordStart('alpha beta gamma', 16), 11);
    assert.equal(implementation.wordStart('alpha   beta', 12), 8);
    assert.equal(implementation.wordStart('alpha', 5), 0);
    assert.equal(implementation.wordEnd('alpha beta gamma', 0), 5);
    assert.equal(implementation.wordEnd('alpha   beta', 5), 12);
    assert.equal(implementation.wordEnd('alpha', 0), 5);
  });

  check('word movement counts a character beyond the basic plane as two', async () => {
    // 'a \u{1F600} b': the emoji is two UTF-16 units, so caret arithmetic
    // lands on unit boundaries the terminal counts, not on character ones.
    const text = 'a \u{1F600} b';
    assert.equal(implementation.wordStart(text, text.length), 5);
    assert.equal(implementation.wordEnd(text, 0), 1);
    // Deleting backwards from just after the emoji takes the whole surrogate
    // pair as one word and parks the caret where it began.
    assert.deepEqual(await implementation.apply({ text, caret: 5 }, 'delete-word-backward'),
      { ok: true, text: 'a b', caret: 2 });
  });

  check('an edit is sent into a real field as the keys a browser knows', async () => {
    assert.deepEqual(await implementation.keysFor('line-start'), ['Home']);
    assert.deepEqual(await implementation.keysFor('delete-line-backward'), ['Shift+Home', 'Backspace']);
    assert.deepEqual(await implementation.keysFor('word-backward'), ['Control+ArrowLeft']);
    assert.equal(await implementation.keysFor('no-such-edit'), null);
  });
}
