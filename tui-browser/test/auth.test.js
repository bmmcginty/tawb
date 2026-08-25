'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  Credentials, normaliseChallenge, challengeKey, describeChallenge, splitCredentials, MAX_ATTEMPTS,
} = require('../src/auth');

const BASIC = {
  source: 'Server', origin: 'http://example.com', realm: 'Staff area', scheme: 'basic',
  url: 'http://example.com/secret',
};

test('a challenge is described by the origin that asked, not the page', () => {
  const challenge = normaliseChallenge({ url: 'http://cdn.example.net/pixel.gif', realm: 'Files', scheme: 'Basic' });
  assert.equal(challenge.origin, 'http://cdn.example.net');
  assert.equal(challenge.scheme, 'basic');
  assert.match(describeChallenge(challenge), /cdn\.example\.net/);
  assert.match(describeChallenge(normaliseChallenge({ ...BASIC, source: 'Proxy' })), /^the proxy at /);
});

test('one site can protect two areas with two passwords', () => {
  assert.notEqual(
    challengeKey(normaliseChallenge(BASIC)),
    challengeKey(normaliseChallenge({ ...BASIC, realm: 'Admin' })),
  );
});

test('a realm is answered once and then remembered', async () => {
  let asked = 0;
  const credentials = new Credentials({
    ask: async () => { asked += 1; return { username: 'reader', password: 'opensesame' }; },
  });

  assert.deepEqual(await credentials.answer(BASIC, 'req-1'), { username: 'reader', password: 'opensesame' });
  // A second image from the same protected directory is a new request, and
  // must not put the prompt up again.
  assert.deepEqual(await credentials.answer(BASIC, 'req-2'), { username: 'reader', password: 'opensesame' });
  assert.equal(asked, 1);
});

test('several challenges at once produce one prompt, not several', async () => {
  let asking = 0;
  let most = 0;
  const credentials = new Credentials({
    ask: async () => {
      asking += 1;
      most = Math.max(most, asking);
      await new Promise((resolve) => setTimeout(resolve, 10));
      asking -= 1;
      return { username: 'reader', password: 'opensesame' };
    },
  });

  const answers = await Promise.all([
    credentials.answer(BASIC, 'a'), credentials.answer(BASIC, 'b'), credentials.answer(BASIC, 'c'),
  ]);
  assert.equal(most, 1);
  for (const answer of answers) assert.equal(answer.username, 'reader');
});

test('a refused password is asked again, and then given up on', async () => {
  const tried = [];
  const credentials = new Credentials({
    ask: async (challenge, { refused, attempt }) => {
      tried.push({ refused, attempt });
      return { username: 'reader', password: 'wrong' };
    },
  });

  // The engine retries the same request id after a password the server did
  // not accept; without a limit here the browser goes round for ever.
  let answer = await credentials.answer(BASIC, 'same');
  let rounds = 0;
  while (answer && rounds < 20) {
    answer = await credentials.answer(BASIC, 'same');
    rounds += 1;
  }
  assert.equal(answer, null, 'the loop was never broken');
  assert.equal(tried.length, MAX_ATTEMPTS);
  assert.deepEqual(tried[0], { refused: false, attempt: 1 });
  assert.equal(tried[1].refused, true);
});

test('a challenge the reader escapes is not put up again until they navigate', async () => {
  let asked = 0;
  const credentials = new Credentials({
    ask: async () => { asked += 1; return null; },
  });

  assert.equal(await credentials.answer(BASIC, 'one'), null);
  assert.equal(await credentials.answer(BASIC, 'two'), null);
  assert.equal(asked, 1, 'a page of protected images asked once per image');

  credentials.reconsider();
  assert.equal(await credentials.answer(BASIC, 'three'), null);
  assert.equal(asked, 2, 'a deliberate navigation is the way back');
});

test('credentials in a url are taken out of it rather than passed on', () => {
  const split = splitCredentials('https://reader:open%20sesame@example.com/staff?q=1');
  assert.equal(split.url, 'https://example.com/staff?q=1');
  assert.equal(split.username, 'reader');
  assert.equal(split.password, 'open sesame');

  const plain = splitCredentials('https://example.com/staff');
  assert.deepEqual(plain, { url: 'https://example.com/staff', username: null, password: null });
  // Not a url at all: the address bar hands over whatever was typed.
  assert.equal(splitCredentials('example.com').url, 'example.com');
});

test('credentials the reader supplied elsewhere answer a waiting challenge', async () => {
  const credentials = new Credentials({ ask: async () => null });
  credentials.remember(BASIC, { username: 'reader', password: 'opensesame' });
  assert.deepEqual(await credentials.answer(BASIC, 'req'), { username: 'reader', password: 'opensesame' });
});

test('a password typed into an address answers whatever realm that origin asks for', async () => {
  let asked = 0;
  const credentials = new Credentials({ ask: async () => { asked += 1; return null; } });
  // A url carries no realm, so the credentials in one belong to the origin.
  credentials.remember({ url: 'http://example.com/staff' }, { username: 'reader', password: 'opensesame' });
  assert.deepEqual(await credentials.answer(BASIC, 'req'), { username: 'reader', password: 'opensesame' });
  assert.deepEqual(
    await credentials.answer({ ...BASIC, realm: 'Another area' }, 'other'),
    { username: 'reader', password: 'opensesame' },
  );
  assert.equal(asked, 0);
  // And they are dropped when the server refuses them, rather than being
  // handed back for every realm on the site for ever.
  assert.equal(await credentials.answer(BASIC, 'req'), null);
});
