'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { openDriver } = require('../../src/driver');
const { traversePageHistory } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-history-'));

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
  await page.goto(`${base}/two`, { waitUntil: 'domcontentloaded' });

  assert.equal(await traversePageHistory(page, -1), true);
  assert.equal(page.url(), `${base}/one`);
  assert.equal(await traversePageHistory(page, 1), true);
  assert.equal(page.url(), `${base}/two`);
  assert.equal(await traversePageHistory(page, 1, 100), false, 'the end of history is reported');
});
