'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { editAction, applyBufferEdit } = require('../src/edit');

const keys = new Keymap({ terminfo: {}, load: false });

function press(buffer, sequence) {
  const action = editAction(sequence, keys);
  assert.ok(action, `no editing action for ${JSON.stringify(sequence)}`);
  assert.equal(applyBufferEdit(buffer, action), true);
}

test('readline character and line movement edits an internal prompt', () => {
  const buffer = { text: 'alpha beta', caret: 10 };
  press(buffer, '\x01'); // Ctrl+A
  assert.equal(buffer.caret, 0);
  press(buffer, '\x06'); // Ctrl+F
  assert.equal(buffer.caret, 1);
  press(buffer, '\x05'); // Ctrl+E
  assert.equal(buffer.caret, 10);
  press(buffer, '\x02'); // Ctrl+B
  assert.equal(buffer.caret, 9);
});

test('readline word movement and deletion edits an internal prompt', () => {
  const buffer = { text: 'alpha beta gamma', caret: 16 };
  press(buffer, '\x1bb'); // Alt+B
  assert.equal(buffer.caret, 11);
  press(buffer, '\x17'); // Ctrl+W
  assert.deepEqual(buffer, { text: 'alpha gamma', caret: 6 });
  press(buffer, '\x1bd'); // Alt+D
  assert.deepEqual(buffer, { text: 'alpha ', caret: 6 });
});

test('readline kill and delete keys edit an internal prompt', () => {
  const buffer = { text: 'alpha beta', caret: 5 };
  press(buffer, '\x0b'); // Ctrl+K
  assert.deepEqual(buffer, { text: 'alpha', caret: 5 });
  press(buffer, '\x15'); // Ctrl+U
  assert.deepEqual(buffer, { text: '', caret: 0 });

  buffer.text = 'xy';
  buffer.caret = 0;
  press(buffer, '\x04'); // Ctrl+D
  assert.deepEqual(buffer, { text: 'y', caret: 0 });
  press(buffer, '\x7f'); // Backspace at the beginning is harmless
  assert.deepEqual(buffer, { text: 'y', caret: 0 });
});
