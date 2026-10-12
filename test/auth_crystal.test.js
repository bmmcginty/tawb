'use strict';

const test = require('node:test');
const assert = require('node:assert');
const auth = require('../src/auth');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

async function javascriptScenario(spec) {
  const answers = [...(spec.answers || [])];
  const asks = [];
  const logs = [];
  const credentials = new auth.Credentials({
    ask: async (challenge, { refused, attempt }) => {
      asks.push({ challenge, refused, attempt });
      return answers.length ? answers.shift() : null;
    },
    log: (event, fields) => logs.push({ event, fields }),
  });
  const observations = [];
  for (const step of spec.script) {
    if (step.op === 'remember') observations.push(
      credentials.remember(step.challenge, step.credentials));
    else if (step.op === 'forget') {
      credentials.forget(step.challenge); observations.push(null);
    } else if (step.op === 'reconsider') {
      credentials.reconsider(); observations.push(null);
    } else if (step.op === 'answer') observations.push(
      await credentials.answer(step.challenge, step.id ?? null));
  }
  return { observations, asks, logs };
}

const challenge = {
  source: 'server', url: 'https://secure.test/private', realm: 'members', scheme: 'Basic',
};

test('native authentication normalises and keys browser challenges', { skip }, () => {
  const normal = call('auth.normalise', { challenge });
  assert.deepEqual(normal, {
    source: 'server', origin: 'https://secure.test', realm: 'members',
    scheme: 'basic', url: 'https://secure.test/private',
  });
  assert.equal(call('auth.challenge_key', { challenge }),
    auth.challengeKey(auth.normaliseChallenge(challenge)));
  assert.equal(call('auth.origin_key', { challenge }),
    auth.originKey(auth.normaliseChallenge(challenge)));
});

test('native credentials cache answers and reprompt bounded retries', { skip }, async () => {
  const spec = {
    answers: [
      { username: 'first', password: 'wrong' },
      { username: 'second', password: 'right' },
      { username: 'third', password: 'still-wrong' },
    ],
    script: [
      { op: 'answer', challenge, id: 'request-1', now: 100 },
      { op: 'answer', challenge, id: 'request-2', now: 100 },
      { op: 'answer', challenge, id: 'request-1', now: 101 },
      { op: 'answer', challenge, id: 'request-1', now: 102 },
      { op: 'answer', challenge, id: 'request-1', now: 103 },
    ],
  };
  const expected = await javascriptScenario(spec);
  const actual = call('auth.scenario', spec);
  assert.deepEqual(actual, expected);
  assert.equal(actual.asks.length, 3);
  assert.equal(actual.logs.at(-1).event, 'auth.giveup');
});

test('declining stays quiet until deliberate navigation reconsiders', { skip }, async () => {
  const spec = {
    answers: [null, { username: 'reader', password: 'secret' }],
    script: [
      { op: 'answer', challenge, id: 'first', now: 100 },
      { op: 'answer', challenge, id: 'second', now: 100 },
      { op: 'reconsider' },
      { op: 'answer', challenge, id: 'third', now: 100 },
    ],
  };
  assert.deepEqual(call('auth.scenario', spec), await javascriptScenario(spec));
});

test('credentials from a URL cover the first realm at that origin', { skip }, async () => {
  const originChallenge = { source: 'server', url: 'https://secure.test/', realm: '', scheme: '' };
  const spec = {
    answers: [],
    script: [
      { op: 'remember', challenge: originChallenge,
        credentials: { username: 'url-user', password: 'url-pass' } },
      { op: 'answer', challenge, id: 'request', now: 100 },
    ],
  };
  assert.deepEqual(call('auth.scenario', spec), await javascriptScenario(spec));
});
