'use strict';

const INTERFACES = new Set(['default', 'lynx']);

// A compatibility interface owns defaults, not implementation. Handlers still
// receive semantic action names, so Lynx keys use the same browser-backed
// history, activation, download and editing paths as the ordinary interface.
// An empty entry is deliberate: it keeps a TAWB reading command from leaking
// into Lynx merely because nobody supplied a Lynx equivalent for it.
const LYNX_BINDINGS = {
  quit: ['q', 'Q'],
  'location-bar': [],
  goto: ['g'],
  'location-edit': ['G'],
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
  'new-tab': [],
  bookmarks: ['v'],
  'add-bookmark': ['a'],
  history: ['Backspace', 'Ctrl+H', 'V'],
  downloads: [],
  'list-links': ['l'],
  'list-addresses': ['A'],
  'download-link': ['d'],
  'browser-question': ['Alt+Q'],
  'next-tab': [],
  'previous-tab': [],
  'close-tab': [],
  'next-change': [],
  'previous-change': [],
  where: [],
  'document-info': ['='],
  'toggle-live': [],
  'toggle-link-address': [],
  'toggle-short-links': [],
  'real-click': ['Alt+M'],
  'hover-line': ['Alt+Shift+M'],
  'page-keyboard': ['Alt+K', 'Ctrl+\\'],
  'find-forward': ['/'],
  'find-backward': [],
  'repeat-find': [],
  'repeat-find-forward': ['n'],
  'repeat-find-backward': ['N'],
  refresh: ['Ctrl+L', 'Ctrl+W'],
  'reload-page': ['Ctrl+R'],
  'cycle-view': [],
  'source-view': ['\\'],
  'keyboard-wizard': ['k', '?', 'H'],
  'next-heading': [],
  'previous-heading': [],
  'next-link': [],
  'previous-link': [],
  'next-field': [],
  'previous-field': [],
  'next-button': [],
  'previous-button': [],
  'next-focusable': ['ArrowDown', 'Tab'],
  'previous-focusable': ['ArrowUp', 'Shift+Tab'],
  'next-text': [],
  'previous-text': [],
  'next-paragraph': [],
  'previous-paragraph': [],
  'close-popup': ['Escape'],
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

module.exports = { INTERFACES, LYNX_BINDINGS, interfaceName, bindingsFor };
