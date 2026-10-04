'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const { getLogPath, disableLog } = require('../src/log');
const { handleBrowseKey, handleLibraryKey } = require('../src/index');

const PAGE = { url: () => 'https://example.test/' };

function reader(directory) {
  return {
    interface: 'lynx', logDir: directory,
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

test('Ctrl+T toggles a private TAWB trace and semicolon displays it', async () => {
  await disableLog();
  const directory = tempDir('tawb-lynx-trace-');
  const state = reader(directory);
  try {
    await quietly(() => handleBrowseKey('\x14', state, PAGE));
    const file = getLogPath();
    assert.ok(file && file.startsWith(directory));
    assert.match(state.statusMsg, /Trace logging on/);

    await quietly(() => handleBrowseKey(';', state, PAGE));
    assert.equal(state.library.label, 'Trace Log');
    assert.ok(state.library.rows.some((row) => row.text.includes('trace.enabled')));
    await quietly(() => handleLibraryKey('\x1b[D', state, PAGE));

    await quietly(() => handleBrowseKey('\x14', state, PAGE));
    assert.equal(getLogPath(), null);
    assert.match(state.statusMsg, /Trace logging off/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    await disableLog();
  }
});

test('semicolon explains when no trace has been started', async () => {
  await disableLog();
  const state = reader(tempDir('tawb-lynx-trace-off-'));
  await quietly(() => handleBrowseKey(';', state, PAGE));
  assert.equal(state.mode, 'browse');
  assert.match(state.statusMsg, /Trace logging is off/);
});

test('trace commands are not bound in the default interface', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.notEqual(keys.actionFor('\x14'), 'toggle-trace');
  assert.notEqual(keys.actionFor(';'), 'trace-log');
});
