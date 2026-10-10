'use strict';

// The password prompt, without a browser: what the reader sees on the status
// line, and what each key does to it. Differenced between the JavaScript
// original and the Crystal port.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/secret';
const CHALLENGE = {
  source: 'Server', origin: 'http://example.com', realm: 'Staff area', scheme: 'basic',
};

function promptState(overrides = {}) {
  return {
    rows: 24, cols: 80, mode: 'auth',
    cursor: 0, col: 0, scroll: 0,
    lines: [{ text: 'page', blockIndex: 0 }],
    core: { source: 'ax', blocks: [] },
    statusMsg: '', drawn: {}, linkAddress: true,
    auth: {
      challenge: CHALLENGE, refused: false, stage: 'user',
      user: { text: '', caret: 0 }, password: { text: '', caret: 0 },
    },
    ...overrides,
  };
}

// Both runtimes answer through the same scenario; async ops (the prompt
// loop) are awaited on the JavaScript side and run synchronously on the
// Crystal one.
async function runBoth(name, state, actions) {
  const spec = { state: JSON.parse(JSON.stringify(state)), actions, page: { url: PAGE_URL } };
  const results = [];
  for (const implementation of implementations) {
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

test('the username is shown and the password is not', { skip: needsCrystal }, async () => {
  const result = await runBoth('type the name', promptState(), [
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'a' },
    { op: 'authKey', chunk: 'd' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'r' },
    { op: 'authPromptText' },
  ]);
  assert.deepEqual(result.results[6].value, { text: 'user: reader', caretCol: 13 });

  const password = await runBoth('type the password', promptState({
    auth: {
      challenge: CHALLENGE, refused: false, stage: 'password',
      user: { text: 'reader', caret: 6 }, password: { text: '', caret: 0 },
    },
  }), [
    { op: 'authKey', chunk: 'o' },
    { op: 'authKey', chunk: 'p' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'n' },
    { op: 'authPromptText' },
  ]);
  assert.deepEqual(password.results[4].value, { text: 'password: ****', caretCol: 15 });
});

test('Enter moves on to the password and then answers', { skip: needsCrystal }, async () => {
  const state = promptState();
  const result = await runBoth('enter twice', state, [
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'a' },
    { op: 'authKey', chunk: 'd' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: '\r' },
    { op: 'authKey', chunk: 'h' },
    { op: 'authKey', chunk: 'i' },
    { op: 'authKey', chunk: '\r' },
  ]);
  const answers = result.results.map((entry) => entry.value);
  assert.deepEqual(answers.slice(0, 7), Array(7).fill('continue'));
  assert.deepEqual(answers[9], { username: 'reader', password: 'hi' });
});

test('the prompt can be escaped, and Enter at an empty username is the same door', { skip: needsCrystal }, async () => {
  const escape = await runBoth('escape', promptState(), [
    { op: 'authKey', chunk: '\x1b' },
  ]);
  assert.equal(escape.results[0].value, null);

  const empty = await runBoth('empty enter', promptState(), [
    { op: 'authKey', chunk: '\r' },
  ]);
  assert.equal(empty.results[0].value, null);
});

test('editing keys work in both fields', { skip: needsCrystal }, async () => {
  const result = await runBoth('edit the username', promptState(), [
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'a' },
    { op: 'authKey', chunk: 'x' },
    { op: 'authKey', chunk: '\x7f' },
    { op: 'authKey', chunk: 'd' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: 'r' },
    { op: 'authPromptText' },
  ]);
  assert.deepEqual(result.results[8].value, { text: 'user: reader', caretCol: 13 });

  const kill = await runBoth('kill to line start', promptState({
    auth: {
      challenge: CHALLENGE, refused: false, stage: 'password',
      user: { text: 'reader', caret: 6 }, password: { text: 'wrong', caret: 5 },
    },
  }), [
    { op: 'authKey', chunk: '\x15' },
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: 'i' },
    { op: 'authKey', chunk: 'g' },
    { op: 'authKey', chunk: 'h' },
    { op: 'authKey', chunk: 't' },
    { op: 'authPromptText' },
  ]);
  assert.deepEqual(kill.results[6].value, { text: 'password: *****', caretCol: 16 });
});

test('Ctrl+L empties the field being typed into', { skip: needsCrystal }, async () => {
  const result = await runBoth('ctrl+l', promptState(), [
    { op: 'authKey', chunk: 'r' },
    { op: 'authKey', chunk: 'e' },
    { op: 'authKey', chunk: '\x0c' },
    { op: 'authPromptText' },
  ]);
  assert.deepEqual(result.results[3].value, { text: 'user: ', caretCol: 7 });
});

test('the prompt loop answers, restores the mode, and hands the keyboard back', { skip: needsCrystal }, async () => {
  const state = promptState({ mode: 'browse', statusMsg: 'Reading.', auth: null });
  const result = await runBoth('the whole prompt', state, [
    { op: 'askPassword', challenge: CHALLENGE, keys: ['r', 'e', 'a', 'd', '\r', 's', '\r'] },
  ]);
  assert.deepEqual(result.results[0].value, { username: 'read', password: 's' });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.auth, null);
  assert.equal(result.state.statusMsg, 'Reading.', 'the old status message is kept on the state');
  // The row itself says the sign-in is happening, over the prompt's last words.
  const writes = result.results.flatMap((entry) => entry.writes);
  const lastText = writes[writes.length - 1].replace('\x1b[2K', '');
  assert.match(lastText, /^Signing in to http:\/\/example\.com — "Staff area" \(basic\)…$/);
});

test('a refused challenge says so on the hint row', { skip: needsCrystal }, async () => {
  const state = promptState({ mode: 'browse', statusMsg: '', auth: null });
  const result = await runBoth('refused', state, [
    { op: 'askPassword', challenge: CHALLENGE, refused: true, keys: ['\x1b'] },
  ]);
  assert.equal(result.results[0].value, null);
  const writes = result.results.flatMap((entry) => entry.writes);
  assert.ok(writes.some((write) => write.includes('Password refused. ')),
    'the hint did not say the password was refused');
});

test('the end of the keyboard declines the challenge', { skip: needsCrystal }, async () => {
  const state = promptState({ mode: 'browse', statusMsg: '', auth: null });
  const result = await runBoth('eof', state, [
    { op: 'askPassword', challenge: CHALLENGE, keys: ['r', 'e', '<eof>'] },
  ]);
  assert.equal(result.results[0].value, null);
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.auth, null);
  assert.ok(result.state.inputMarks >= 2, 'typing marked input');
});
