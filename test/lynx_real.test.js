'use strict';

// The adapter against the real Lynx binary.
//
// The unit tests drive parseBrowseMap and parsePreferences with captured
// output. This file drives readLynxConfig end to end, so the one thing they
// cannot check is checked here: that asking an installed Lynx for its
// effective maps, with a customized configuration, really does return the
// bindings and interaction preferences that configuration asked for —
// including the vi and Emacs key tables, which Lynx selects at startup rather
// than storing as ordinary settings.
//
// Skipped, not failed, when Lynx is not installed: the adapter's fallback for
// that case is covered separately.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('./tmpdir');
const { readLynxConfig } = require('../src/lynx_config');

function lynxIsInstalled() {
  const result = spawnSync('lynx', ['-version'], {
    stdio: ['ignore', 'ignore', 'ignore'], timeout: 3000,
  });
  return !result.error && result.status === 0;
}

const available = lynxIsInstalled();
const skip = available ? false : 'the lynx binary is not installed';
const home = available ? tempDir('tawb-real-lynx-') : null;

test.after(() => { if (home) removeTempDir(home); });

function configFile(name, text) {
  const file = path.join(home, name);
  fs.writeFileSync(file, text);
  return file;
}

// A clean HOME keeps a personal .lynxrc out of the answer; LYNX_CFG selects
// the configuration under test, exactly as --lynx-config does.
function imported(config = null) {
  return readLynxConfig({ executable: 'lynx', config, env: { HOME: home } });
}

test('an installed Lynx supplies its stock key bindings', { skip }, () => {
  const result = imported();
  assert.equal(result.available, true);
  assert.ok(result.bindings.quit.includes('q'), 'q quits');
  assert.ok(result.bindings.goto.includes('g'), 'g goes to an address');
  assert.ok(result.bindings['history-back'].includes('ArrowLeft'), 'Left goes back');
  assert.ok(result.bindings.activate.includes('Enter'), 'Enter activates');
  assert.ok(result.bindings['next-focusable'].includes('ArrowDown'), 'Down moves on');
  assert.ok(result.bindings['list-links'].includes('l'), 'l lists references');
  assert.ok(result.bindings['document-info'].includes('='), '= shows information');
});

test('vi movement keys come through a customized configuration', { skip }, () => {
  const result = imported(configFile('vi.cfg', 'VI_KEYS_ALWAYS_ON:TRUE\n'));
  assert.equal(result.available, true);
  assert.ok(result.bindings['history-back'].includes('h'), 'h goes back in vi');
  assert.ok(result.bindings['next-focusable'].includes('j'), 'j is the next link');
  assert.ok(result.bindings['previous-focusable'].includes('k'), 'k is the previous link');
  assert.ok(result.bindings.activate.includes('l'), 'l activates in vi');
  assert.ok(result.bindings['list-links'].includes('L'), 'L lists references in vi');
});

test('Emacs movement keys come through a customized configuration', { skip }, () => {
  const result = imported(configFile('emacs.cfg', 'EMACS_KEYS_ALWAYS_ON:TRUE\n'));
  assert.equal(result.available, true);
  assert.ok(result.bindings['history-back'].includes('Ctrl+B'), 'Ctrl+B goes back');
  assert.ok(result.bindings.activate.includes('Ctrl+F'), 'Ctrl+F activates');
  assert.ok(result.bindings['next-focusable'].includes('Ctrl+N'), 'Ctrl+N is the next link');
  assert.ok(result.bindings['previous-focusable'].includes('Ctrl+P'), 'Ctrl+P is the previous link');
});

test('numbering and text-field settings follow the configuration', { skip }, () => {
  const result = imported(configFile('numbered.cfg', [
    'DEFAULT_KEYPAD_MODE:LINKS_AND_FORM_FIELDS_ARE_NUMBERED',
    'NUMBER_LINKS_ON_LEFT:FALSE',
    'NUMBER_FIELDS_ON_LEFT:FALSE',
    'TEXTFIELDS_NEED_ACTIVATION:TRUE',
  ].join('\n') + '\n'));
  assert.equal(result.preferences.keypadMode, 'LINKS_AND_FIELDS_ARE_NUMBERED');
  assert.equal(result.preferences.numberLinks, true);
  assert.equal(result.preferences.numberFields, true);
  assert.equal(result.preferences.numberLinksOnLeft, false);
  assert.equal(result.preferences.numberFieldsOnLeft, false);
  assert.equal(result.preferences.textfieldsNeedActivation, true);
});

test('a custom KEYMAP is imported and an unsupported function is reported', { skip }, () => {
  const result = imported(configFile('custom.cfg', 'KEYMAP:x:QUIT\nKEYMAP:^X:SHELL\n'));
  assert.equal(result.available, true);
  assert.ok(result.bindings.quit.includes('x'), 'the remapped quit key arrived');
  assert.ok(result.unsupported.includes('SHELL'), 'the shell escape was reported, not bound');
  const bound = Object.values(result.bindings).flat();
  assert.ok(!bound.includes('Ctrl+X'), 'an unsupported function is never assigned to a key');
});

test('a configuration Lynx refuses falls back to the built-in defaults', { skip }, () => {
  const result = imported(path.join(home, 'does-not-exist.cfg'));
  assert.equal(result.available, false);
  assert.deepEqual(result.bindings, {});
  assert.equal(result.preferences.keypadMode, 'NUMBERS_AS_ARROWS');
});
