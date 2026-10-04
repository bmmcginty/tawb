'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VERSION = 1;
const KEYPAD_MODES = new Set([
  'NUMBERS_AS_ARROWS',
  'LINKS_ARE_NUMBERED',
  'FIELDS_ARE_NUMBERED',
  'LINKS_AND_FIELDS_ARE_NUMBERED',
]);
const SEARCH_CASES = new Set(['CASE_INSENSITIVE', 'CASE_SENSITIVE']);
const BOOLEAN_SETTINGS = new Set([
  'numberLinksOnLeft',
  'numberFieldsOnLeft',
  'textfieldsNeedActivation',
  'showCursor',
]);
const KNOWN_SETTINGS = new Set([
  'keypadMode',
  'searchCase',
  ...BOOLEAN_SETTINGS,
]);

function lynxSettingsPath(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'tawb', 'settings.lynx.json');
}

function validateLynxSettings(parsed, file) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('the root must be an object');
  }
  const misplaced = Object.keys(parsed).filter((key) => !['version', 'lynx'].includes(key));
  if (misplaced.length) {
    throw new Error(`settings must be under the lynx key (found ${misplaced.join(', ')})`);
  }
  if (parsed.version !== VERSION) throw new Error(`version must be ${VERSION}`);
  if (!parsed.lynx || Array.isArray(parsed.lynx) || typeof parsed.lynx !== 'object') {
    throw new Error('lynx must be an object');
  }

  const settings = {};
  for (const [name, value] of Object.entries(parsed.lynx)) {
    if (!KNOWN_SETTINGS.has(name)) throw new Error(`unknown lynx setting ${name}`);
    if (BOOLEAN_SETTINGS.has(name)) {
      if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
    } else if (name === 'keypadMode' && !KEYPAD_MODES.has(value)) {
      throw new Error(`invalid keypadMode ${value}`);
    } else if (name === 'searchCase' && !SEARCH_CASES.has(value)) {
      throw new Error(`invalid searchCase ${value}`);
    }
    settings[name] = value;
  }
  return settings;
}

function mergeLynxSettings(imported, saved) {
  const preferences = { ...(imported || {}), ...(saved || {}) };
  if (saved && Object.hasOwn(saved, 'keypadMode')) {
    preferences.numberLinks = saved.keypadMode === 'LINKS_ARE_NUMBERED'
      || saved.keypadMode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
    preferences.numberFields = saved.keypadMode === 'FIELDS_ARE_NUMBERED'
      || saved.keypadMode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
  }
  return preferences;
}

function readLynxSettings({ env = process.env, home = os.homedir(), file = null } = {}) {
  const target = file || lynxSettingsPath(env, home);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return validateLynxSettings(JSON.parse(text), target);
  } catch (err) {
    throw new Error(`Cannot read Lynx settings from ${target}: ${err.message}`);
  }
}

function writeLynxSettings(settings, {
  env = process.env, home = os.homedir(), file = null,
} = {}) {
  const target = file || lynxSettingsPath(env, home);
  // Validate the exact object which will be written. Besides guarding bad
  // values, this makes it impossible for a caller to move one of these
  // settings out of the Lynx namespace by accident.
  const document = { version: VERSION, lynx: { ...settings } };
  validateLynxSettings(document, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

module.exports = {
  VERSION, KEYPAD_MODES, SEARCH_CASES, BOOLEAN_SETTINGS, KNOWN_SETTINGS,
  lynxSettingsPath, validateLynxSettings, mergeLynxSettings,
  readLynxSettings, writeLynxSettings,
};
