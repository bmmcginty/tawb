'use strict';

// The browser's own bookmarks, history and downloads after --keep-browser.
//
//     npm run test:browser
//     TWEB_TEST_BROWSER=firefox npm run test:browser
//
// A browser left running by --keep-browser outlives the TAWB process that
// started it, and the next TAWB process joins that browser rather than
// starting another one. The question this test asks is whether the joining
// process can still read the three lists, because the code that answers for
// them was installed by the process that has since exited.
//
// On Chromium the answer never depended on the TAWB process: a list is read by
// opening an internal page in the browser. On Firefox the answer is a
// privileged agent installed while TAWB holds Marionette at browser startup.
// That agent's listener belongs to Firefox's parent process rather than to
// TAWB, so the agent survives the exit, and the joining process finds the
// agent's endpoint in the profile's endpoint record.
//
// Nothing smaller than a real browser test proves the claim: the first driver
// must really close and the second must really join the same live browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { readEndpointRecord } = require('../../src/endpoint');
const { readRegistry, forgetBrowser } = require('../../src/registry');
const { killProcessGroup } = require('../../src/proc');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-keep-library-');

// Whatever the browser actually wrote, so the test does not leave files in the
// person's own downloads directory.
const fetched = new Set();

let rejoined = null;
let page = null;
let server = null;
let origin = '';

// A page to have been to, and a file to have fetched.
function start() {
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      if (request.url.startsWith('/file')) {
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="kept-probe.bin"',
        });
        response.end(Buffer.alloc(4096, 9));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Remembered across sessions</title><p>Hello.');
    }).listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

// Everything the first session does, so that the second session has something
// of every kind to find: a page in history, a bookmark filed by hand, and a
// download the browser recorded.
async function fill(driver, first) {
  await first.goto(`${origin}/page`, { waitUntil: 'domcontentloaded' });
  await driver.saveBookmark(
    { url: `${origin}/page?before`, title: 'Filed before the browser was kept' }, first);

  // Not awaited: a download is not a navigation, so the request never
  // completes as one and the engine sits on it until its own timeout. What
  // matters is that the browser was asked; the polling below is what waits.
  first.goto(`${origin}/file`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    const entries = await driver.readLibrary('downloads', first);
    if (entries.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.before(async () => {
  await start();

  const kept = await openDriver({
    engine: ENGINE, profile, keepBrowser: true, log: () => {},
  });
  const first = kept.context.pages()[0] || await kept.context.newPage();
  await fill(kept, first);
  // The browser stays; only this reader of it goes away. From here on nothing
  // that answers is owned by the process that started the browser.
  await kept.close();

  rejoined = await openDriver({ engine: ENGINE, profile, log: () => {} });
  page = rejoined.context.pages()[0] || await rejoined.context.newPage();
});

test.after(async () => {
  if (rejoined) await rejoined.close().catch(() => {});
  // A kept browser is kept from every sweep, including the one that cleans up
  // after a test run, so this test takes down the browser it asked to stay.
  for (const entry of readRegistry()) {
    if (entry.profileDir !== profile) continue;
    killProcessGroup(entry.pid);
    forgetBrowser(entry.port);
  }
  if (server) server.close();
  for (const file of fetched) fs.rmSync(file, { force: true });
});

test('a browser that was kept is joined rather than started again', () => {
  const record = readEndpointRecord(profile);
  assert.ok(record && record.port, 'the kept browser left no endpoint record');
  assert.equal(rejoined.port, record.port,
    'the joining session is not reading the browser that was kept');
});

test('a page the first session visited is still in the kept browser\'s history', async () => {
  const entries = await rejoined.readLibrary('history', page);
  const visited = entries.find((entry) => entry.url.startsWith(`${origin}/page`));
  assert.ok(visited, `no history entry for ${origin}/page in ${entries.length} entries`);
});

test('a bookmark the first session filed is still in the kept browser\'s list', async () => {
  const entries = await rejoined.readLibrary('bookmarks', page);
  const filed = entries.find((entry) => entry.url === `${origin}/page?before`);
  assert.ok(filed, `no bookmark for ${origin}/page?before in ${entries.length} entries`);
  assert.equal(filed.title, 'Filed before the browser was kept');
});

test('a file the first session fetched is still in the kept browser\'s downloads', async () => {
  const entries = await rejoined.readLibrary('downloads', page);
  for (const entry of entries) if (entry.file) fetched.add(entry.file);
  const download = entries.find((entry) => /kept-probe/.test(entry.title || ''));
  assert.ok(download, `no download for kept-probe.bin in ${entries.length} entries`);
});

// Reading a list is the browser answering a question. Filing a bookmark is the
// browser being changed, which is the half that a lost agent would fail at
// while the reading half still appeared to work from a cached answer.
test('the joining session can still file a bookmark in the kept browser', async () => {
  const url = `${origin}/page?after`;
  const saved = await rejoined.saveBookmark({ url, title: 'Filed after rejoining' }, page);
  assert.equal(saved.existed, false);

  const entries = await rejoined.readLibrary('bookmarks', page);
  const filed = entries.find((entry) => entry.url === url);
  assert.ok(filed, `no bookmark for ${url} in ${entries.length} entries`);
  assert.equal(filed.title, 'Filed after rejoining');
});

// What makes the Firefox agent outlive its installer: the listener is the
// browser's, and where to reach it is written down beside the browser's own
// debugging endpoint. It is an address rather than a secret, which is why
// writing it down is safe — a webpage cannot open a raw TCP connection to it.
test('the kept Firefox agent is reached by its recorded endpoint, not through a page', {
  skip: ENGINE !== 'firefox',
}, async () => {
  const record = readEndpointRecord(profile);
  assert.ok(record && record.libraryPort, 'the kept browser recorded no agent endpoint');
  assert.equal(await page.evaluate(
    () => typeof window[Symbol.for('tweb.library')]), 'undefined');
});
