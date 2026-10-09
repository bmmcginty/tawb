'use strict';

// The Lynx key file, differenced between the JavaScript original and the
// Crystal port: the same files parsed, the same actions serialised, and the
// same function vocabulary asked for by name, must agree.

const test = require('node:test');
const assert = require('node:assert');

const { lynxKeymapImplementations } = require('./crystal_impl');
const lynxKeymap = require('../src/lynx_keymap');
const { BROWSE_FUNCTIONS, EDIT_FUNCTIONS } = require('../src/lynx_config');

const EXTENSION_FUNCTIONS = [
  'TAWB_CYCLE_VIEW', 'TAWB_PAGE_KEYBOARD', 'TAWB_REAL_CLICK', 'TAWB_HOVER_LINE',
  'TAWB_BROWSER_QUESTION', 'TAWB_CLOSE_POPUP', 'TAWB_NEW_TAB', 'TAWB_NEXT_TAB',
  'TAWB_PREVIOUS_TAB', 'TAWB_CLOSE_TAB',
];
const EXTENSION_ACTIONS = [
  'cycle-view', 'page-keyboard', 'real-click', 'hover-line', 'browser-question',
  'close-popup', 'new-tab', 'next-tab', 'previous-tab', 'close-tab',
];

for (const implementation of lynxKeymapImplementations(lynxKeymap)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('no Lynx function is folded onto another action', () => {
    // Two functions writing one action would mean one of them could not be
    // expressed in a file keyed by function name, and a reader's binding on
    // it would be lost when they saved.
    const owners = new Map();
    for (const [name, action] of [
      ...Object.entries(BROWSE_FUNCTIONS), ...Object.entries(EDIT_FUNCTIONS),
    ]) {
      if (owners.has(action)) {
        assert.fail(`${action} is written by both ${owners.get(action)} and ${name}`);
      }
      owners.set(action, name);
    }
  });

  check('the function vocabulary answers for every name it owns', () => {
    const names = [
      ...Object.keys(BROWSE_FUNCTIONS), ...Object.keys(EDIT_FUNCTIONS), ...EXTENSION_FUNCTIONS,
    ];
    const actions = [
      ...new Set([
        ...Object.values(BROWSE_FUNCTIONS), ...Object.values(EDIT_FUNCTIONS), ...EXTENSION_ACTIONS,
      ]),
    ];
    for (const name of names) {
      assert.equal(implementation.actionForFunction(name), lynxKeymap.actionForFunction(name), name);
    }
    for (const action of actions) {
      assert.equal(implementation.functionForAction(action), lynxKeymap.functionForAction(action), action);
    }
    assert.equal(implementation.actionForFunction('SHELL'), null);
    assert.equal(implementation.functionForAction('quit'), null);
  });

  check('Lynx names win over extension names for the same action', () => {
    assert.equal(implementation.functionForAction('list-links'), 'LIST');
    assert.equal(implementation.functionForAction('new-tab'), 'TAWB_NEW_TAB');
    assert.deepEqual(implementation.functionNames(['list-links', 'new-tab', 'cycle-view', 'quit']), {
      'list-links': 'LIST',
      'new-tab': 'TAWB_NEW_TAB',
      'cycle-view': 'TAWB_CYCLE_VIEW',
    });
  });

  check('a function-keyed file is read into the actions it names', () => {
    assert.deepEqual(implementation.parse(JSON.stringify({
      version: 2,
      functions: {
        LIST: ['l', 'x'],
        NEXT_LINK: ['j'],
        TAWB_CYCLE_VIEW: ['^O'],
        SHELL: ['!'],
        MALFORMED: 'not a list',
      },
    })), {
      'list-links': ['l', 'x'],
      'next-focusable': ['j'],
      'cycle-view': ['^O'],
    });
  });

  check('a file written before the functions were told apart still loads', () => {
    assert.deepEqual(implementation.parse(JSON.stringify({
      version: 1, actions: { 'list-links': ['x'], 'confirm-quit': ['~'] },
    })), { 'list-links': ['x'], 'confirm-quit': ['~'] });
    // Version 1's values reach the keymap exactly as they were written; it is
    // the keymap that drops what it cannot use.
    assert.deepEqual(implementation.parse('{"version":1,"actions":{"x":"still raw"}}'),
      { x: 'still raw' });
    assert.equal(implementation.parse('not json'), null);
    assert.equal(implementation.parse('{}'), null);
    assert.equal(implementation.parse('[]'), null);
    assert.equal(implementation.parse('2'), null);
    assert.equal(implementation.parse('{"version":"2","functions":{"LIST":["l"]}}'), null);
  });

  check('serialising writes Lynx names in the file shape JavaScript writes', () => {
    const actions = [
      { id: 'list-links', bindings: ['l'] },
      { id: 'cycle-view', bindings: ['^O'] },
      { id: 'confirm-quit', bindings: [] },
      { id: 'quit', bindings: ['q'] },
    ];
    assert.equal(implementation.serialise(actions), lynxKeymap.serialiseKeyFile(actions));
  });

  check('serialising an interface with no named actions writes an empty file', () => {
    const actions = [{ id: 'quit', bindings: ['q'] }];
    assert.equal(implementation.serialise(actions), '{\n  "version": 2,\n  "functions": {}\n}\n');
  });

  check('what is parsed is what is serialised', () => {
    const text = JSON.stringify({
      version: 2,
      functions: { LIST: ['l', 'Alt+D'], SOURCE: [], TAWB_NEW_TAB: ['Ctrl+T'] },
    });
    const actions = implementation.parse(text);
    const entries = Object.entries(actions).map(([id, bindings]) => ({ id, bindings }));
    const written = JSON.parse(implementation.serialise(entries));
    assert.equal(written.version, 2);
    assert.deepEqual(written.functions.LIST, ['l', 'Alt+D']);
    assert.deepEqual(written.functions.SOURCE, []);
    assert.deepEqual(written.functions.TAWB_NEW_TAB, ['Ctrl+T']);
    assert.equal(Object.hasOwn(written, 'actions'), false);
  });
}
