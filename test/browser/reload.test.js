'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-reload-');
let server;
let driver;

test.after(async () => {
  if (driver) await driver.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  removeTempDir(profile);
});

test('the browser reloads the current document', async () => {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.url !== '/page') {
      res.writeHead(204);
      res.end();
      return;
    }
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>Load ${requests}</title><p>Load ${requests}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  const url = `http://127.0.0.1:${server.address().port}/page`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.title(), 'Load 1');

  await page.reload({ waitUntil: 'domcontentloaded' });

  assert.equal(page.url(), url);
  assert.equal(await page.title(), 'Load 2');
});
