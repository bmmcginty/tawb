'use strict';

// TAWB's Lynx state — the import-once keymap and preference policy —
// differenced between the JavaScript original and the Crystal port. The same
// injected imports, saved settings, key files, and reimport requests must
// produce the same map, the same preferences, and the same writes, or leave
// the files alone when Lynx had nothing to say.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { lynxStateImplementations } = require('./crystal_impl');

const implementations = lynxStateImplementations(require('../src/lynx_state'));

const FIRST_IMPORT = {
  available: true,
  bindings: { 'confirm-quit': ['x'] },
  unsupported: ['SHELL'],
  preferences: {
    showCursor: false, keypadMode: 'NUMBERS_AS_ARROWS',
    numberLinks: false, numberFields: false, searchCase: 'CASE_INSENSITIVE',
  },
};

for (const implementation of implementations) {
  test(`${implementation.name}: the first Lynx run imports the config and writes our files`, () => {
    const dir = tempDir(`tawb-lynx-first-${implementation.name}-`);
    const keysFile = path.join(dir, 'keys-lynx.json');
    // A preference the reader already saved in TAWB wins over the import; the
    // import supplies everything they have not chosen.
    const result = implementation.keymap({
      keysFile,
      hasKeys: false,
      import: FIRST_IMPORT,
      readLynx: { showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE' },
      probe: ['x'],
    });

    assert.equal(result.imported, 1);
    assert.equal(result.actions.x, 'confirm-quit');
    assert.deepEqual(result.unsupported, ['SHELL']);
    assert.equal(result.preferences.showCursor, true, 'the saved preference did not win');
    assert.equal(result.preferences.numberLinks, true, 'the keypad mode did not derive numbering');
    assert.equal(result.keysFileExists, true, 'the imported keymap was not written');
    assert.deepEqual(result.written, [
      { showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE' },
    ]);
  });

  test(`${implementation.name}: a later Lynx run reads our files and never runs Lynx`, () => {
    const dir = tempDir(`tawb-lynx-later-${implementation.name}-`);
    const keysFile = path.join(dir, 'keys-lynx.json');
    fs.writeFileSync(keysFile, JSON.stringify({ version: 2, functions: {} }));

    const result = implementation.keymap({
      keysFile,
      hasKeys: true,
      readLynx: { showCursor: true },
      probe: [],
    });

    assert.equal(result.imported, 0, 'Lynx was run after the first import');
    assert.equal(result.reads, 1);
    assert.deepEqual(result.written, [], 'nothing should be written');
    assert.equal(result.preferences.showCursor, true);
    assert.equal(result.preferences.keypadMode, 'NUMBERS_AS_ARROWS', 'the Lynx default was not the base');
  });

  test(`${implementation.name}: --lynx-reimport overwrites our copy with the Lynx side`, () => {
    const dir = tempDir(`tawb-lynx-reimport-${implementation.name}-`);
    const keysFile = path.join(dir, 'keys-lynx.json');
    fs.writeFileSync(keysFile, JSON.stringify({ version: 2, functions: { QUIT: ['z'] } }));
    // What TAWB had saved before the reimport.
    const result = implementation.keymap({
      keysFile,
      hasKeys: true,
      lynxReimport: true,
      import: {
        available: true,
        bindings: { 'confirm-quit': ['x'] },
        unsupported: [],
        preferences: { showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED', searchCase: 'CASE_SENSITIVE' },
      },
      readLynx: { showCursor: false, keypadMode: 'NUMBERS_AS_ARROWS' },
      probe: ['x'],
    });

    // The old snapshot is not loaded over the import: x is the new binding,
    // so the previous file cannot have won.
    assert.equal(result.actions.x, 'confirm-quit');
    assert.equal(result.preferences.showCursor, true, 'the import did not win after a reimport');
    assert.equal(result.written[0].showCursor, true);
    assert.equal(result.written[0].keypadMode, 'LINKS_ARE_NUMBERED');
    const saved = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    assert.ok(Object.values(saved.functions).some((bindings) => bindings.includes('x')),
      'the reimported map was not written');
  });

  test(`${implementation.name}: the dump reads preferences without importing or writing`, () => {
    // lynxPreferences has no import or write seam at all, which is the point:
    // a text filter must not run Lynx or rewrite configuration.
    const result = implementation.preferences({
      readLynx: { showCursor: true, keypadMode: 'LINKS_ARE_NUMBERED' },
    });
    assert.equal(result.preferences.showCursor, true);
    assert.equal(result.preferences.numberLinks, true, 'the saved keypad mode did not derive numbering');
    assert.equal(result.preferences.numberFields, false);
    assert.equal(result.preferences.searchCase, 'CASE_INSENSITIVE', 'the Lynx default was not the base');
  });

  test(`${implementation.name}: a Lynx import that found nothing writes no files`, () => {
    const dir = tempDir(`tawb-lynx-missing-${implementation.name}-`);
    const keysFile = path.join(dir, 'keys-lynx.json');

    const result = implementation.keymap({
      keysFile,
      hasKeys: false,
      import: { available: false, bindings: {}, unsupported: [], preferences: {} },
      readLynx: {},
      probe: ['q'],
    });

    assert.equal(result.keysFileExists, false, 'a fallback map was frozen to disk');
    assert.deepEqual(result.written, []);
    assert.equal(result.actions.q, 'confirm-quit', 'the built-in Lynx map was not used');
  });
}
