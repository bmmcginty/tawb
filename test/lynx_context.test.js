'use strict';

// The interface policy that used to sit in the terminal loop, now tested where
// it lives. contextNavigationAction() is what lets an imported Lynx map drive
// popups, choosers and native dialogs; lynxHidesCursor() is SHOW_CURSOR.

const test = require('node:test');
const assert = require('node:assert');

const {
  LYNX_CONTEXT_ACTIONS, contextNavigationAction, lynxHidesCursor,
} = require('../src/interfaces');
const { Keymap } = require('../src/keys');

function lynxState(bindings, preferences = {}) {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false, bindings });
  keys.preferences = preferences;
  return { interface: 'lynx', keys };
}

test('the vi browse map drives transient navigation', () => {
  const state = lynxState({
    'history-back': ['h'], 'next-focusable': ['j'],
    'previous-focusable': ['k'], activate: ['l'], help: [],
    'next-screen': ['Ctrl+F'], top: ['Ctrl+A'], bottom: ['Ctrl+E'],
  });
  assert.equal(contextNavigationAction('h', state), 'cancel');
  assert.equal(contextNavigationAction('j', state), 'next');
  assert.equal(contextNavigationAction('k', state), 'previous');
  assert.equal(contextNavigationAction('l', state), 'accept');
  assert.equal(contextNavigationAction('\x06', state), 'page-next');
  assert.equal(contextNavigationAction('\x01', state), 'first');
  assert.equal(contextNavigationAction('\x05', state), 'last');
  // A key the map does not bind derives nothing.
  assert.equal(contextNavigationAction('z', state), null);
});

test('the gate is the interface, not the keymap', () => {
  const state = lynxState({ 'history-back': ['b'] });
  assert.equal(contextNavigationAction('b', state), 'cancel');
  assert.equal(contextNavigationAction('b', { ...state, interface: 'default' }), null);
  // Even a Lynx map on a default-interface state derives nothing.
  assert.equal(contextNavigationAction('b', { interface: 'default', keys: state.keys }), null);
});

test('every context action names a real Lynx function set', () => {
  // The map is small enough to read; this guards against a stray key.
  assert.deepEqual(Object.keys(LYNX_CONTEXT_ACTIONS).sort(),
    ['activate', 'bottom', 'close-popup', 'history-back', 'next-focusable',
      'next-line', 'next-screen', 'previous-focusable', 'previous-line',
      'previous-screen', 'top']);
});

test('SHOW_CURSOR decides whether the Lynx cursor is hidden', () => {
  assert.equal(lynxHidesCursor(lynxState({}, { showCursor: true })), false);
  assert.equal(lynxHidesCursor(lynxState({}, { showCursor: false })), true);
  // Absent means Lynx's own default, which is to hide it.
  assert.equal(lynxHidesCursor(lynxState({})), true);
  // The choice never reaches the ordinary interface.
  assert.equal(lynxHidesCursor({ interface: 'default', keys: { preferences: {} } }), false);
});
