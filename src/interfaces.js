'use strict';

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
  interfaceName, bindingsFor, contextNavigationAction, lynxHidesCursor,
};
