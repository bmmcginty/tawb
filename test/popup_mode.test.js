'use strict';

// An open popup is a mode of its own.
//
// A menu the page drew lives in the buffer like any other text, so the browse
// map would read q as quit and leave the program while the reader meant to
// shut the menu they are standing in. The mode takes the closing keys before
// the browse map, and only those: movement and activation still fall through,
// and Ctrl+C can never be swallowed.

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const { handleBrowseKey, popupIsOpen, popupKey, hintText } = require('../src/index');

const PAGE = { url: () => 'https://example.test/', title: async () => 'Example' };

function reader({ interface: iface = 'default', popup = true } = {}) {
  const keys = new Keymap({ terminfo: {}, load: false, profile: iface });
  const blocks = [
    { text: '[*Account]', item: { name: 'Account', controls: 'menu' } },
    { text: 'page text', item: { name: 'page text', role: 'text' } },
    { text: '[*Profile]', item: { name: 'Profile', popup: 'menu' } },
    { text: '[*Sign out]', item: { name: 'Sign out', popup: 'menu' } },
  ];
  const state = {
    interface: iface,
    keys,
    mode: 'browse',
    library: null,
    dialog: null,
    lines: [],
    cursor: 2,
    col: 0,
    scroll: 0,
    title: 'Example',
    statusMsg: '',
    linkAddress: false,
    drawn: { title: null, address: null, hint: null, status: null },
    core: {
      source: 'ax',
      blocks,
      popup: popup ? { controls: 'menu' } : null,
      at() {},
      markInput() {},
      forgetPopup() { this.popup = null; },
      popupAt() {
        const id = this.popup && this.popup.controls;
        if (!id) return -1;
        return this.blocks.findIndex((block) => block.item && block.item.popup === id);
      },
      async rescan() {},
      activated: [],
      async activate(item) { this.activated.push(item.name); return { status: `Closed ${item.name}` }; },
      live: { refreshing: false },
    },
  };
  return state;
}

async function quietly(run) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await run(); } finally { process.stdout.write = write; }
}

test('the popup keys close it, and only Ctrl+C gets out of the program', () => {
  assert.equal(popupKey({ action: 'close-popup', chunk: '\x1b', contextAction: null }), 'close');
  assert.equal(popupKey({ action: null, chunk: '\x1b[D', contextAction: 'cancel' }), 'close');
  assert.equal(popupKey({ action: 'quit', chunk: 'q', contextAction: null }), 'close');
  assert.equal(popupKey({ action: 'quit', chunk: '\x03', contextAction: null }), 'quit');
  assert.equal(popupKey({ action: 'next-line', chunk: 'j', contextAction: 'next' }), null);
  assert.equal(popupKey({ action: null, chunk: 'x', contextAction: null }), null);
});

test('a popup is open only while the core remembers it and its entries stand', () => {
  const state = reader();
  assert.equal(popupIsOpen(state), true);
  state.core.popup = null;
  assert.equal(popupIsOpen(state), false);
  // The core can remember a control whose entries the page has since closed.
  state.core.popup = { controls: 'gone' };
  assert.equal(popupIsOpen(state), false);
});

test('q closes the open popup instead of quitting the browser', async () => {
  const state = reader();
  const result = await quietly(() => handleBrowseKey('q', state, PAGE));
  assert.equal(result, undefined, 'q quit the browser with a menu open');
  assert.equal(state.core.popup, null);
  assert.deepEqual(state.core.activated, ['Account']);
  assert.match(state.statusMsg, /Closed "Account"/);
});

test('Ctrl+C still leaves the program with a popup open', async () => {
  const state = reader();
  const result = await quietly(() => handleBrowseKey('\x03', state, PAGE));
  assert.equal(result, 'quit');
  assert.notEqual(state.core.popup, null, 'the popup was closed instead of the program left');
});

test('Escape closes the popup, and in the Lynx interface so does Left', async () => {
  const escape = reader();
  await quietly(() => handleBrowseKey('\x1b', escape, PAGE));
  assert.equal(escape.core.popup, null);
  assert.deepEqual(escape.core.activated, ['Account']);

  const lynx = reader({ interface: 'lynx' });
  await quietly(() => handleBrowseKey('\x1b[D', lynx, PAGE));
  assert.equal(lynx.core.popup, null);
  assert.deepEqual(lynx.core.activated, ['Account']);
});

test('movement inside a popup is still movement', async () => {
  const state = reader();
  await quietly(() => handleBrowseKey('k', state, PAGE));
  assert.notEqual(state.core.popup, null, 'movement closed the popup');
  assert.equal(state.core.activated.length, 0);
});

test('with no popup open, q quits exactly as it did', async () => {
  const state = reader({ popup: false });
  assert.equal(await quietly(() => handleBrowseKey('q', state, PAGE)), 'quit');
});

test('the hint says which key closes the popup, in each interface', async () => {
  const ordinary = reader();
  assert.match(hintText(ordinary), /q or Esc closes it/);
  const lynx = reader({ interface: 'lynx' });
  assert.match(hintText(lynx), /q or Left closes it/);
});
