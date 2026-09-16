'use strict';

// The live observer, against a real browser.
//
//     npm run test:browser
//     xvfb-run -a npm run test:browser     # with no display of your own
//
// What matters here is *when* the observer is armed. It is installed by
// addInitScript, which runs at document-start — before the parser has reached
// the <html> tag — and everything about arming has to work in a document that
// is not built yet.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const { installLive, collect } = require('../../src/live');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';

// Its own profile, for the same reason views.test.js has one: a browser is one
// instance per profile directory, and test files run in parallel.
const profile = tempDir('tweb-live-');

// A page with enough in it that parsing produces mutations to catch, and one
// live region that announces while it loads.
const PAGE = `<!doctype html><meta charset="utf-8"><title>live</title>
<div role="status">Three results</div>
${Array.from({ length: 200 }, (_, i) => `<p>row ${i}</p>`).join('\n')}`;

let shared = null;
async function browser() {
  if (shared) return shared;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await installLive(page);
  shared = { server, driver, page, url: `http://127.0.0.1:${server.address().port}/` };
  return shared;
}

test.after(async () => {
  if (!shared) return;
  await shared.driver.close().catch(() => {});
  shared.server.close();
  removeTempDir(profile);
});

async function freshLoad() {
  const { page, url } = await browser();
  await page.goto('about:blank');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

// The observer coalesces inside the page and hands its batch over on a timer,
// so what it saw during parsing arrives shortly after the parse. Waiting for
// that cannot paper over an observer that was never armed: nothing in this
// file runs the pulse, and the pulse is the only thing that arms one late.
async function waitForFlush(page) {
  await page.waitForFunction(
    () => (window[Symbol.for('tweb.queue')] || []).length > 0, null, { timeout: 5000 },
  ).catch(() => {});
}

// This one deliberately does not wait: the observer has to be there already.
test('the observer is armed before the document has a documentElement', async () => {
  const page = await freshLoad();
  const state = await page.evaluate(() => ({
    installed: !!window[Symbol.for('tweb.observer')],
    root: window[Symbol.for('tweb.observerRoot')] === document ? 'document' : 'something else',
  }));
  assert.equal(state.installed, true,
    'addInitScript runs at document-start, where there is no documentElement to observe');
  assert.equal(state.root, 'document');
});

test('mutations made while the page is parsing are not missed', async () => {
  const page = await freshLoad();
  await waitForFlush(page);
  const payloads = await collect(page);
  const mutations = payloads.reduce((sum, p) => sum + p.mutations, 0);
  assert.ok(mutations > 0, `parsing the page should have been seen, got ${mutations} mutations`);
});

test('a live region that announces while the page loads is still announced', async () => {
  const page = await freshLoad();
  await waitForFlush(page);
  const payloads = await collect(page);
  const announcements = payloads.flatMap((p) => p.announcements);
  assert.ok(announcements.some((a) => a.text.includes('Three results')),
    `expected the status region in ${JSON.stringify(announcements)}`);
});

// Reading innerText forces layout, and summarise runs once per record — which
// is now once per element the parser inserts. Only a live region has anything
// to announce, and the caller discards everything else, so nothing outside one
// may pay for the text.
test('nothing outside a live region is asked for its text', async () => {
  const page = await freshLoad();
  await waitForFlush(page);
  await collect(page); // start from an empty queue
  const asked = await page.evaluate(() => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let reads = 0;
    const proto = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText');
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { reads += 1; return proto.get.call(this); },
      set(v) { return proto.set.call(this, v); },
    });
    return new Promise((resolve) => {
      el.textContent = 'changed';
      setTimeout(() => {
        Object.defineProperty(HTMLElement.prototype, 'innerText', proto);
        resolve(reads);
      }, 300);
    });
  });
  assert.equal(asked, 0, 'a plain text change is not in a live region and needs no text read');
  // And the mutation really did reach the observer, or the count above would
  // be zero because nothing was watching rather than because nothing asked.
  const payloads = await collect(page);
  assert.ok(payloads.reduce((sum, p) => sum + p.mutations, 0) > 0,
    'the change has to have been seen for the absence of a text read to mean anything');
});
