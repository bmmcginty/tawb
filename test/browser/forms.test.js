'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { layoutLines } = require('../../src/layout');
const { Keymap } = require('../../src/keys');
const { activateCurrent, handleTypeKey } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-forms-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

function lineNamed(state, name) {
  return state.lines.findIndex((line) => {
    const block = state.core.blocks[line.blockIndex];
    return block && block.item && block.item.name === name;
  });
}

test('Tab leaves editing for the next control and comboboxes open', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <input aria-label="First field">
    <button role="combobox" aria-label="Choices" aria-expanded="false"
      aria-controls="choices" onclick="this.setAttribute('aria-expanded', 'true'); choices.hidden = false">
      Choose
    </button>
    <div id="choices" role="listbox" hidden><div role="option">One</div></div>
    <select aria-label="Country"><option>Canada</option><option>France</option></select>
    <input aria-label="Last field">
  `));

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
    typing: null,
    historyPlaces: new WeakMap(),
    statusMsg: '',
    statusHeldUntil: 0,
    drawn: { title: null, address: null, hint: null, status: null },
    title: '',
    library: null,
    dialog: null,
  };
  state.cursor = lineNamed(state, 'First field');

  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await activateCurrent(state, page);
    assert.equal(state.mode, 'type');

    await handleTypeKey('\t', state, page);
    assert.equal(state.mode, 'browse');
    assert.equal(state.core.blocks[state.lines[state.cursor].blockIndex].item.name, 'Choices');

    await activateCurrent(state, page);
    assert.equal(state.mode, 'browse', 'a select-only combobox was mistaken for a text field');
    assert.equal(await page.evaluate(
      () => document.querySelector('[role=combobox]').getAttribute('aria-expanded')), 'true');

    state.cursor = lineNamed(state, 'Country');
    await activateCurrent(state, page);
    assert.equal(state.mode, 'choose', 'a native select did not open its choices');
  } finally {
    process.stdout.write = write;
  }
});
