'use strict';

const { parseKeyFile, serialiseKeyFile, functionNames } = require('./lynx_keymap');

const INTERFACES = new Set(['default', 'lynx']);

// A compatibility interface owns defaults, not implementation. Handlers still
// receive semantic action names, so Lynx keys use the same browser-backed
// history, activation, download and editing paths as the ordinary interface.
// An empty entry is deliberate: it keeps a TAWB reading command from leaking
// into Lynx merely because nobody supplied a Lynx equivalent for it.
const LYNX_BINDINGS = {
  quit: [],
  'confirm-quit': ['q'],
  abort: ['Q', 'Ctrl+D'],
  'location-bar': [],
  goto: ['g'],
  'location-edit': ['G'],
  'link-address': ['E'],
  'history-back': ['ArrowLeft', 'u'],
  'history-forward': ['Ctrl+U'],
  activate: ['Enter', 'ArrowRight'],
  'next-line': ['Ctrl+N'],
  'previous-line': ['Ctrl+P'],
  'next-character': [],
  'previous-character': [],
  'next-screen': ['Space', '+', 'Ctrl+F', 'PageDown'],
  'previous-screen': ['b', '-', 'Ctrl+B', 'PageUp'],
  top: ['Ctrl+A'],
  bottom: ['Ctrl+E'],
  'line-start': ['Home'],
  'line-end': ['End'],
  'edit-line-start': ['Ctrl+A', 'Home'],
  'edit-line-end': ['Ctrl+E', 'End'],
  'edit-previous-character': ['ArrowLeft'],
  'edit-next-character': ['ArrowRight'],
  'edit-backspace': ['Backspace', 'Ctrl+H'],
  'edit-delete': ['Ctrl+D', 'Ctrl+R', 'Delete'],
  'edit-previous-word': ['Ctrl+P'],
  'edit-next-word': ['Ctrl+N'],
  'edit-backspace-word': ['Ctrl+B'],
  'edit-delete-word': ['Ctrl+F'],
  'edit-kill-start': ['Ctrl+U'],
  'edit-kill-end': ['Ctrl+_'],
  'edit-command': ['Ctrl+V'],
  'new-tab': [],
  bookmarks: ['v'],
  'add-bookmark': ['a'],
  'delete-bookmark': ['r', 'R'],
  'visited-links': ['V'],
  'session-history': ['Backspace', 'Ctrl+H'],
  downloads: [],
  'list-links': ['l'],
  'list-addresses': ['A'],
  'download-link': ['d'],
  'browser-question': ['Ctrl+_'],
  'next-tab': [],
  'previous-tab': [],
  'close-tab': [],
  'next-change': [],
  'previous-change': [],
  where: [],
  'document-info': ['='],
  options: ['o', 'O'],
  'link-number': ['0'],
  'toggle-live': [],
  'toggle-link-address': [],
  'toggle-short-links': [],
  'real-click': ['Ctrl+Y'],
  'hover-line': ['Ctrl+]'],
  'page-keyboard': ['Ctrl+\\'],
  'find-forward': ['/'],
  'find-backward': [],
  'repeat-find': [],
  'repeat-find-forward': ['n'],
  'repeat-find-backward': ['N'],
  refresh: ['Ctrl+L', 'Ctrl+W'],
  'reload-page': ['Ctrl+R'],
  'reload-no-cache': ['x', 'X'],
  interrupt: ['z', 'Z'],
  'toggle-trace': ['Ctrl+T'],
  'trace-log': [';'],
  'cycle-view': ['Ctrl+O'],
  'source-view': ['\\'],
  help: ['h', 'H', '?'],
  'context-help': ['F1'],
  'keyboard-wizard': ['k', 'K'],
  'main-menu': ['m', 'M'],
  'next-heading': [],
  'previous-heading': [],
  'next-link': [],
  'previous-link': [],
  'next-field': [],
  'previous-field': [],
  'next-button': [],
  'previous-button': [],
  'next-focusable': ['ArrowDown'],
  'previous-focusable': ['ArrowUp'],
  'fast-forward-link': ['Tab'],
  'fast-backward-link': ['Shift+Tab'],
  'down-link': ['>'],
  'up-link': ['<'],
  'next-half-screen': [')'],
  'previous-half-screen': ['('],
  'first-focusable': ['^'],
  'last-focusable': ['$'],
  'next-text': [],
  'previous-text': [],
  'next-paragraph': [],
  'previous-paragraph': [],
  'close-popup': [],
};

function interfaceName(value) {
  const name = String(value || 'default').toLowerCase();
  if (!INTERFACES.has(name)) {
    throw new Error(`Unknown interface ${value}; use default or lynx`);
  }
  return name;
}

// Function keys beyond F5 are named only for the Lynx profile, because nothing
// in TAWB's own bindings uses them. Importing an effective Lynx map is the one
// caller that can: upstream binds F1 to context help and a customized map can
// put any function key on any command. Keeping them out of the shared table
// means a reader who has not asked for the Lynx interface gets exactly the
// startup it had before, with no extra terminfo lookups and no page key that
// suddenly has a name.
const LYNX_KEY_DEFINITIONS = {
  F1: { cap: 'kf1', sequences: ['\x1bOP', '\x1b[11~', '\x1b[[A'] },
  F2: { cap: 'kf2', sequences: ['\x1bOQ', '\x1b[12~', '\x1b[[B'] },
  F3: { cap: 'kf3', sequences: ['\x1bOR', '\x1b[13~', '\x1b[[C'] },
  F4: { cap: 'kf4', sequences: ['\x1bOS', '\x1b[14~', '\x1b[[D'] },
  F6: { cap: 'kf6', sequences: ['\x1b[17~'] },
  F7: { cap: 'kf7', sequences: ['\x1b[18~'] },
  F8: { cap: 'kf8', sequences: ['\x1b[19~'] },
  F9: { cap: 'kf9', sequences: ['\x1b[20~'] },
  F10: { cap: 'kf10', sequences: ['\x1b[21~'] },
  F11: { cap: 'kf11', sequences: ['\x1b[23~'] },
  F12: { cap: 'kf12', sequences: ['\x1b[24~'] },
};

