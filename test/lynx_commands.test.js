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

// A prompt takes the keyboard for itself; here it is fed from an array.
function keyboard(keys) {
  const queue = [...keys];
  return {
    claim() { return 'token'; },
    release() {},
    async next() {
      if (!queue.length) throw new Error('the prompt asked for a key nobody pressed');
      return queue.shift();
    },
  };
}

test('Q aborts at once, and q asks before quitting', async () => {
  const aborted = reader();
  assert.equal(await quietly(() => handleBrowseKey('Q', aborted, PAGE)), 'quit',
    'ABORT asked a question it should not have');

  const yes = reader();
  yes.keyReader = keyboard(['y']);
  assert.equal(await quietly(() => handleBrowseKey('q', yes, PAGE)), 'quit');

  const no = reader();
  no.keyReader = keyboard(['n']);
  assert.equal(await quietly(() => handleBrowseKey('q', no, PAGE)), undefined,
    'a refused QUIT left the browser anyway');
});

test("E opens the address bar with the link's own address", async () => {
  const state = reader();
  state.core.blocks = [{
    text: '{Alpha}',
    item: { role: 'link', name: 'Alpha', href: 'https://example.test/a' },
  }];
  state.lines = [{ blockIndex: 0, text: 'Alpha' }];
  await quietly(() => handleBrowseKey('E', state, PAGE));
  assert.equal(state.mode, 'address');
  assert.equal(state.address.text, 'https://example.test/a');
});

test('F1 describes the control under the cursor', async () => {
  const state = reader();
  state.core.blocks = [{
    text: '{Alpha}',
    item: { role: 'link', name: 'Alpha', href: 'https://example.test/a' },
  }];
  state.lines = [{ blockIndex: 0, text: 'Alpha' }];
  await quietly(() => handleBrowseKey('\x1bOP', state, PAGE));
  assert.match(state.statusMsg, /Alpha — link — goes to https:\/\/example\.test\/a/);
  assert.match(state.statusMsg, /Enter activates it/);
});

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
    const help = state.library.rows.map((row) => row.text).join('\n');
    assert.match(help, /\^ \/ \$: first \/ last/);
    assert.match(help, /r removes the selected bookmark/);
    assert.match(help, /x: reload without cache/);
    assert.match(help, /Ctrl\+T: toggle tracing/);
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

test('caret and dollar move to the first and last browser-backed controls', async () => {
  const state = reader();
  state.core.blocks = [
    { text: 'before', item: { role: 'text', name: 'before' } },
    { text: 'First', item: { role: 'link', name: 'First' } },
    { text: 'middle', item: { role: 'text', name: 'middle' } },
    { text: 'Last', item: { role: 'textbox', name: 'Last' } },
  ];
  state.lines = [
    { text: 'before First', blockIndex: 0, spans: [
      { blockIndex: 0, start: 0, end: 6 }, { blockIndex: 1, start: 7, end: 12 },
    ] },
    { text: 'middle', blockIndex: 2 },
    { text: 'Last', blockIndex: 3 },
  ];
  state.cursor = 1;
  await quietly(() => handleBrowseKey('^', state, PAGE));
  assert.equal(state.cursor, 0);
  assert.equal(state.col, 7);
  await quietly(() => handleBrowseKey('$', state, PAGE));
  assert.equal(state.cursor, 2);
  assert.equal(state.col, 0);
});

test('first and last link commands report a document with no controls', async () => {
  const state = reader();
  await quietly(() => handleBrowseKey('^', state, PAGE));
  assert.equal(state.statusMsg, 'No links or form controls in this document.');
});

test('main menu does not reload the main screen', async () => {
  const state = reader();
  state.homeUrl = 'https://home.test/';
  state.loadAddress = async () => assert.fail('already-home main screen was reloaded');
  await quietly(() => openMainMenu(state, { url: () => 'https://home.test/' }));
  assert.equal(state.statusMsg, 'You are already at the main screen.');
});

test('the Lynx keyboard\'s own extensions stay off the letters Lynx uses', () => {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  // The extensions TAWB needs and Lynx has no function for live on control
  // keys Lynx never binds, so a reader's own KEYMAP cannot be shadowed by one.
  assert.equal(keys.actionFor('\x0f'), 'cycle-view');
  assert.equal(keys.actionFor('\x1c'), 'page-keyboard');
  assert.equal(keys.actionFor('\x19'), 'real-click');
  assert.equal(keys.actionFor('\x1d'), 'hover-line');
  assert.equal(keys.actionFor('\x1f'), 'browser-question');
  // Tabs are a browser idea Lynx has none of, and no Lynx-free key is worth
  // spending on them by default. They are bindable, not bound.
  for (const id of ['new-tab', 'next-tab', 'previous-tab', 'close-tab']) {
    assert.ok(keys.byId.get(id), `${id} is not offered by the Lynx wizard`);
    assert.deepEqual(keys.byId.get(id).bindings, [], `${id} is bound by default`);
  }
  // < and > are UP_LINK and DOWN_LINK in Lynx, so no extension may sit there.
  assert.equal(keys.actionFor('<'), 'up-link');
  assert.equal(keys.actionFor('>'), 'down-link');
});

test('the default interface has none of the Lynx-only actions at all', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  for (const id of ['help', 'main-menu', 'options', 'document-info', 'list-links']) {
    assert.equal(keys.byId.get(id), undefined, id);
  }
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  for (const id of ['help', 'main-menu', 'options', 'document-info', 'list-links']) {
    assert.ok(lynx.byId.get(id), id);
  }
});
