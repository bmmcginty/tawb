'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BROWSE_FUNCTIONS = {
  QUIT: 'quit', ABORT: 'quit',
  GOTO: 'goto', ELGOTO: 'location-edit', ECGOTO: 'location-edit',
  PREV_DOC: 'history-back', NEXT_DOC: 'history-forward',
  ACTIVATE: 'activate',
  DOWN_TWO: 'next-line', UP_TWO: 'previous-line',
  NEXT_PAGE: 'next-screen', DOWN_HALF: 'next-screen',
  PREV_PAGE: 'previous-screen', UP_HALF: 'previous-screen',
  HOME: 'top', END: 'bottom',
  ADD_BOOKMARK: 'add-bookmark', DEL_BOOKMARK: 'delete-bookmark', VIEW_BOOKMARK: 'bookmarks',
  VLINKS: 'history', HISTORY: 'history', DOWNLOAD: 'download-link',
  LIST: 'list-links', ADDRLIST: 'list-addresses',
  INFO: 'document-info', OPTIONS: 'options', F_LINK_NUM: 'link-number',
  WHEREIS: 'find-forward', NEXT: 'repeat-find-forward', PREV: 'repeat-find-backward',
  REFRESH: 'refresh', RELOAD: 'reload-page', NOCACHE: 'reload-no-cache', INTERRUPT: 'interrupt',
  TRACE_TOGGLE: 'toggle-trace', TRACE_LOG: 'trace-log',
  SOURCE: 'source-view', KEYMAP: 'keyboard-wizard', HELP: 'help', DWIMHELP: 'help',
  MAIN_MENU: 'main-menu',
  NEXT_LINK: 'next-focusable', FASTFORW_LINK: 'fast-forward-link', DOWN_LINK: 'down-link',
  PREV_LINK: 'previous-focusable', FASTBACKW_LINK: 'fast-backward-link', UP_LINK: 'up-link',
  DOWN_HALF: 'next-half-screen', UP_HALF: 'previous-half-screen',
  FIRST_LINK: 'first-focusable', LAST_LINK: 'last-focusable',
};

const EDIT_FUNCTIONS = {
  BOL: 'edit-line-start', EOL: 'edit-line-end',
  BACK: 'edit-previous-character', FORW: 'edit-next-character',
  DELP: 'edit-backspace', DELN: 'edit-delete',
  BACKW: 'edit-previous-word', FORWW: 'edit-next-word',
  DELPW: 'edit-backspace-word', DELNW: 'edit-delete-word',
  ERASE: 'edit-kill-start', DELEL: 'edit-kill-end', LKCMD: 'edit-command',
};

const KEY_NAMES = {
  '<tab>': 'Tab', '<return>': 'Enter', '<space>': 'Space', '<delete>': 'Backspace',
  'Up Arrow': 'ArrowUp', 'Down Arrow': 'ArrowDown',
  'Left Arrow': 'ArrowLeft', 'Right Arrow': 'ArrowRight',
  'Page Up': 'PageUp', 'Page Down': 'PageDown',
  Home: 'Home', End: 'End', 'Back Tab': 'Shift+Tab',
};

function lynxKeySpec(text) {
  const key = String(text).trim();
  if (KEY_NAMES[key]) return KEY_NAMES[key];
  const control = /^\^(.)$/.exec(key);
  if (control) return `Ctrl+${control[1]}`;
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key;
  return [...key].length === 1 ? key : null;
}

function addBinding(bindings, action, key) {
  if (!action || !key) return;
  if (!bindings[action]) bindings[action] = [];
  if (!bindings[action].includes(key)) bindings[action].push(key);
}

function emptyBindings(functions) {
  return Object.fromEntries([...new Set(Object.values(functions))].map((action) => [action, []]));
}

function parseBrowseMap(text) {
  const bindings = emptyBindings(BROWSE_FUNCTIONS);
  const unsupported = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^(.{12})([A-Z][A-Z0-9_]*)\s/.exec(line);
    if (!match) continue;
    const key = lynxKeySpec(match[1]);
    const fn = match[2];
    if (!key) continue;
    const action = BROWSE_FUNCTIONS[fn];
    if (action) addBinding(bindings, action, key);
    else unsupported.add(fn);
  }
  return { bindings, unsupported: [...unsupported].sort() };
}

function splitEditKeys(text) {
  return String(text).split(',').map((key) => key.trim()).filter(Boolean);
}

function parseEditMap(text) {
  const bindings = emptyBindings(EDIT_FUNCTIONS);
  const unsupported = new Set();
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const first = /^\s{2}([A-Z][A-Z0-9]*)\s+.*?\s+-\s+(.*)$/.exec(line);
    let keys;
    if (first) {
      current = first[1];
      keys = first[2];
    } else {
      const continuation = /^\s{20,}(.+)$/.exec(line);
      if (!continuation || !current) continue;
      keys = continuation[1];
    }
    const action = EDIT_FUNCTIONS[current];
    for (const token of splitEditKeys(keys)) {
      // Character ranges describe insertable text, not command bindings.
      if (/^\d/.test(token)) continue;
      const key = lynxKeySpec(token.replace(/[.]$/, ''));
      if (!key) continue;
      if (action) addBinding(bindings, action, key);
      else unsupported.add(current);
    }
  }
  return { bindings, unsupported: [...unsupported].sort() };
}

