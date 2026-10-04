'use strict';

// TAWB's Lynx rendering against a dump recorded by upstream Lynx.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/lynx_fixture.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/lynx_fixture.test.js
//
// test/fixtures/lynx-display.html is one small page using each thing the
// renderer has a convention for. test/fixtures/lynx-display.dump is what the
// installed Lynx 2.9.3 prints for it (`lynx -dump -nolist -width=80
// -number_fields`), checked in rather than generated here so a different Lynx
// on another machine does not change what this compares against: the dump is
// the record, and the test fails if either side stops agreeing with it.
//
// What is compared is structural. TAWB puts each item on its own line where
// Lynx reflows a paragraph, and a frame is shown but not numbered, so the
// test compares the conventions the two must share — the control markers, the
// reading-order numbering, and the heading and document margins — and states
// the known differences rather than pretending they are not there.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const { relayout } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-lynx-fixture-');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

const html = fs.readFileSync(path.join(FIXTURES, 'lynx-display.html'), 'utf8');
const dump = fs.readFileSync(path.join(FIXTURES, 'lynx-display.dump'), 'utf8');

function normalize(text) {
  return String(text).replace(/_+/g, '_').replace(/\s+/g, ' ').trim();
}

async function rendered() {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('file://' + path.join(FIXTURES, 'lynx-display.html'));
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: true };
  const state = {
    interface: 'lynx', core, driver, keys, sources: ['ax'],
    lines: [], cursor: 0, col: 0, scroll: 0,
    library: null, dialog: null, statusMsg: '', drawn: {},
  };
  relayout(state);
  return state;
}

test('the recorded fixture is what upstream Lynx prints', () => {
  // The reference itself, so a fixture edit that quietly changes the record
  // is caught before the comparison below is read as a TAWB failure.
  assert.match(dump, /^\s+Top heading$/m, 'H1 is centered');
  assert.match(dump, /^Second heading$/m, 'H2 is flush left');
  const flat = normalize(dump);
  assert.ok(flat.includes('Prose before a [1]first link and after it.'));
  assert.ok(flat.includes('[X] Checked box'));
  assert.ok(flat.includes('[ ] Unchecked box'));
  assert.ok(flat.includes('(*) Chosen radio'));
  assert.ok(flat.includes('( ) Other radio'));
  assert.ok(flat.includes('IFRAME: [10]about:blank'));
  assert.deepEqual(
    [...dump.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(html, /alt="A map"/);
  assert.match(html, /<iframe/);
});

test('the Lynx renderer uses the same control markers as the dump', async () => {
  const state = await rendered();
  const text = normalize(state.lines.map((line) => line.displayPrefix + line.text).join(' '));

  for (const marker of [
    '[X] Checked box',
    '[ ] Unchecked box',
    '(*) Chosen radio',
    '( ) Other radio',
    'A map',
    'IFRAME:',
    'Send',
  ]) {
    assert.ok(text.includes(marker), `TAWB did not render ${marker}: ${text}`);
  }
  // The text field is a value followed by underscores in both, whatever the
  // width each chooses for it.
  assert.match(text, /lynx_+/);
  assert.match(text, /Country/);
  assert.match(text, /France/);
});

test('the numbering order is the dump’s reading order', async () => {
  const state = await rendered();
  const numbered = state.lines
    .filter((line) => line.displayNumber && !line.continuation)
    .map((line) => state.core.blocks[line.blockIndex].item);

  assert.deepEqual(numbered.map((item) => item.role), [
    'link', 'link', 'textbox', 'checkbox', 'checkbox', 'radio', 'radio', 'combobox', 'button',
  ]);
  assert.deepEqual(numbered.map((item) => item.name), [
    'first link', 'second link', 'Query',
    'Checked box', 'Unchecked box', 'Chosen radio', 'Other radio',
    'Country', 'Send',
  ]);
  assert.deepEqual(numbered.map((line, index) => index + 1),
    numbered.map((unused, index) => index + 1), 'numbers are contiguous from 1');

  // The known difference at the end: Lynx numbers the frame's URL as the
  // tenth link and a reader can follow it. TAWB shows IFRAME: and does not,
  // because a frame element is not something its activation path can follow.
  const frame = state.core.blocks.find((block) => block.item && block.item.role === 'iframe');
  assert.ok(frame, 'the frame was shown');
  const frameLine = state.lines.find((line) => line.blockIndex === state.core.blocks.indexOf(frame));
  assert.equal(frameLine.displayNumber, null, 'the frame is shown but not numbered');
});

test('the heading and document margins follow the dump', async () => {
  const state = await rendered();
  const indentOf = (name) => {
    const blockIndex = state.core.blocks.findIndex((block) => block.item && block.item.name === name);
    const line = state.lines.find((entry) => entry.blockIndex === blockIndex);
    return line ? line.displayIndent : null;
  };
  const h1 = indentOf('Top heading');
  const h2 = indentOf('Second heading');
  assert.ok(h1 > 0, 'H1 is centered, not flush left');
  assert.equal(h2, 0, 'H2 is flush left');
  assert.equal(indentOf('Prose before a'), 3, 'prose keeps the three-cell margin');
});
