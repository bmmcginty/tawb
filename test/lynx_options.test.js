'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const {
  openOptions, handleBrowseKey, handleLibraryKey, findText,
} = require('../src/index');

const PAGE = { url: () => 'https://example.test/page' };

function reader() {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = {
    keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false,
    numberLinksOnLeft: true, numberFieldsOnLeft: true,
    textfieldsNeedActivation: false, searchCase: 'CASE_INSENSITIVE', showCursor: false,
  };
  return {
    interface: 'lynx', keys, mode: 'browse', library: null,
    lines: [{ blockIndex: 0, text: 'The page' }], cursor: 0, col: 0, scroll: 0,
    title: 'The page', statusMsg: '', drawn: { title: null, address: null, hint: null },
    core: {
      source: 'ax', blocks: [{ text: 'The page', item: null }], at() {}, markInput() {},
      live: { refreshing: false },
    },
  };
}

async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

test('the Lynx options page uses the classic letters and return prompt', async () => {
  const state = reader();
  await quietly(() => handleBrowseKey('o', state, PAGE));
  assert.equal(state.mode, 'library');
  assert.equal(state.library.kind, 'options');
  assert.match(state.library.rows[0].text, /Options Menu/);
  assert.ok(state.library.rows.some((row) => row.text.includes('(S)earching type')));
  assert.ok(state.library.rows.some((row) => row.text.includes('show cursor (@)')));
  assert.ok(state.library.rows.some((row) => row.text.includes('(K)eypad mode')));
  assert.equal(state.library.rows.at(-1).text,
    "Select capital letter of option to change; '>' to save, or 'r' to return.");
  assert.ok(state.library.blocks.every((block) => block.item.role === 'text'));
});

test('option letters change only the supported Lynx preferences', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await quietly(() => handleLibraryKey('@', state, PAGE));
  await quietly(() => handleLibraryKey('S', state, PAGE));
  await quietly(() => handleLibraryKey('K', state, PAGE));
  assert.equal(state.keys.preferences.showCursor, true);
  assert.equal(state.keys.preferences.searchCase, 'CASE_SENSITIVE');
  assert.equal(state.keys.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
  assert.equal(state.keys.preferences.numberLinks, true);
  assert.equal(state.keys.preferences.numberFields, false);
  assert.match(state.library.rows.find((row) => row.text.includes('show cursor')).text, /ON$/);

  await quietly(() => handleLibraryKey('E', state, PAGE));
  assert.match(state.statusMsg, /belongs to Lynx or the browser/);
  assert.equal(state.mode, 'library');
});

test('Left cancels option changes while r keeps them for the session', async () => {
  const cancelled = reader();
  await quietly(() => openOptions(cancelled, PAGE));
  await quietly(() => handleLibraryKey('@', cancelled, PAGE));
  await quietly(() => handleLibraryKey('\x1b[D', cancelled, PAGE));
  assert.equal(cancelled.mode, 'browse');
  assert.equal(cancelled.keys.preferences.showCursor, false);

  const accepted = reader();
  await quietly(() => openOptions(accepted, PAGE));
  await quietly(() => handleLibraryKey('@', accepted, PAGE));
  await quietly(() => handleLibraryKey('r', accepted, PAGE));
  assert.equal(accepted.mode, 'browse');
  assert.equal(accepted.keys.preferences.showCursor, true);
});

test('greater-than saves options to settings.lynx.json and returns', async () => {
  const state = reader();
  const directory = tempDir('tawb-options-save-');
  state.lynxSettingsFile = path.join(directory, 'settings.lynx.json');
  await quietly(() => openOptions(state, PAGE));
  await quietly(() => handleLibraryKey('@', state, PAGE));
  await quietly(() => handleLibraryKey('>', state, PAGE));
  assert.equal(state.mode, 'browse');
  assert.equal(state.statusMsg, 'Options saved.');
  const document = JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8'));
  assert.equal(document.lynx.showCursor, true);
  assert.equal(document.lynx.searchCase, 'CASE_INSENSITIVE');
  assert.equal(Object.hasOwn(document.lynx, 'numberLinks'), false,
    'derived values do not become independent settings');
});

test('Lynx Searching Type is absolute while the default interface keeps smart case', () => {
  const state = reader();
  state.lines = [{ text: 'start' }, { text: 'Lynx browser' }];
  state.keys.preferences.searchCase = 'CASE_INSENSITIVE';
  assert.deepEqual(findText(state, 'LYNX', 1), { line: 1, col: 0, wrapped: false });
  state.keys.preferences.searchCase = 'CASE_SENSITIVE';
  assert.equal(findText(state, 'LYNX', 1), null);

  state.interface = 'default';
  assert.deepEqual(findText(state, 'lynx', 1), { line: 1, col: 0, wrapped: false });
  assert.equal(findText(state, 'LYNX', 1), null);
});
