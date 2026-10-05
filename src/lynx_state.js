'use strict';

// TAWB's Lynx state: the keymap and the preferences, taken from Lynx once and
// owned afterwards.
//
// The Lynx configuration is read once and then belongs to TAWB. The first Lynx
// run, when there is no keys-lynx.json, imports it and writes our own files;
// every run after that reads ours without running the Lynx binary or opening
// its configuration at all. `--lynx-reimport` asks for the import again and
// overwrites what we hold.
//
// The point is that the reader's Lynx setup is taken deliberately and does not
// move under them between runs. The cost is the one the flag exists for: a
// change to .lynxrc or lynx.cfg is not seen until they ask for it.

const fs = require('node:fs');
const os = require('node:os');

const { Keymap, configPath } = require('./keys');
const { readLynxConfig, DEFAULT_PREFERENCES } = require('./lynx_config');
const {
  readLynxSettings, writeLynxSettings, mergeLynxSettings,
} = require('./lynx_settings');
const { persistableOptions } = require('./lynx_options');

function keysPath() {
  return configPath(process.env, os.homedir(), 'lynx');
}

// The preferences a run needs without running Lynx or writing anything: what
// TAWB already holds, over the built-in defaults. The non-interactive Lynx
// dump uses this, so a text filter never imports a configuration or rewrites
// one. A machine that has only ever dumped a page therefore gets the Lynx
// defaults until an interactive run does the one import.
function lynxPreferences({ readLynx = readLynxSettings } = {}) {
  return mergeLynxSettings(DEFAULT_PREFERENCES, readLynx());
}

function lynxKeymapFor(options, {
  importLynx = readLynxConfig, readLynx = readLynxSettings,
  writeLynx = writeLynxSettings, keysFile = null, hasKeys = fs.existsSync,
} = {}) {
  const file = keysFile || keysPath();
  const saved = readLynx();
  if (!options.lynxReimport && hasKeys(file)) {
    // Ours, and only ours: Lynx is not run and its files are not opened.
    return new Keymap({
      profile: 'lynx', file, preferences: mergeLynxSettings(DEFAULT_PREFERENCES, saved),
    });
  }

  const imported = importLynx({
    executable: options.lynxExecutable, config: options.lynxConfig,
  });
  const preferences = options.lynxReimport
    ? mergeLynxSettings(imported.preferences, {})
    : mergeLynxSettings(imported.preferences, saved);

  // Nothing to write when Lynx could not be read: leaving keys-lynx.json
  // absent means a later run, after Lynx is installed, imports for real rather
  // than reading a file frozen from the built-in fallback map.
  if (imported.available === false) {
    return new Keymap({
      profile: 'lynx', file, load: false,
      bindings: {}, unsupported: imported.unsupported, preferences,
    });
  }

  // A first run keeps any preferences already saved in TAWB, as they are the
  // reader's own choice; a reimport overwrites them, which is what asking for
  // one means. The map is written from the import, not loaded over, so a
  // reimport replaces an earlier snapshot instead of merging with it.
  const keymap = new Keymap({
    profile: 'lynx', file, load: false,
    bindings: imported.bindings, unsupported: imported.unsupported, preferences,
  });
  keymap.save();
  writeLynx(persistableOptions(preferences));
  return keymap;
}

module.exports = { lynxKeymapFor, lynxPreferences };
