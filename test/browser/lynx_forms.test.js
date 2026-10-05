'use strict';

// Lynx form and editing behavior against a real browser.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/lynx_forms.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/lynx_forms.test.js
//
// test/browser/forms.test.js covers the Lynx arrows entering a field and Tab
// leaving it. What is added here is the rest of the interactive surface a
// reader meets in a form: a textarea and a contenteditable host, a native
// select opening TAWB's own chooser under the Lynx movement keys, a custom
// ARIA control that is pressed rather than typed into, and a form that
// updates in place rather than navigating.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const {
  handleBrowseKey, handleChooseKey, handleTypeKey, relayout,
} = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-lynx-forms-');
let driver;
let server;
let fixtureBody = '';

test.after(async () => {
  if (driver) await driver.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  removeTempDir(profile);
});

async function readFixture(html) {
  if (!server) {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(fixtureBody);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  fixtureBody = html;
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return page;
}

// The vi movement keys, as the effective vi map binds them: h/j/k/l for
// movement and activation, with the arrow keys and Enter still there. This is
// the table where the Lynx keys and TAWB's chooser keys have to agree.
const VI_BINDINGS = {
  'history-back': ['h', 'ArrowLeft'],
  'next-focusable': ['j', 'Tab', 'ArrowDown'],
  'previous-focusable': ['k', 'Shift+Tab', 'ArrowUp'],
  activate: ['l', 'Enter', 'ArrowRight'],
  'list-links': ['L'],
};

function makeState(core, options = {}) {
  const keys = new Keymap({
    terminfo: {}, profile: 'lynx', load: false, bindings: VI_BINDINGS,
  });
  keys.preferences = { numberLinks: false, numberFields: false, textfieldsNeedActivation: false };
  return {
    interface: 'lynx',
    core,
    driver,
    keys,
    sources: ['ax'],
    lines: [],
    cursor: 0,
    col: 0,
    scroll: 0,
    mode: 'browse',
    typing: null,
    inputSeen: false,
    historyPlaces: new WeakMap(),
    statusMsg: '',
    statusHeldUntil: 0,
    title: '',
    library: null,
    dialog: null,
    linkAddress: false,
    drawn: { title: null, address: null, hint: null, status: null },
    ...options,
  };
}

function lineNamed(state, name) {
  return state.lines.findIndex((line) => {
    const block = state.core.blocks[line.blockIndex];
    return block && block.item && block.item.name === name;
  });
}

function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; });
}

test('Lynx arrows enter a textarea and Tab moves on to the next control', async () => {
  const page = await readFixture(`
    <p>Before</p>
    <textarea aria-label="Message"></textarea>
    <button>Send</button>
  `);
  const core = new Core({ driver, page, source: 'ax', layout: true });
  await core.rescan();
  const state = makeState(core);
  relayout(state);

  await quietly(async () => {
    await handleBrowseKey('\x1b[B', state, page);
  });
  assert.equal(state.mode, 'type', 'the Lynx arrow entered the textarea');
  assert.equal(core.blocks[state.lines[state.cursor].blockIndex].item.name, 'Message');

  await quietly(async () => {
    await handleTypeKey('h', state, page);
    await handleTypeKey('i', state, page);
  });
  assert.equal(await page.evaluate(() => document.querySelector('textarea').value), 'hi');

  await quietly(async () => {
    await handleTypeKey('\t', state, page);
  });
  assert.equal(state.mode, 'browse', 'Tab left the textarea for another control');
  assert.equal(core.blocks[state.lines[state.cursor].blockIndex].item.name, 'Send');
  assert.equal(await page.evaluate(() => document.querySelector('textarea').value), 'hi');
});

test('Lynx arrows enter a contenteditable host and Tab leaves it', async () => {
  const page = await readFixture(`
    <p>Before</p>
    <div contenteditable aria-label="Message">alpha</div>
    <button>Send</button>
  `);
  // Put the browser's caret at the end of the host, so where the typed
  // character lands is the page's answer rather than a default.
  await page.evaluate(() => {
    const host = document.querySelector('[contenteditable]');
    const range = document.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });

  const core = new Core({ driver, page, source: 'ax', layout: true });
  await core.rescan();
  const state = makeState(core);
  relayout(state);

  await quietly(async () => {
    await handleBrowseKey('\x1b[B', state, page);
  });
  assert.equal(state.mode, 'type', 'the contenteditable host was entered for editing');
  assert.equal(core.blocks[state.lines[state.cursor].blockIndex].item.name, 'Message');
  assert.equal(state.typing.text, 'alpha');

  await quietly(async () => {
    await handleTypeKey('X', state, page);
  });
  assert.equal(await page.evaluate(() => document.querySelector('[contenteditable]').innerText),
    'alphaX');

  await quietly(async () => {
    await handleTypeKey('\t', state, page);
  });
  assert.equal(state.mode, 'browse');
  assert.equal(core.blocks[state.lines[state.cursor].blockIndex].item.name, 'Send');
});

test('Lynx Enter opens a native select and the Lynx keys choose and cancel', async () => {
  const page = await readFixture(`
    <select aria-label="Country">
      <option>Canada</option>
      <option>France</option>
      <option>Japan</option>
    </select>
  `);
  const core = new Core({ driver, page, source: 'ax', layout: true });
  await core.rescan();
  const state = makeState(core);
  relayout(state);
  state.cursor = lineNamed(state, 'Country');

  await quietly(async () => {
    await handleBrowseKey('\r', state, page);
  });
  assert.equal(state.mode, 'choose', 'the select opened TAWB’s chooser');

  // k and j are the Lynx keys for the previous and next link; inside the
  // chooser they mean the previous and next choice.
  await quietly(async () => {
    await handleChooseKey('j', state, page);
    await handleChooseKey('l', state, page);
  });
  assert.equal(state.mode, 'browse');
  assert.equal(await page.evaluate(() => document.querySelector('select').value), 'France');

  // Escape leaves the next one as it was.
  await quietly(async () => {
    await handleBrowseKey('\r', state, page);
    assert.equal(state.mode, 'choose');
    await handleChooseKey('h', state, page);
  });
  assert.equal(state.mode, 'browse');
  assert.equal(await page.evaluate(() => document.querySelector('select').value), 'France');
  assert.match(state.statusMsg, /as it was/);
});

test('a custom ARIA control is pressed rather than typed into, updating in place', async () => {
  const page = await readFixture(`
    <button type="button" role="combobox" aria-label="Choices" aria-expanded="false"
      aria-controls="choices"
      onclick="this.setAttribute('aria-expanded','true'); document.querySelector('#choices').hidden = false; document.querySelector('#said').textContent = 'opened'">
      Choose
    </button>
    <div id="choices" role="listbox" hidden><div role="option">One</div></div>
    <p id="said"></p>
  `);
  const core = new Core({ driver, page, source: 'ax', layout: true });
  await core.rescan();
  const state = makeState(core);
  relayout(state);
  state.cursor = lineNamed(state, 'Choices');

  await quietly(async () => {
    await handleBrowseKey('\r', state, page);
  });
  assert.notEqual(state.mode, 'type', 'a control with no caret is not typed into');
  assert.equal(await page.evaluate(() => document.querySelector('#said').textContent), 'opened');
  assert.equal(await page.evaluate(() => document.querySelector('#choices').hidden), false);
});
