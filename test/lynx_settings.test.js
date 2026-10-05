'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const {
  lynxSettingsPath, readLynxSettings, writeLynxSettings,
} = require('../src/lynx_settings');
const { keymapForOptions } = require('../src/index');
const { lynxPreferences } = require('../src/lynx_state');

test('Lynx settings have their own XDG file and a missing file is optional', () => {
  const home = tempDir('tawb-lynx-settings-home-');
  assert.equal(
    lynxSettingsPath({ XDG_CONFIG_HOME: '/tmp/my-config' }, home),
    path.join('/tmp/my-config', 'tawb', 'settings.lynx.json'),
  );
  assert.deepEqual(readLynxSettings({ env: {}, home }), {});
});

test('Lynx settings are written atomically under a lynx key', () => {
  const directory = tempDir('tawb-lynx-settings-');
  const file = path.join(directory, 'settings.lynx.json');
  writeLynxSettings({
    showCursor: true,
    keypadMode: 'LINKS_ARE_NUMBERED',
    searchCase: 'CASE_SENSITIVE',
  }, { file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    version: 1,
    lynx: {
      showCursor: true,
      keypadMode: 'LINKS_ARE_NUMBERED',
      searchCase: 'CASE_SENSITIVE',
    },
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readLynxSettings({ file }), {
    showCursor: true,
    keypadMode: 'LINKS_ARE_NUMBERED',
    searchCase: 'CASE_SENSITIVE',
  });
});

test('a Lynx setting outside the lynx key is an error', () => {
  const directory = tempDir('tawb-lynx-settings-global-');
  const file = path.join(directory, 'settings.lynx.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, showCursor: true, lynx: {} }));
  assert.throws(() => readLynxSettings({ file }),
    /settings must be under the lynx key \(found showCursor\)/);
});

test('malformed, unknown, and invalid Lynx settings name their file', () => {
  const directory = tempDir('tawb-lynx-settings-bad-');
  const file = path.join(directory, 'settings.lynx.json');
  for (const [document, message] of [
    ['{', /JSON|property name|position/i],
    [{ version: 1, lynx: { browser: 'firefox' } }, /unknown lynx setting browser/],
    [{ version: 1, lynx: { showCursor: 'yes' } }, /showCursor must be true or false/],
    [{ version: 1, lynx: { keypadMode: 'MOUSE' } }, /invalid keypadMode MOUSE/],
  ]) {
    fs.writeFileSync(file, typeof document === 'string' ? document : JSON.stringify(document));
    assert.throws(() => readLynxSettings({ file }),
      (err) => err.message.includes(file) && message.test(err.message));
  }
});

test('the first Lynx run imports the config and writes our files', () => {
  const dir = tempDir('tawb-lynx-first-');
  const keysFile = path.join(dir, 'keys-lynx.json');
  let imported = 0;
  let written = null;
  const importLynx = () => {
    imported += 1;
    return {
      available: true,
      bindings: { 'confirm-quit': ['x'] },
      unsupported: ['SHELL'],
      preferences: {
        showCursor: false, keypadMode: 'NUMBERS_AS_ARROWS',
        numberLinks: false, numberFields: false, searchCase: 'CASE_INSENSITIVE',
      },
    };
  };
  // A preference the reader already saved in TAWB wins over the import; the
  // import supplies everything they have not chosen.
  const readLynx = () => ({
    showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE',
  });

  const lynx = keymapForOptions({ frontEnd: 'lynx' }, {
    importLynx, readLynx, keysFile, hasKeys: () => false,
    writeLynx: (settings) => { written = settings; },
  });

  assert.equal(imported, 1);
  assert.equal(lynx.actionFor('x'), 'confirm-quit');
  assert.deepEqual(lynx.unsupported, ['SHELL']);
  assert.equal(lynx.preferences.showCursor, true, 'the saved preference did not win');
  assert.equal(lynx.preferences.numberLinks, true, 'the keypad mode did not derive numbering');
  assert.ok(fs.existsSync(keysFile), 'the imported keymap was not written');
  assert.deepEqual(written, {
    showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE',
  });
});

test('a later Lynx run reads our files and never runs Lynx', () => {
  const dir = tempDir('tawb-lynx-later-');
  const keysFile = path.join(dir, 'keys-lynx.json');
  fs.writeFileSync(keysFile, JSON.stringify({ version: 2, functions: {} }));
  let imported = 0;
  let settingsReads = 0;

  const lynx = keymapForOptions({ frontEnd: 'lynx' }, {
    importLynx: () => { imported += 1; throw new Error('Lynx must not be run'); },
    readLynx: () => { settingsReads += 1; return { showCursor: true }; },
    keysFile, hasKeys: () => true,
    writeLynx: () => { throw new Error('nothing should be written'); },
  });

  assert.equal(imported, 0, 'Lynx was run after the first import');
  assert.equal(settingsReads, 1);
  assert.equal(lynx.preferences.showCursor, true);
  assert.equal(lynx.preferences.keypadMode, 'NUMBERS_AS_ARROWS', 'the Lynx default was not the base');

  // The ordinary front end never opens the Lynx settings at all.
  keymapForOptions({ frontEnd: 'default' }, { readLynx: () => { throw new Error('not ours'); } });
});

test('--lynx-reimport overwrites our copy with the Lynx side', () => {
  const dir = tempDir('tawb-lynx-reimport-');
  const keysFile = path.join(dir, 'keys-lynx.json');
  fs.writeFileSync(keysFile, JSON.stringify({ version: 2, functions: { QUIT: ['z'] } }));
  let written = null;
  const importLynx = () => ({
    available: true,
    bindings: { 'confirm-quit': ['x'] },
    unsupported: [],
    preferences: { showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE' },
  });
  // What TAWB had saved before the reimport.
  const readLynx = () => ({ showCursor: false, keypadMode: 'NUMBERS_AS_ARROWS' });

  const lynx = keymapForOptions({ frontEnd: 'lynx', lynxReimport: true }, {
    importLynx, readLynx, keysFile, hasKeys: () => true,
    writeLynx: (settings) => { written = settings; },
  });

  // The old snapshot is not loaded over the import: x is the new binding, so
  // the previous file cannot have won.
  assert.equal(lynx.actionFor('x'), 'confirm-quit');
  assert.equal(lynx.preferences.showCursor, true, 'the import did not win after a reimport');
  assert.equal(written.showCursor, true);
  assert.equal(written.keypadMode, 'LINKS_ARE_NUMBERED');
  const saved = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  assert.ok(Object.values(saved.functions).some((bindings) => bindings.includes('x')),
    'the reimported map was not written');
});

test('the dump reads preferences without importing or writing', () => {
  // lynxPreferences has no import or write seam at all, which is the point:
  // a text filter must not run Lynx or rewrite configuration.
  const preferences = lynxPreferences({
    readLynx: () => ({ showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED' }),
  });
  assert.equal(preferences.showCursor, true);
  assert.equal(preferences.numberLinks, true, 'the saved keypad mode did not derive numbering');
  assert.equal(preferences.numberFields, false);
  assert.equal(preferences.searchCase, 'CASE_INSENSITIVE', 'the Lynx default was not the base');
});

test('a Lynx import that found nothing writes no files', () => {
  const dir = tempDir('tawb-lynx-missing-');
  const keysFile = path.join(dir, 'keys-lynx.json');
  let wroteSettings = 0;

  const lynx = keymapForOptions({ frontEnd: 'lynx' }, {
    importLynx: () => ({ available: false, bindings: {}, unsupported: [], preferences: {} }),
    readLynx: () => ({}), keysFile, hasKeys: () => false,
    writeLynx: () => { wroteSettings += 1; },
  });

  assert.equal(fs.existsSync(keysFile), false, 'a fallback map was frozen to disk');
  assert.equal(wroteSettings, 0);
  assert.equal(lynx.actionFor('q'), 'confirm-quit', 'the built-in Lynx map was not used');
});
