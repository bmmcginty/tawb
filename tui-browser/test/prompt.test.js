'use strict';

// The password prompt, without a browser: what the reader sees on the status
// line, and what each key does to it.

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { KeyReader } = require('../src/input');
const { handleAuthKey, authPromptText, askForPassword } = require('../src/index');
const { normaliseChallenge } = require('../src/auth');

const CHALLENGE = normaliseChallenge({
  source: 'Server', origin: 'http://example.com', realm: 'Staff area', scheme: 'basic',
  url: 'http://example.com/secret',
});

function promptState() {
  return {
    mode: 'auth',
    statusMsg: '',
    drawn: { address: null, hint: null },
    auth: {
      challenge: CHALLENGE,
      refused: false,
      stage: 'user',
      user: { text: '', caret: 0 },
      password: { text: '', caret: 0 },
    },
  };
}

function type(state, text) {
  for (const key of text) {
    const answer = handleAuthKey(key, state);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

test('the username is shown and the password is not', () => {
  const state = promptState();
  type(state, 'reader');
  assert.deepEqual(authPromptText(state), { text: 'user: reader', caretCol: 13 });

  handleAuthKey('\r', state);
  type(state, 'opensesame');
  const shown = authPromptText(state);
  assert.equal(shown.text, 'password: **********');
  assert.ok(!shown.text.includes('opensesame'), 'the password reached the screen');
});

test('Enter moves on to the password and then answers', () => {
  const state = promptState();
  assert.equal(type(state, 'reader'), undefined);
  assert.equal(handleAuthKey('\r', state), undefined);
  assert.equal(state.auth.stage, 'password');
  assert.deepEqual(type(state, 'opensesame\r'), { username: 'reader', password: 'opensesame' });
});

test('the prompt can be escaped, and Enter at an empty username is the same door', () => {
  assert.equal(handleAuthKey('\x1b', promptState()), null);
  assert.equal(handleAuthKey('\r', promptState()), null);
});

test('editing keys work in both fields', () => {
  const state = promptState();
  type(state, 'reax');
  handleAuthKey('\x7f', state); // backspace
  type(state, 'der');
  assert.equal(state.auth.user.text, 'reader');

  handleAuthKey('\r', state);
  type(state, 'wrong');
  handleAuthKey('\x15', state); // kill to line start
  type(state, 'right');
  assert.equal(state.auth.password.text, 'right');
});

test('the prompt answers while the reading loop is stopped, then gives the keyboard back', async () => {
  const stream = new PassThrough();
  const reader = new KeyReader(stream, { escapeMs: 5 });
  const state = {
    ...promptState(), mode: 'browse', auth: null, keyReader: reader, keys: null,
  };
  // The loop is where it always is between keystrokes: waiting for a key.
  const loop = reader.next();

  const asked = askForPassword(state, CHALLENGE);
  stream.write('reader\ropensesame\r');
  assert.deepEqual(await asked, { username: 'reader', password: 'opensesame' });
  assert.equal(state.mode, 'browse', 'the mode the reader was in came back');
  assert.equal(state.auth, null);

  stream.write('j');
  assert.equal(await loop, 'j', 'the reading loop was left where it was');
  reader.close();
});