// Which interface an action belongs to.
//
// Most actions exist in both: the two interfaces are the same browser behind
// different keys, and an action with no Lynx function of its own is still
// reachable from either map. The exceptions are the two sets below.
//
// A Lynx-only action is one the Lynx interface added — a Lynx function TAWB
// had no action for, or a browser facility the compatibility work needed. The
// default interface keeps exactly the keystrokes it had before that work, so
// these stay out of its map and out of its keyboard screen until somebody
// pulls one across deliberately.
const LYNX_ONLY_ACTIONS = new Set([
  'goto', 'location-edit', 'edit-command', 'delete-bookmark', 'list-links',
  'list-addresses', 'document-info', 'options', 'link-number',
  'repeat-find-forward', 'repeat-find-backward', 'reload-no-cache',
  'interrupt', 'toggle-trace', 'trace-log', 'source-view', 'help',
  'main-menu', 'first-focusable', 'last-focusable',
  'fast-forward-link', 'fast-backward-link', 'down-link', 'up-link',
  'next-half-screen', 'previous-half-screen',
  'confirm-quit', 'abort', 'link-address', 'context-help',
  'visited-links', 'session-history',
]);

// A default-only action is one the Lynx interface deliberately leaves out, so
// that a reader who knows Lynx is never shadowed by a TAWB reading command on
// a letter Lynx uses. Quick navigation is the bulk of it: Lynx handles moving
// through a page with numbers and pages, and a reader who wants h/l/f/b/n/p
// uses the ordinary interface for it.
const DEFAULT_ONLY_ACTIONS = new Set([
  'quit', 'history',
  'location-bar', 'next-character', 'previous-character', 'line-start', 'line-end',
  'next-change', 'previous-change', 'where', 'toggle-live', 'toggle-link-address',
  'toggle-short-links', 'find-backward', 'repeat-find', 'downloads',
  'next-heading', 'previous-heading', 'next-link', 'previous-link',
  'next-field', 'previous-field', 'next-button', 'previous-button',
  'next-text', 'previous-text', 'next-paragraph', 'previous-paragraph',
]);

function profilesFor(id) {
  if (LYNX_ONLY_ACTIONS.has(id)) return ['lynx'];
  if (DEFAULT_ONLY_ACTIONS.has(id)) return ['default'];
  return ['default', 'lynx'];
}

// The parts of key handling an interface owns: terminal keys only it names
// (the Lynx function keys), and the key-file format it reads and writes. The
// ordinary interface has neither, which is what leaves Keymap generic.
function keyPolicy(profile = 'default') {
  if (profile !== 'lynx') return { keyDefinitions: null, keyFile: null };
  return {
    keyDefinitions: LYNX_KEY_DEFINITIONS,
    keyFile: { parse: parseKeyFile, serialise: serialiseKeyFile, functionNames },
  };
}

function bindingsFor(action, profile = 'default') {
  if (profile !== 'lynx') return [...action.defaults];
  return [...(LYNX_BINDINGS[action.id] || [])];
}

// What a Lynx key means while a transient page the browser drew is open.
// The popup, chooser and native-dialog handlers understand these semantic
// names rather than raw keys, so an imported Lynx map drives them the same way
// it drives the browse map. The gate is the interface, not the keymap: a Lynx
// map on a default-interface session derives nothing from these keys.
const LYNX_CONTEXT_ACTIONS = {
  activate: 'accept',
  'history-back': 'cancel',
  'close-popup': 'cancel',
  'next-focusable': 'next',
  'next-line': 'next',
  'previous-focusable': 'previous',
  'previous-line': 'previous',
  'next-screen': 'page-next',
  'previous-screen': 'page-previous',
  top: 'first',
  bottom: 'last',
};

function contextNavigationAction(chunk, state) {
  if (state.interface !== 'lynx') return null;
  const action = (state.keys || { actionFor: () => null }).actionFor(chunk);
  return LYNX_CONTEXT_ACTIONS[action] || null;
}

// Whether the Lynx profile asks for the cursor to be hidden rather than parked
// on the current item. Lynx's SHOW_CURSOR is documented for speech and braille
// interfaces; with it off, Lynx leaves the cursor at the bottom-right and marks
// the current link with reverse video instead. Absent means Lynx's own default,
// which is to hide it.
function lynxHidesCursor(state) {
  if (state.interface !== 'lynx') return false;
  const preferences = state.keys && state.keys.preferences;
  return !(preferences && preferences.showCursor);
}

module.exports = {
  INTERFACES, LYNX_BINDINGS, LYNX_CONTEXT_ACTIONS,
  LYNX_KEY_DEFINITIONS, LYNX_ONLY_ACTIONS, DEFAULT_ONLY_ACTIONS,
  interfaceName, bindingsFor, profilesFor, keyPolicy,
  contextNavigationAction, lynxHidesCursor,
};
