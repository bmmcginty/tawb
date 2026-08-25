'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const {
  historyEntryIdentity, rememberCurrentHistoryPlace, restoreHistoryPlace, traversePageHistory,
} = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-history-');

let server;
let driver;

test.after(async () => {
  if (driver) await driver.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
});

test('the page can move backward and forward through its own history', async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>${req.url}</title><p>${req.url}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/one`, { waitUntil: 'domcontentloaded' });
  const state = {
    cursor: 7, col: 3, scroll: 4, historyPlaces: new WeakMap(),
    lines: Array.from({ length: 30 }, (_, index) => ({ text: `line ${index} long enough` })),
  };
  await rememberCurrentHistoryPlace(state, page);
  await page.goto(`${base}/two`, { waitUntil: 'domcontentloaded' });

  assert.equal(await traversePageHistory(page, -1), true);
  assert.equal(page.url(), `${base}/one`);
  state.cursor = 0;
  state.col = 0;
  state.scroll = 0;
  assert.equal(restoreHistoryPlace(state, page, await historyEntryIdentity(page)), true);
  assert.deepEqual(
    { cursor: state.cursor, col: state.col, scroll: state.scroll },
    { cursor: 7, col: 3, scroll: 4 },
  );
  assert.equal(await traversePageHistory(page, 1), true);
  assert.equal(page.url(), `${base}/two`);
  assert.equal(await traversePageHistory(page, 1, 100), false, 'the end of history is reported');
});
