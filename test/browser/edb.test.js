'use strict';

// The edbrowse server against a real browser and a real page.
//
// Everything here needs a browser, which is why it is not in the fast suite:
//
//     npm run test:browser
//     xvfb-run -a npm run test:browser     # with no display of your own
//
// tools/testpage.html is the page under test, because it was built to carry
// exactly the things that are hard — a select whose options collide by
// prefix, a widget with no key handler, a menu rendered at the end of the
// document.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const { startEdbServer } = require('../../src/edb_server');
const { start: startTestPage } = require('../../tools/serve');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';

// A profile of this file's own, for two reasons. A browser is one instance
// per profile directory, so test files that share one rejoin the same browser
// and navigate each other's tab out from under themselves. And the default
// profile is the reader's own: running this suite while tweb was open joined
// that browser and sent the tab they were reading to the test page.
const profile = tempDir('tweb-edb-');

let shared = null;
async function browser() {
  if (shared) return shared;
  const pageServer = await startTestPage(0);
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(pageServer.url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));
  const server = await startEdbServer({ driver, port: 0, token: 'browsertest' });
  shared = { pageServer, driver, page, server, base: `http://127.0.0.1:${server.port}/t/browsertest` };
  return shared;
}

// Everything opened has to be closed, or the process never exits and node
// holds the whole file's output back waiting for it.
test.after(async () => {
  if (!shared) return;
  await Promise.resolve(shared.server.close?.()).catch(() => {});
  await shared.driver.close().catch(() => {});
  shared.pageServer.server.close();
  removeTempDir(profile);
});

const get = async (url) => {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
};

test('a native select arrives with every option edbrowse needs', async () => {
  const { base } = await browser();
  const { body } = await get(`${base}/1/`);

  assert.match(body, /<select name="e\d+">/);
  // The whole collision, intact: edbrowse chooses among these by number, so
  // the fact that one is a strict prefix of the others costs it nothing.
  for (const country of [
    'Ukraine', 'United Arab Emirates', 'United States Minor Outlying Islands',
    'United States Virgin Islands', 'United States', 'United Kingdom', 'Uruguay',
  ]) {
    assert.ok(body.includes(`<option>${country}</option>`)
      || body.includes(`<option selected>${country}</option>`), `missing option ${country}`);
  }
  assert.match(body, /<option selected>United States<\/option>/);
});

test('a sixty-entry select is not truncated', async () => {
  const { base } = await browser();
  const { body } = await get(`${base}/1/`);
  const years = (body.match(/<option[^>]*>(19|20)\d\d<\/option>/g) || []).length;
  assert.equal(years, 60);
});

test('a field with no form of its own is still submittable', async () => {
  const { base } = await browser();
  const { body } = await get(`${base}/1/`);
  assert.match(body, /<form action="submit\/e\d+" method="post">/);
  assert.match(body, /value="Enter"/);
});

test('the page names itself, not the loopback address', async () => {
  const { base, pageServer } = await browser();
  const { body } = await get(`${base}/1/`);
  assert.ok(body.includes(pageServer.url), 'the real address should be on the page');
});

test('following a control answers a redirect back to the tab', async () => {
  const { base } = await browser();
  const { body } = await get(`${base}/1/`);
  const id = (body.match(/<a href="(e\d+)"/) || [])[1];
  assert.ok(id, 'the page should have something to follow');
  const acted = await get(`${base}/1/${id}`);
  assert.equal(acted.status, 302);
  assert.match(String(acted.location), /\/1\/$/);
});

test('the other four representations render', async () => {
  const { base } = await browser();
  for (const view of ['ax', 'render', 'inspect', 'source']) {
    const { status, body } = await get(`${base}/1/${view}`);
    assert.equal(status, 200, `${view} should render`);
    assert.match(body, /<pre>/, `${view} should be handed over untidied`);
    assert.ok(body.length > 200, `${view} should have content`);
  }
});

test('the accessibility view carries the states the reader relies on', async () => {
  const { base } = await browser();
  const { body } = await get(`${base}/1/ax`);
  // A control that opens something says whether it is open.
  assert.match(body, /collapsed/);
  assert.match(body, /\[\*Fruit/);
});
