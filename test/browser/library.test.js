'use strict';

// The browser's own bookmarks, history and downloads, asked of a real browser.
//
//     npm run test:browser
//     TWEB_TEST_BROWSER=firefox npm run test:browser
//
// This is the half of the feature that cannot be stubbed, because the whole of
// it is the browser answering: on Chromium a background tab on
// chrome://bookmarks calling chrome.bookmarks.getTree, and the Mojo handler
// behind chrome://downloads; on Firefox a privileged agent installed while the
// browser starts, calling PlacesUtils and Downloads.
//
// The profile is a fresh one, so the browser starts with nothing in any of the
// three lists. Each is then made to have something in it the way a person
// would put it there — visiting a page, saving a bookmark, fetching a file —
// and the question is whether the browser hands it back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-library-');

// Whatever the browser actually wrote, so the test does not leave files in the
// person's own downloads directory. Both engines download where the browser is
// configured to, and a fresh profile is configured the way any profile is.
const fetched = new Set();

let driver = null;
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
          'content-disposition': 'attachment; filename="reader-probe.bin"',
        });
        response.end(Buffer.alloc(4096, 7));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>A page worth remembering</title><p>Hello.');
    }).listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

test.before(async () => {
  await start();
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`${origin}/page`, { waitUntil: 'domcontentloaded' });
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  if (server) server.close();
  for (const file of fetched) fs.rmSync(file, { force: true });
});

test('a page that was visited is in the browser\'s history', async () => {
  const entries = await driver.readLibrary('history', page);
  const visited = entries.find((entry) => entry.url.startsWith(`${origin}/page`));
  assert.ok(visited, `no history entry for ${origin}/page in ${entries.length} entries`);
  assert.equal(visited.title, 'A page worth remembering');
  // Recent enough to be this run rather than a stale profile.
  assert.ok(Date.now() - visited.when < 120000, `visited at ${visited.when}`);
});

test('history arrives newest first', async () => {
  await page.goto(`${origin}/page?second`, { waitUntil: 'domcontentloaded' });
  const entries = await driver.readLibrary('history', page);
  assert.ok(entries.length >= 2);
  for (let i = 1; i < entries.length; i += 1) {
    assert.ok((entries[i - 1].when || 0) >= (entries[i].when || 0),
      `entry ${i} is newer than the one before it`);
  }
});

// The folder is most of what tells two identically titled bookmarks apart, and
// both browsers ship folders of their own before anybody saves anything.
test('a bookmark comes back with the folder it is filed in', async () => {
  const entries = await driver.readLibrary('bookmarks', page);
  // A fresh Firefox profile ships bookmarks; a fresh Chromium one does not.
  if (!entries.length) {
    assert.equal(ENGINE, 'chromium', 'a profile with no bookmarks at all');
    return;
  }
  for (const entry of entries) {
    assert.ok(entry.url, 'a bookmark with no address');
    assert.equal(typeof entry.folder, 'string');
  }
  assert.ok(entries.some((entry) => entry.folder), 'no bookmark named a folder');
});

test('a file that was fetched is in the browser\'s downloads', async () => {
  // Not awaited: a download is not a navigation, so the request never
  // completes as one and the engine sits on it until its own timeout. What
  // matters is that the browser was asked; the polling below is what waits.
  page.goto(`${origin}/file`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // The browser records a download when it starts it, not when it is asked.
  let entries = [];
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    entries = await driver.readLibrary('downloads', page);
    if (entries.length) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  for (const entry of entries) if (entry.file) fetched.add(entry.file);

  const [download] = entries;
  assert.ok(download, 'the browser recorded no download');
  assert.match(download.title, /reader-probe/);
  assert.match(download.url, /\/file$/);
  assert.equal(typeof download.state, 'string');
  assert.ok(download.state.length, 'a download with nothing said about its state');
});

// ---------------------------------------------------------------------------
// Filing one
// ---------------------------------------------------------------------------

// The other half of the bookmark feature, and the only half that writes.
// Chromium goes through chrome.bookmarks.create on a background
// chrome://bookmarks tab; Firefox through PlacesUtils.bookmarks.insert in the
// privileged agent. The proof is not what either call returned — it is that
// asking the browser for its bookmarks afterwards finds the thing.
test('a bookmark that was filed comes back in the browser\'s own list', async () => {
  const url = `${origin}/page?filed`;
  const saved = await driver.saveBookmark({ url, title: 'Filed by the reader' }, page);
  assert.equal(saved.existed, false);
  assert.equal(saved.title, 'Filed by the reader');
  assert.ok(saved.folder, 'the browser did not say which folder it went in');

  const entries = await driver.readLibrary('bookmarks', page);
  const filed = entries.find((entry) => entry.url === url);
  assert.ok(filed, `no bookmark for ${url} in ${entries.length} entries`);
  assert.equal(filed.title, 'Filed by the reader');
  assert.equal(filed.folder, saved.folder,
    'the folder it was filed in is not the folder it is listed under');
});

// A browser does not make a second bookmark of a page you already bookmarked;
// its star opens the editor instead. Neither does this, and the name it is
// already filed under is what the reader is told.
test('filing the same page twice reports the first one instead of duplicating it', async () => {
  const url = `${origin}/page?filed`;
  const again = await driver.saveBookmark({ url, title: 'A different name' }, page);
  assert.equal(again.existed, true);
  assert.equal(again.title, 'Filed by the reader');

  const entries = await driver.readLibrary('bookmarks', page);
  assert.equal(entries.filter((entry) => entry.url === url).length, 1);
});

test('an unknown list is refused rather than answered emptily', async () => {
  await assert.rejects(() => driver.readLibrary('passwords', page));
});
