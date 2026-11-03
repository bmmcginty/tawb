'use strict';

// `:` is the escape hatch for an action that has no usable key: it opens the
// same names the keyboard wizard lists, completes them with Tab, and dispatches
// the chosen action through the browse map.

const test = require('node:test');
const assert = require('node:assert');

const index = require('../src/index');
const { Keymap } = require('../src/keys');

const PAGE_URL = 'https://example.test/page.html';
const BLOCKS = [
  { text: '[First]', item: { role: 'button', name: 'First' } },
  { text: '[Second]', item: { role: 'button', name: 'Second' } },
];
const page = { url: () => PAGE_URL };

function stateFor({ profile = 'default', bindings = {} } = {}) {
  return {
    rows: 24, cols: 80, mode: 'browse', interface: profile,
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines: BLOCKS.map((block, index) => ({ text: block.text, blockIndex: index })),
    core: {
      source: 'ax', blocks: BLOCKS, popup: null, popupAt: -1,
      live: { enabled: true, refreshing: false },
      markInput() {}, inputMarks: 0,
    },
    statusMsg: '', messages: [], drawn: {}, linkAddress: false,
    keys: new Keymap({ terminfo: {}, profile, load: false, bindings }),
    inputSeen: false,
  };
}

async function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

async function type(state, text) {
  for (const chunk of text) await index.handleCommandKey(chunk, state, page);
}

test('a colon opens the command line under the keyboard-wizard names', async () => {
  const state = stateFor();
  await quietly(() => index.handleBrowseKey(':', state, page));
  assert.equal(state.mode, 'command');
  assert.deepEqual(state.line, { label: 'Command', buffer: { text: '', caret: 0 } });
  assert.match(state.drawn.hint, /Tab: complete/);
});

test('Tab completes a shared prefix or the one matching name', async () => {
  await quietly(async () => {
    const ordinary = stateFor();
    await index.handleBrowseKey(':', ordinary, page);
    await type(ordinary, 'next par');
    await index.handleCommandKey('\t', ordinary, page);
    assert.equal(ordinary.line.buffer.text, 'Next paragraph');

    const lynx = stateFor({ profile: 'lynx' });
    await index.handleBrowseKey(':', lynx, page);
    await type(lynx, 'NEXT_LI');
    await index.handleCommandKey('\t', lynx, page);
    assert.equal(lynx.line.buffer.text, 'NEXT_LINK');
  });
});

test('Enter runs an action whose key was unbound', async () => {
  const state = stateFor({ bindings: { where: [] } });
  assert.equal(state.keys.actionFor('='), null);
  await quietly(async () => {
    await index.handleBrowseKey(':', state, page);
    await type(state, 'Report position');
    await index.handleCommandKey('\r', state, page);
  });
  assert.equal(state.mode, 'browse');
  assert.equal(state.line, null);
  assert.equal(state.statusMsg, 'line 2/2, column 1 — button.');
});

test('a name that only matches by prefix asks for more instead of running', async () => {
  const state = stateFor();
  await quietly(async () => {
    await index.handleBrowseKey(':', state, page);
    await type(state, 'Next ');
    await index.handleCommandKey('\r', state, page);
  });
  assert.equal(state.mode, 'command');
  assert.match(state.commandNote, /^Matches: /);
});