function importedDefaults(browse, edit) {
  const bindings = { ...browse.bindings, ...edit.bindings };
  return {
    bindings,
    unsupported: [...new Set([...browse.unsupported, ...edit.unsupported])].sort(),
  };
}

const DEFAULT_PREFERENCES = {
  keypadMode: 'NUMBERS_AS_ARROWS',
  numberLinks: false,
  numberFields: false,
  numberLinksOnLeft: true,
  numberFieldsOnLeft: true,
  textfieldsNeedActivation: false,
  searchCase: 'CASE_INSENSITIVE',
  // Lynx hides the cursor at the bottom-right by default and only moves it to
  // the current link when SHOW_CURSOR is on. See LYrcFile.c: the setting is
  // documented as being for speech and braille interfaces, which is why it
  // matters here at all.
  showCursor: false,
};

function booleanValue(value, fallback) {
  if (/^(true|on|yes|1)$/i.test(value)) return true;
  if (/^(false|off|no|0)$/i.test(value)) return false;
  return fallback;
}

function applyKeypadMode(preferences, value) {
  const mode = String(value || '').trim().toUpperCase()
    .replace('LINKS_AND_FORM_FIELDS_ARE_NUMBERED', 'LINKS_AND_FIELDS_ARE_NUMBERED')
    .replace('LINKS_ARE_NOT_NUMBERED', 'NUMBERS_AS_ARROWS');
  if (!['NUMBERS_AS_ARROWS', 'LINKS_ARE_NUMBERED', 'FIELDS_ARE_NUMBERED',
    'LINKS_AND_FIELDS_ARE_NUMBERED'].includes(mode)) return;
  preferences.keypadMode = mode;
  preferences.numberLinks = mode === 'LINKS_ARE_NUMBERED' || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
  preferences.numberFields = mode === 'FIELDS_ARE_NUMBERED' || mode === 'LINKS_AND_FIELDS_ARE_NUMBERED';
}

function parsePreferences(showConfig, lynxrc = '') {
  const preferences = { ...DEFAULT_PREFERENCES };
  for (const line of String(showConfig).split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*):(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, value] = match;
    if (name === 'DEFAULT_KEYPAD_MODE') applyKeypadMode(preferences, value);
    else if (name === 'SHOW_CURSOR') {
      preferences.showCursor = booleanValue(value, preferences.showCursor);
    } else if (name === 'NUMBER_LINKS_ON_LEFT') {
      preferences.numberLinksOnLeft = booleanValue(value, preferences.numberLinksOnLeft);
    } else if (name === 'NUMBER_FIELDS_ON_LEFT') {
      preferences.numberFieldsOnLeft = booleanValue(value, preferences.numberFieldsOnLeft);
    } else if (name === 'TEXTFIELDS_NEED_ACTIVATION') {
      preferences.textfieldsNeedActivation = booleanValue(value, preferences.textfieldsNeedActivation);
    }
  }
  // Lynx reads .lynxrc after lynx.cfg. Only settings relevant to this adapter
  // are considered; browser, cookie, proxy, viewer, and command settings stay
  // entirely with Lynx.
  for (const line of String(lynxrc).split(/\r?\n/)) {
    const match = /^\s*keypad_mode\s*=\s*(\S+)/i.exec(line);
    if (match) applyKeypadMode(preferences, match[1]);
    const cursor = /^\s*show_cursor\s*=\s*(\S+)/i.exec(line);
    if (cursor) preferences.showCursor = booleanValue(cursor[1], preferences.showCursor);
  }
  return preferences;
}

function readLynxConfig({
  executable = 'lynx', config = null, env = process.env, run = spawnSync,
  readFile = fs.readFileSync,
} = {}) {
  const childEnv = { ...env, LC_ALL: 'C', LANG: 'C' };
  if (config) childEnv.LYNX_CFG = config;
  const dump = (url) => run(executable, ['-dump', url], {
    env: childEnv, encoding: 'utf8', timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const browse = dump('LYNXKEYMAP:');
  const edit = dump('LYNXEDITMAP:');
  if (!browse || browse.status !== 0 || !edit || edit.status !== 0) {
    return {
      available: false, bindings: {}, unsupported: [], preferences: { ...DEFAULT_PREFERENCES },
    };
  }
  const shown = run(executable, ['-show_cfg'], {
    env: childEnv, encoding: 'utf8', timeout: 3000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let lynxrc = '';
  try {
    lynxrc = readFile(path.join(childEnv.HOME || os.homedir(), '.lynxrc'), 'utf8');
  } catch { /* a user options file is optional */ }
  return {
    available: true,
    ...importedDefaults(parseBrowseMap(browse.stdout), parseEditMap(edit.stdout)),
    preferences: parsePreferences(shown && shown.status === 0 ? shown.stdout : '', lynxrc),
  };
}

module.exports = {
  DEFAULT_PREFERENCES, parsePreferences,
  BROWSE_FUNCTIONS, EDIT_FUNCTIONS, lynxKeySpec,
  parseBrowseMap, parseEditMap, readLynxConfig,
};
