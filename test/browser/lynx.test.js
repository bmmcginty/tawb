'use strict';

// The Lynx interface against a real browser.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/lynx.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/lynx.test.js
//
// The unit tests pin the rendering, numbering, prompts, and key translation.
// What only a browser can answer is whether the browser-backed paths those
// features hand off to — activation through a numbered link, rescanning for
// SOURCE — actually reach the page, and whether the default interface really
// is untouched on the same blocks.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const {
  handleBrowseKey, handleNumberKey, relayout,
} = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-lynx-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

const PAGE = `
  <h1>Lynx page</h1>
  <p>Read the <a id="go" href="#" onclick="window.clicked = (window.clicked || 0) + 1; event.preventDefault()">Go</a> link.</p>
  <input aria-label="Query">
`;

async function openPage() {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(PAGE));
  return page;
}

function makeState(core, keys, options = {}) {
  return {
    interface: 'lynx',
    core,
    driver,
    keys,
    sources: ['ax', 'source'],
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

function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; });
}

test('a numbered Lynx link activates the element it numbered', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: false };
  const state = makeState(core, keys);
  relayout(state);

  const blockIndex = core.blocks.findIndex((block) => block.item
    && block.item.role === 'link' && block.item.name === 'Go');
  assert.ok(blockIndex >= 0, 'the link was not extracted');
  const line = state.lines.findIndex((entry) => entry.blockIndex === blockIndex);
  state.cursor = line;
  const number = state.lines[line].displayNumber;
  assert.ok(number >= 1, 'the link was not numbered');
  assert.equal(state.lines[line].text, 'Go', 'the Lynx copy carries no markers');

  await quietly(async () => {
    await handleBrowseKey(String(number), state, page);
    assert.equal(state.mode, 'number');
    await handleNumberKey('\r', state, page);
  });

  assert.equal(await page.evaluate(() => window.clicked), 1);
  assert.equal(state.mode, 'browse');
});

test('a live update renumbers but cannot retarget an open number prompt', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: false };
  const state = makeState(core, keys);
  relayout(state);

  const two = core.blocks.findIndex((block) => block.item
    && block.item.role === 'link' && block.item.name === 'Go');
  const twoLine = state.lines.findIndex((entry) => entry.blockIndex === two);
  const captured = state.lines[twoLine].displayNumber;
  assert.ok(captured >= 1);

  // The reader opens the prompt on that number. Then the page puts a link in
  // front of it, which is exactly what a live update on a busy page does.
  await quietly(async () => {
    await handleBrowseKey(String(captured), state, page);
    assert.equal(state.mode, 'number');

    await page.evaluate(() => {
      const early = document.createElement('a');
      early.href = '#';
      early.textContent = 'Inserted';
      early.addEventListener('click', (event) => {
        window.clicked = 'inserted';
        event.preventDefault();
      });
      document.body.insertBefore(early, document.body.firstChild);
    });
    // The accessibility tree picks the new link up on its own schedule.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await core.rescan();
      if (core.blocks.some((block) => block.item && block.item.name === 'Inserted')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(core.blocks.some((block) => block.item && block.item.name === 'Inserted'),
      'the inserted link never appeared in the rebuilt view');
    relayout(state);

    await handleNumberKey('\r', state, page);
  });

  assert.equal(await page.evaluate(() => window.clicked), undefined,
    'the freshly inserted link was not activated by the old number');
  assert.equal(state.statusMsg, `No link ${captured} on this page.`);

  // The numbering itself did follow the new order: reading order, no gaps,
  // and the link that used to hold 1 now holds 2.
  const numbered = state.lines.filter((line) => line.displayNumber).map((line) => line.displayNumber);
  assert.deepEqual(numbered, [1, 2]);
  const goLine = state.lines.find((line) => state.core.blocks[line.blockIndex]
    && state.core.blocks[line.blockIndex].item
    && state.core.blocks[line.blockIndex].item.name === 'Go');
  assert.equal(goLine.displayNumber, 2);
});

test('the same blocks keep TAWB markers unless the Lynx interface is selected', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const ordinary = makeState(core, new Keymap({ terminfo: {}, load: false }), {
    interface: 'default',
  });
  relayout(ordinary);
  const ordinaryLine = ordinary.lines.find((entry) => {
    const block = core.blocks[entry.blockIndex];
    return block && block.item && block.item.name === 'Go';
  });
  assert.equal(ordinaryLine.text, '{Go}', 'the default view is TAWB’s own vocabulary');
  assert.ok(!ordinaryLine.displayNumber);
  assert.ok(!ordinaryLine.displayPrefix);

  const lynx = makeState(core, new Keymap({ terminfo: {}, profile: 'lynx', load: false }));
  lynx.keys.preferences = { numberLinks: true, numberFields: false };
  relayout(lynx);
  const lynxLine = lynx.lines.find((entry) => {
    const block = core.blocks[entry.blockIndex];
    return block && block.item && block.item.name === 'Go';
  });
  assert.equal(lynxLine.text, 'Go');
  assert.equal(lynxLine.displayNumber, 1);
  assert.equal(lynxLine.displayPrefix, '[1]');
  assert.equal(core.blocks[core.blocks.indexOf(
    core.blocks.find((block) => block.item && block.item.name === 'Go'))].text,
  '{Go}', 'the core text never changed');
});

test('Lynx SOURCE shows the markup and returns to the presentation view', async () => {
  const page = await openPage();
  const core = new Core({ driver, page, source: 'ax', sources: ['ax', 'source'] });
  await core.rescan();

  const state = makeState(core, new Keymap({ terminfo: {}, profile: 'lynx', load: false }));
  relayout(state);

  await quietly(() => handleBrowseKey('\\', state, page));
  assert.equal(core.source, 'source');
  assert.ok(state.lines.some((line) => line.text.includes('<a')),
    'the source view did not show markup');

  await quietly(() => handleBrowseKey('\\', state, page));
  assert.equal(core.source, 'ax', 'the reader returns to the view they were reading');
  assert.ok(!state.lines.some((line) => line.text.includes('<a')),
    'the presentation view came back');
});
