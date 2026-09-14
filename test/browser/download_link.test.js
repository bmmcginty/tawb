'use strict';

// Saving the link under the terminal cursor through each browser's native
// download gesture. The response is text/plain and would display in the tab
// after an ordinary click; remaining on the page proves this was a download.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { layoutLines } = require('../../src/layout');
const { Keymap } = require('../../src/keys');
const { handleBrowseKey } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-download-link-');
const downloaded = new Set();
let driver;
let server;

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const file of downloaded) fs.rmSync(file, { force: true });
  fs.rmSync(profile, { recursive: true, force: true });
});

test('d adds the link under the cursor to browser downloads', async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/manual.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('The downloaded manual.');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Downloads</title><a href="/manual.txt">Manual</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  const pageUrl = `http://127.0.0.1:${server.address().port}/page`;
  await page.goto(pageUrl);

  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();
  const state = {
    core,
    driver,
    keys: new Keymap({ terminfo: {}, load: false }),
    lines: layoutLines(core.blocks, 79),
    cursor: 0,
    col: 0,
    scroll: 0,
    mode: 'browse',
    library: null,
    dialog: null,
    statusMsg: '',
    drawn: { title: null, address: null, hint: null, status: null },
  };
  state.cursor = state.lines.findIndex((line) => {
    const block = core.blocks[line.blockIndex];
    return block && block.item && block.item.name === 'Manual';
  });
  assert.ok(state.cursor >= 0, 'the link was not in the page view');

  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await handleBrowseKey('d', state, page);
  } finally {
    process.stdout.write = write;
  }
  assert.match(state.statusMsg, /Added "Manual" to downloads/);
  assert.equal(page.url(), pageUrl, 'downloading navigated the current tab');

  let entry = null;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    const entries = await driver.readLibrary('downloads', page);
    entry = entries.find((candidate) => candidate.url.includes('/manual.txt')) || null;
    if (entry) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(entry, 'the browser recorded no download for the link');
  if (entry.file) downloaded.add(entry.file);
});
