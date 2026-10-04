'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const {
  handleBrowseKey, handleLibraryKey, openMainMenu,
} = require('../src/index');

const PAGE = { url: () => 'https://page.test/' };

function reader() {
  return {
    interface: 'lynx',
    keys: new Keymap({ terminfo: {}, profile: 'lynx', load: false }),
    mode: 'browse', library: null,
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

test('h, H, and question mark open Lynx help while k opens the keymap', async () => {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  assert.equal(keys.actionFor('h'), 'help');
  assert.equal(keys.actionFor('H'), 'help');
  assert.equal(keys.actionFor('?'), 'help');
  assert.equal(keys.actionFor('k'), 'keyboard-wizard');
  assert.equal(keys.actionFor('K'), 'keyboard-wizard');

  for (const key of ['h', 'H', '?']) {
    const state = reader();
    await quietly(() => handleBrowseKey(key, state, PAGE));
    assert.equal(state.library.kind, 'info');
    assert.equal(state.title, 'Lynx Help');
    assert.match(state.library.rows[0].text, /Lynx Help/);
    await quietly(() => handleLibraryKey('\x1b[D', state, PAGE));
    assert.equal(state.mode, 'browse');
  }
});

test('m and M return to the Lynx main screen', async () => {
  for (const key of ['m', 'M']) {
    const state = reader();
    state.homeUrl = 'https://home.test/';
    let loaded = null;
    state.loadAddress = async (receivedState, page, url) => {
      assert.equal(receivedState, state);
      loaded = url;
    };
    await quietly(() => handleBrowseKey(key, state, { url: () => 'https://page.test/' }));
    assert.equal(loaded, 'https://home.test/');
  }
});

test('main menu does not reload the main screen', async () => {
  const state = reader();
  state.homeUrl = 'https://home.test/';
  state.loadAddress = async () => assert.fail('already-home main screen was reloaded');
  await quietly(() => openMainMenu(state, { url: () => 'https://home.test/' }));
  assert.equal(state.statusMsg, 'You are already at the main screen.');
});

test('help and main-menu actions remain unbound in the default interface', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.notEqual(keys.actionFor('h'), 'help');
  assert.notEqual(keys.actionFor('m'), 'main-menu');
  assert.equal(keys.byId.get('help').bindings.length, 0);
  assert.equal(keys.byId.get('main-menu').bindings.length, 0);
});
