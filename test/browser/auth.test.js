'use strict';

// Signing in, against a real browser and a server that really asks.
//
//     npm run test:browser
//     TWEB_TEST_BROWSER=firefox npm run test:browser
//     xvfb-run -a npm run test:browser     # with no display of your own
//
// The point of doing this against a browser rather than a stub is that the
// scheme is the browser's work: we hand over a username and a password and
// the engine builds the Authorization header. Digest is the case that proves
// it — the response it computes is a nonce, a client nonce, a request counter
// and two rounds of hashing, and tools/authserve.js verifies it properly, so
// a wrong one is refused here exactly as a real server refuses it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { PassThrough } = require('node:stream');

const { tempDir, removeTempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const { killProcessGroup } = require('../../src/proc');
const { Credentials } = require('../../src/auth');
const { KeyReader } = require('../../src/input');
const { askForPassword } = require('../../src/index');
const { start } = require('../../tools/authserve');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-auth-');

let shared = null;
async function browser() {
  if (shared) return shared;
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  const asked = [];
  let answer = () => ({ username: 'reader', password: 'opensesame' });
  const credentials = new Credentials({
    ask: async (challenge) => { asked.push(challenge); return answer(challenge); },
  });
  await driver.attachAuth((challenge, id) => credentials.answer(challenge, id));
  await driver.armAuth(page);
  shared = {
    driver, page, asked, credentials, answerWith: (fn) => { answer = fn; },
  };
  return shared;
}

test.after(async () => {
  if (shared) await shared.driver.close().catch(() => {});
  removeTempDir(profile);
});

// Each case gets its own server, because a browser caches credentials by
// origin and realm: reusing one port would make the second case a test of
// that cache rather than of a challenge.
async function visit(target, { answering = null } = {}) {
  const { page, asked, credentials, answerWith } = await browser();
  const site = await start();
  asked.length = 0;
  credentials.reconsider();
  if (answering) answerWith(answering);
  else answerWith(() => ({ username: 'reader', password: 'opensesame' }));
  try {
    await page.goto('about:blank');
    await page.goto(site.url + target, { waitUntil: 'load', timeout: 20000 }).catch(() => {});
    const text = await page.evaluate(
      () => (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : ''),
    ).catch(() => '');
    const image = await page.evaluate(
      () => (document.images[0] ? document.images[0].naturalWidth : null),
    ).catch(() => null);
    return { text, image, asked: asked.slice(), origin: new URL(site.url).origin };
  } finally {
    site.server.close();
  }
}

test('a basic challenge is answered by the reader and the page loads', async () => {
  const visited = await visit('basic');
  assert.match(visited.text, /Signed in as reader/);
  assert.equal(visited.asked.length, 1);
  assert.equal(visited.asked[0].realm, 'Staff area');
  assert.equal(visited.asked[0].scheme, 'basic');
  assert.equal(visited.asked[0].origin, visited.origin);
});

test('digest is the engine\'s work, not ours', async () => {
  const visited = await visit('digest');
  assert.match(visited.text, /Signed in as reader/);
  assert.equal(visited.asked[0].scheme, 'digest');
});

test('a challenge the reader escapes leaves the server\'s own page', async () => {
  const visited = await visit('basic', { answering: () => null });
  assert.match(visited.text, /This is the body the server sends with its challenge/);
});

test('a password the server refuses is asked again, and then given up on', async () => {
  // Nothing stops the browser retrying on its own: Chromium goes round about
  // thirty times, Firefox for ever. This finishing at all is the test.
  const visited = await visit('basic', { answering: () => ({ username: 'reader', password: 'wrong' }) });
  assert.ok(visited.asked.length > 1, 'the reader was not given another go');
  assert.ok(visited.asked.length <= 3, `asked ${visited.asked.length} times`);
  assert.ok(visited.asked.some((challenge) => challenge.realm === 'Staff area'));
});

test('a challenge from an image names the image\'s origin, not the page', async () => {
  const visited = await visit('page-with-image');
  assert.match(visited.text, /Public page/);
  assert.equal(visited.image, 1, 'the protected image did not load');
  assert.equal(visited.asked.length, 1);
  assert.match(visited.asked[0].url, /pixel\.gif$/);
});

test('the reader types the password into the prompt and the page arrives', async () => {
  // The whole path, as it runs: a challenge raised inside a navigation the
  // reading loop is awaiting, a prompt that takes the keyboard while that
  // loop is stopped, and keystrokes arriving as a terminal delivers them.
  const { driver } = await browser();
  const page = await driver.context.newPage();
  await driver.armAuth(page);

  const keys = new PassThrough();
  const reader = new KeyReader(keys, { escapeMs: 5 });
  const state = {
    mode: 'browse', statusMsg: '', drawn: { address: null, hint: null }, auth: null, keyReader: reader,
  };
  const credentials = new Credentials({
    ask: (challenge, info) => askForPassword(state, challenge, info),
  });
  const answering = driver.attachAuth((challenge, id) => credentials.answer(challenge, id));

  const site = await start();
  // The prompt draws on the terminal; this test is not about what it drew.
  const wrote = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await answering;
    // Typed after the prompt is up, as a person would: the reading loop is
    // inside page.goto until the challenge is answered.
    const typing = new Promise((resolve) => setTimeout(resolve, 250))
      .then(() => keys.write('reader\ropensesame\r'));
    await page.goto(`${site.url}basic`, { waitUntil: 'load', timeout: 20000 });
    await typing;
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    assert.match(text, /Signed in as reader/);
    assert.equal(state.mode, 'browse', 'the reader was left in the mode they were in');
  } finally {
    process.stdout.write = wrote;
    reader.close();
    site.server.close();
    await page.close().catch(() => {});
    // The shared handler is this file's; put the plain one back for any test
    // that runs after this one.
    await driver.attachAuth((challenge, id) => shared.credentials.answer(challenge, id)).catch(() => {});
  }
});

