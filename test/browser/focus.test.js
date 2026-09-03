'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { exactBlockForElement } = require('../../src/place');
const { layoutLines } = require('../../src/layout');
const { activateCurrent } = require('../../src/index');
const { armActivationFocus, focusedByActivation } = require('../../src/focus');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-focus-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

test('an activation-scoped focus change identifies its exact destination', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <button id="source" onclick="destination.focus()">Move focus</button>
    <a href="#" id="destination">Destination</a>
    <button id="delayed" onclick="setTimeout(() => destination.focus(), 40)">Later</button>
    <button id="self" onclick="this.focus()">Self</button>
  `));

  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();

  const source = await page.evaluateHandle(() => document.querySelector('#source'));
  const watching = await armActivationFocus(page, source);
  await source.evaluate((element) => element.click());
  const focused = await focusedByActivation(watching);
  await source.dispose();

  assert.ok(focused, 'the synchronous focus change was not observed');
  assert.equal(await focused.handle.evaluate((element) => element.id), 'destination');
  const block = await exactBlockForElement(
    { source: core.source, blocks: core.blocks }, page, focused.handle, focused.frame);
  assert.equal(core.blocks[block].item.name, 'Destination');
  await focused.handle.dispose();

  await page.evaluate(() => document.activeElement.blur());
  const delayed = await page.evaluateHandle(() => document.querySelector('#delayed'));
  const delayedWatch = await armActivationFocus(page, delayed);
  await delayed.evaluate((element) => element.click());
  const delayedFocus = await focusedByActivation(delayedWatch);
  await delayed.dispose();
  assert.equal(await delayedFocus.handle.evaluate((element) => element.id), 'destination');
  await delayedFocus.handle.dispose();

  const self = await page.evaluateHandle(() => document.querySelector('#self'));
  const selfWatch = await armActivationFocus(page, self);
  await self.evaluate((element) => element.click());
  assert.equal(await focusedByActivation(selfWatch, { waitMs: 50 }), null,
    'focus on the activated control was mistaken for a destination');
  await self.dispose();

  await page.evaluate(() => document.activeElement.blur());
  await core.rescan();
  const sourceBlock = core.blocks.findIndex((entry) => entry.item && entry.item.name === 'Move focus');
  const lines = layoutLines(core.blocks, 79);
  const state = {
    core,
    driver,
    lines,
    cursor: lines.findIndex((line) => line.blockIndex === sourceBlock),
    col: 0,
    scroll: 0,
    mode: 'browse',
    historyPlaces: new WeakMap(),
    statusMsg: '',
    statusHeldUntil: 0,
    drawn: { title: null, address: null, hint: null, status: null },
    title: '',
    library: null,
    dialog: null,
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await activateCurrent(state, page);
  } finally {
    process.stdout.write = write;
  }

  const selected = core.blocks[state.lines[state.cursor].blockIndex];
  assert.equal(selected.item.name, 'Destination',
    'the terminal cursor did not follow the focus caused by Enter');
});
