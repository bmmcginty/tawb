'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const {
  openOptions, handleBrowseKey, handleLibraryKey, findText, hintText,
} = require('../src/index');
const {
  SELECT_LINE, ANY_KEY_CHANGE, VALUE_ACCEPTED, CANCELLED, CHOICE_LIST, NOT_CHANGEABLE,
} = require('../src/lynx_options');

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

async function keys(state, ...sequence) {
  for (const chunk of sequence) await quietly(() => handleLibraryKey(chunk, state, PAGE));
}

function rowFor(state, letter) {
  return state.library.rows.find((row) => row.letter === letter);
}

test('the Lynx options page carries Lynx letters, labels and select line', async () => {
  const state = reader();
  await quietly(() => handleBrowseKey('o', state, PAGE));
  assert.equal(state.mode, 'library');
  assert.equal(state.library.kind, 'options');
  assert.equal(state.statusMsg, SELECT_LINE);

  for (const letter of ['E', 'D', 'L', 'B', 'F', 'P', 'S', 'G', 'H', 'C', 'O', '&',
    'V', 'M', 'W', 'T', '@', 'K', 'N', 'I', 'U', '!', 'A']) {
    assert.ok(rowFor(state, letter), `no option row for ${letter}`);
  }
  assert.match(rowFor(state, 'S').text, /\(S\)earching type/);
  assert.match(rowFor(state, '@').text, /show cursor \(@\)\s*: OFF/);
  assert.match(rowFor(state, 'K').text, /\(K\)eypad mode\s*: Numbers act as arrows/);
  assert.ok(state.library.blocks.every((block) => block.item.role === 'text'));
  assert.equal(hintText(state),
    'Options Menu — capital letter: change  >: save  r: return  Left: cancel');
});

// Choosing is not changing. The value is offered, any key moves it, and only
// RETURN keeps it — which is the difference between this screen and a list of
// switches, and the thing that makes it safe to walk through with a reader that
// types by accident.
test('a boolean option is chosen, changed and accepted in three steps', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));

  await keys(state, '@');
  assert.equal(state.statusMsg, ANY_KEY_CHANGE);
  assert.equal(state.keys.preferences.showCursor, false, 'choosing changed nothing yet');
  assert.equal(state.library.rows[state.cursor].letter, '@',
    'choosing puts the reader on the option line');

  await keys(state, ' ');
  assert.equal(state.keys.preferences.showCursor, true, 'the value moved');
  assert.match(rowFor(state, '@').text, /show cursor \(@\)\s*: ON/);
  assert.equal(state.statusMsg, ANY_KEY_CHANGE);

  await keys(state, '\r');
  assert.equal(state.statusMsg, VALUE_ACCEPTED);
  assert.equal(state.keys.preferences.showCursor, true);
  assert.equal(state.library.choosing, null);
});

test('a chosen value is abandoned without being kept', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await keys(state, '@', ' ');
  assert.equal(state.keys.preferences.showCursor, true);
  await keys(state, 'q');
  assert.equal(state.statusMsg, CANCELLED);
  assert.equal(state.keys.preferences.showCursor, false);
  assert.equal(state.library.choosing, null);
  assert.match(rowFor(state, '@').text, /show cursor \(@\)\s*: OFF/);
});

test('the searching type is one of the boolean values', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await keys(state, 'S', ' ', '\r');
  assert.equal(state.keys.preferences.searchCase, 'CASE_SENSITIVE');
  assert.match(rowFor(state, 'S').text, /: CASE SENSITIVE/);
});

test('an option with several values is walked with the arrows', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await keys(state, 'K');
  assert.equal(state.statusMsg, CHOICE_LIST);
  await keys(state, '\x1b[B', '\r');
  assert.equal(state.statusMsg, VALUE_ACCEPTED);
  assert.equal(state.keys.preferences.keypadMode, 'LINKS_ARE_NUMBERED');
  assert.equal(state.keys.preferences.numberLinks, true);
  assert.equal(state.keys.preferences.numberFields, false);
});

test('the classic menu requires its displayed capital option letter', async () => {
  const state = reader();
  await quietly(() => openOptions(state, PAGE));
  await keys(state, 'k');
  assert.equal(state.library.choosing, null, 'lowercase k is not the Keypad option');
  await keys(state, 'E');
  assert.equal(state.statusMsg, NOT_CHANGEABLE);
  assert.equal(state.mode, 'library');
});

test('Left cancels the screen while r keeps what changed for the session', async () => {
  const cancelled = reader();
  await quietly(() => openOptions(cancelled, PAGE));
  await keys(cancelled, '@', ' ', '\r');
  await keys(cancelled, '\x1b[D');
  assert.equal(cancelled.mode, 'browse');
  assert.equal(cancelled.keys.preferences.showCursor, false);

  const kept = reader();
  await quietly(() => openOptions(kept, PAGE));
  await keys(kept, '@', ' ', '\r', 'r');
  assert.equal(kept.mode, 'browse');
  assert.equal(kept.keys.preferences.showCursor, true);
});

test('greater-than saves the decided options and returns', async () => {
  const state = reader();
  const directory = tempDir('tawb-options-save-');
  state.lynxSettingsFile = path.join(directory, 'settings.lynx.json');
  await quietly(() => openOptions(state, PAGE));
  await keys(state, '@', ' ', '\r', '>');
  assert.equal(state.mode, 'browse');
  assert.equal(state.statusMsg, 'Options saved.');
  const document = JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8'));
  assert.equal(document.lynx.showCursor, true);
  assert.equal(document.lynx.searchCase, 'CASE_INSENSITIVE');
  assert.equal(Object.hasOwn(document.lynx, 'numberLinks'), false,
    'derived values do not become independent settings');
});

test('a value chosen and not accepted is not saved', async () => {
  const state = reader();
  const directory = tempDir('tawb-options-unsaved-');
  state.lynxSettingsFile = path.join(directory, 'settings.lynx.json');
  await quietly(() => openOptions(state, PAGE));
  await keys(state, '@', ' ', 'q', '>');
  const document = JSON.parse(fs.readFileSync(state.lynxSettingsFile, 'utf8'));
  assert.equal(document.lynx.showCursor, false,
    'a cancelled value was written as if it had been accepted');
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