// Waits for the tab to have finished with something on it. Bounded at both
// ends: a tab whose document request is still paused has no document to ask,
// and the ask itself waits for one — for ever, which is the very thing being
// tested here.
async function textOf(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await Promise.race([
      page.evaluate(
        () => (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : ''),
      ).catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), 1000)),
    ]);
    if (text || Date.now() > deadline) return text;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('a challenge nobody has answered is cancelled when the browser is let go', async () => {
  // The case only exists for a browser that outlives the reader. One we
  // started and shut down takes its paused request with it; one the reader
  // goes on using would hold that tab mid-request for ever, waiting on a
  // dialog that became ours the moment we armed the interception — and we
  // are gone, so nobody will ever answer it.
  const dir = tempDir('tweb-auth-left-');
  const site = await start();
  const leaving = await openDriver({ engine: ENGINE, profile: dir, keepBrowser: true, log: () => {} });
  try {
    let raised;
    const asked = new Promise((resolve) => { raised = resolve; });
    // A prompt that is never answered: the reader is at it when the terminal
    // goes, or a signal takes the session away while it is on screen.
    await leaving.attachAuth((challenge) => { raised(challenge); return new Promise(() => {}); });
    const page = leaving.context.pages()[0] || await leaving.context.newPage();
    await leaving.armAuth(page);
    const navigating = page.goto(`${site.url}basic`, { waitUntil: 'load', timeout: 20000 })
      .catch(() => {});
    await asked;
    await leaving.close();
    await navigating;

    const rejoined = await openDriver({ engine: ENGINE, profile: dir, log: () => {} });
    try {
      const tabs = rejoined.listTabs();
      const tab = tabs.find((open) => String(open.url()).startsWith(site.url)) || tabs[0];
      assert.match(await textOf(tab), /This is the body the server sends with its challenge/,
        'the tab was left holding a request nobody can answer');
    } finally {
      await rejoined.close().catch(() => {});
    }
  } finally {
    // The whole group: with no display the process we spawned is xvfb-run,
    // and signalling it leaves the browser it is holding running.
    killProcessGroup(leaving.child.pid);
    site.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
