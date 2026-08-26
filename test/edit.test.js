'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { editAction, applyBufferEdit } = require('../src/edit');
const { patchEditedLine } = require('../src/index');

const keys = new Keymap({ terminfo: {}, load: false });

test('every editing operation is exposed as a configurable keymap action', () => {
  const configurable = new Keymap({ terminfo: {}, load: false });
  const ids = configurable.actions.map((action) => action.id);
  for (const id of [
    'line-start', 'line-end', 'previous-character', 'next-character',
    'edit-line-start', 'edit-line-end', 'edit-previous-character', 'edit-next-character',
    'edit-backspace', 'edit-delete', 'edit-previous-word', 'edit-next-word',
    'edit-backspace-word', 'edit-delete-word', 'edit-kill-start', 'edit-kill-end',
  ]) assert.ok(ids.includes(id), `${id} is absent from the keyboard wizard`);

  configurable.assign('edit-next-word', 'x');
  assert.equal(editAction('x', configurable), 'word-forward');
  assert.equal(editAction('\x1bf', configurable), null, 'the replaced default no longer edits');
});

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

test('an edited field inserts and deletes without repainting its row', () => {
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    patchEditedLine(7, '[Search: a]', '[Search: ab]');
    patchEditedLine(7, '[Search: ab]', '[Search: a]');
  } finally {
    process.stdout.write = real;
  }

  const output = written.join('');
  assert.doesNotMatch(output, /\x1b\[2K/, 'editing erased the complete field row');
  assert.doesNotMatch(output, /Search/, 'editing rewrote the field label');
  assert.match(output, /\x1b\[1@b/, 'the typed character was not inserted alone');
  assert.match(output, /\x1b\[1P/, 'backspace did not delete one terminal cell');
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
