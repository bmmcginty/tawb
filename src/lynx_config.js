'use strict';

const { spawnSync } = require('node:child_process');

const BROWSE_FUNCTIONS = {
  QUIT: 'quit', ABORT: 'quit',
  GOTO: 'location-bar',
  PREV_DOC: 'history-back', NEXT_DOC: 'history-forward',
  ACTIVATE: 'activate',
  DOWN_TWO: 'next-line', UP_TWO: 'previous-line',
  NEXT_PAGE: 'next-screen', DOWN_HALF: 'next-screen',
  PREV_PAGE: 'previous-screen', UP_HALF: 'previous-screen',
  HOME: 'top', END: 'bottom',
  ADD_BOOKMARK: 'add-bookmark', VIEW_BOOKMARK: 'bookmarks',
  VLINKS: 'history', HISTORY: 'history', DOWNLOAD: 'download-link',
  INFO: 'where',
  WHEREIS: 'find-forward', NEXT: 'repeat-find',
  REFRESH: 'refresh', RELOAD: 'reload-page',
  SOURCE: 'cycle-view', KEYMAP: 'keyboard-wizard',
  NEXT_LINK: 'next-focusable', FASTFORW_LINK: 'next-focusable', DOWN_LINK: 'next-focusable',
  PREV_LINK: 'previous-focusable', FASTBACKW_LINK: 'previous-focusable', UP_LINK: 'previous-focusable',
};

const EDIT_FUNCTIONS = {
  BOL: 'edit-line-start', EOL: 'edit-line-end',
  BACK: 'edit-previous-character', FORW: 'edit-next-character',
  DELP: 'edit-backspace', DELN: 'edit-delete',
  BACKW: 'edit-previous-word', FORWW: 'edit-next-word',
  DELPW: 'edit-backspace-word', DELNW: 'edit-delete-word',
  ERASE: 'edit-kill-start', DELEL: 'edit-kill-end',
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

function readLynxConfig({
  executable = 'lynx', config = null, env = process.env, run = spawnSync,
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
    return { available: false, bindings: {}, unsupported: [] };
  }
  return {
    available: true,
    ...importedDefaults(parseBrowseMap(browse.stdout), parseEditMap(edit.stdout)),
  };
}

module.exports = {
  BROWSE_FUNCTIONS, EDIT_FUNCTIONS, lynxKeySpec,
  parseBrowseMap, parseEditMap, readLynxConfig,
};
