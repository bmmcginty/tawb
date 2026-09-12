'use strict';

// HTML editing hosts through the complete terminal-reader path, against both
// browser engines. Run with:
//
//   TWEB_TEST_BROWSER=chromium node --test test/browser/contenteditable.test.js
//   TWEB_TEST_BROWSER=firefox  node --test test/browser/contenteditable.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { snapshotFrameTree } = require('../../src/frames');
const { layoutLines } = require('../../src/layout');
const { Keymap } = require('../../src/keys');
const { activateCurrent, handleTypeKey } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-contenteditable-');
const fixture = fs.readFileSync(`${__dirname}/contenteditable.html`);

let server;
let driver;

test.after(async () => {
  if (driver) await driver.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
});

function lineNamed(state, name) {
  return state.lines.findIndex((line) => {
    const block = state.core.blocks[line.blockIndex];
    return block && block.item && block.item.name === name;
  });
}

test('contenteditable hosts are fields with a browser-tracked caret', async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  // The browser's caret starts in the middle of nested rich text. Entering
  // the field must preserve and report that position rather than assuming
  // every contenteditable starts at its end.
  await page.evaluate(() => {
    const editor = document.querySelector('#message');
    const range = document.createRange();
    range.setStart(editor.firstChild, editor.firstChild.data.length);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();
  const editors = core.blocks.filter((block) => block.item && block.item.editable === 'content');
  assert.deepEqual(editors.map((block) => block.item.name), ['Message', 'Notes']);
  assert.equal(editors[0].item.role, 'textbox');
  assert.match(editors[0].text, /alpha beta fixed gamma/);

  // PAGE view is the semantics-independent fallback and must retain the same
  // editing host rather than flattening it into ordinary prose.
  const rendered = await snapshotFrameTree(page, 'render', { driver });
  assert.ok(rendered.some((block) => block.item && block.item.name === 'Message'
    && block.item.editable === 'content'));

  const state = {
    core,
    driver,
    keys: new Keymap({ terminfo: {}, load: false }),
    lines: layoutLines(core.blocks, 79),
    cursor: 0,
    col: 0,
    scroll: 0,
    mode: 'browse',
    typing: null,
    historyPlaces: new WeakMap(),
    statusMsg: '',
    statusHeldUntil: 0,
    drawn: { title: null, address: null, hint: null, status: null },
    title: '',
    library: null,
    dialog: null,
  };
  state.cursor = lineNamed(state, 'Message');
  assert.ok(state.cursor >= 0);

  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await activateCurrent(state, page);
    assert.equal(state.mode, 'type');
    assert.equal(state.typing.caret, 6);

    await handleTypeKey('X', state, page);
    assert.equal(state.typing.text, 'alpha Xbeta fixed gamma');
    assert.equal(state.typing.caret, 7);

    await handleTypeKey('\x1b[D', state, page);
    assert.equal(state.typing.caret, 6);
    await handleTypeKey('\x7f', state, page);
    assert.equal(state.typing.text, 'alphaXbeta fixed gamma');
    assert.equal(state.typing.caret, 5);

    await handleTypeKey('\x05', state, page); // Ctrl+E, end of field
    await handleTypeKey('!', state, page);
    assert.equal(state.typing.text, 'alphaXbeta fixed gamma!');
    assert.equal(state.typing.caret, state.typing.text.length);
    assert.equal(await page.evaluate(() => document.querySelector('#message').innerText),
      'alphaXbeta fixed gamma!');
    assert.match(await page.evaluate(() => document.querySelector('#events').textContent),
      /^[1-9][0-9]* input events$/);

    await handleTypeKey('\t', state, page);
    assert.equal(state.mode, 'browse');
    const block = state.core.blocks[state.lines[state.cursor].blockIndex];
    assert.equal(block.item.name, 'Notes');
  } finally {
    process.stdout.write = write;
  }
});
