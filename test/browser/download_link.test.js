'use strict';

// Saving the link under the terminal cursor through each browser's native
// download gesture. The response is text/plain and would display in the tab
// after an ordinary click; remaining on the page proves this was a download.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { layoutLines } = require('../../src/layout');
const { Keymap } = require('../../src/keys');
const { handleBrowseKey } = require('../../src/index');
const { prepareRealClick } = require('../../src/click');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-download-link-');
const downloaded = new Set();
let driver;
let server;

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const file of downloaded) fs.rmSync(file, { force: true });
  removeTempDir(profile);
});

test('Alt+D adds the link under the cursor to browser downloads', async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/manual.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('The downloaded manual.');
      return;
    }
    if (request.url === '/form.txt') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('The downloaded form.');
      return;
    }
    // The second page reproduces the shape the check used to refuse: a link
    // whose text wraps onto two lines inside a narrow list item. The line
    // height is larger than the height of a line of text, so a gap of leading
    // separates the two line boxes. The union of the two line boxes is a
    // rectangle the link does not fill, and the middle of that union falls in
    // the gap, where the <li> is what a click would hit.
    if (request.url === '/wrapped') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Wrapped</title>'
        + '<style>li { width: 190px; font: 13px sans-serif; line-height: 30px; }</style>'
        + '<ul><li><a href="/form.txt">Corporate Member Benefit Option Change Form</a></li></ul>');
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
    // Alt+D, as an escape and the letter. Unmodified letters belong to
    // moving through the page, so the download action does not have one.
    await handleBrowseKey('\x1bd', state, page);
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

// The aim point of a real click is the middle of the element's first line
// box, not the middle of getBoundingClientRect(). A link whose text wraps
// onto two lines has a bounding rectangle whose middle it does not occupy, so
// aiming at that middle hit the <li> behind the link and Alt+D refused the
// download with "is covered by <li>". Measured on
// https://www.bestmed.co.za/plans-and-options/brochures-guides-and-forms in
// both engines.
test('Alt+D downloads a link whose text wraps onto two lines', async () => {
  const page = await driver.newTab();
  const pageUrl = `http://127.0.0.1:${server.address().port}/wrapped`;
  await page.goto(pageUrl);

  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const name = 'Corporate Member Benefit Option Change Form';
  const link = core.blocks.find((block) => block.item && block.item.name === name);
  assert.ok(link, 'the wrapped link was not in the page view');

  // The gate the download goes through, asked directly: before the fix it
  // answered { ok: false, reason: 'is covered by <li>' }.
  const handle = await core.handleFor(link.item, page);
  const ready = await handle.evaluate(prepareRealClick);
  await handle.dispose().catch(() => {});
  assert.ok(ready && ready.ok, `the wrapped link was refused: ${ready && ready.reason}`);

  const result = await core.downloadLink(link.item, page);
  assert.ok(result.ok, `the download was refused: ${result.reason}`);
  assert.equal(page.url(), pageUrl, 'downloading navigated the current tab');

  let entry = null;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    const entries = await driver.readLibrary('downloads', page);
    entry = entries.find((candidate) => candidate.url.includes('/form.txt')) || null;
    if (entry) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(entry, 'the browser recorded no download for the wrapped link');
  if (entry.file) downloaded.add(entry.file);
});
