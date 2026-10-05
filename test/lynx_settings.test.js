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

test('saved Lynx settings override imported preferences only in Lynx mode', () => {
  let imported = 0;
  let settingsReads = 0;
  const importLynx = () => {
    imported += 1;
    return {
      bindings: {}, unsupported: [],
      preferences: {
        showCursor: false, keypadMode: 'NUMBERS_AS_ARROWS',
        numberLinks: false, numberFields: false,
      },
    };
  };
  const readSettings = () => {
    settingsReads += 1;
    return {
      showCursor: true, searchCase: 'CASE_SENSITIVE', keypadMode: 'LINKS_ARE_NUMBERED',
    };
  };
  const lynx = keymapForOptions({ frontEnd: 'lynx' }, { importLynx, readLynx: readSettings });
  assert.deepEqual(lynx.preferences, {
    showCursor: true,
    keypadMode: 'LINKS_ARE_NUMBERED',
    numberLinks: true,
    numberFields: false,
    searchCase: 'CASE_SENSITIVE',
  });

  const ordinary = keymapForOptions({ frontEnd: 'default' }, { importLynx, readLynx: readSettings });
  assert.deepEqual(ordinary.preferences, {});
  assert.equal(imported, 1);
  assert.equal(settingsReads, 1, 'the default interface never opens settings.lynx.json');
});
