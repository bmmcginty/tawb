'use strict';

// The interface policy layer, differenced between the JavaScript original and
// the Crystal port: which profiles an action belongs to, whose bindings an
// interface starts from, which terminal keys and file format it owns, and
// what its keys mean over a transient page the browser drew.

const test = require('node:test');
const assert = require('node:assert');

const { interfaceImplementations } = require('./crystal_impl');
const interfaces = require('../src/interfaces');
const { ACTIONS } = require('../src/keys');

for (const implementation of interfaceImplementations(interfaces)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('every action belongs to the profiles the sets say', () => {
    for (const action of ACTIONS) {
      assert.deepEqual(implementation.profilesFor(action.id), interfaces.profilesFor(action.id), action.id);
    }
  });

  check('interface names resolve or refuse, exactly as written', () => {
    assert.equal(implementation.interfaceName(null), 'default');
    assert.equal(implementation.interfaceName(''), 'default');
    assert.equal(implementation.interfaceName('LYNX'), 'lynx');
    assert.throws(() => implementation.interfaceName('emacs'),
      /Unknown interface emacs; use default or lynx/);
  });

  check('an interface starts from its own bindings', () => {
    for (const action of ACTIONS) {
      assert.deepEqual(
        implementation.bindingsFor(action.id, action.defaults, 'default'),
        interfaces.bindingsFor({ id: action.id, defaults: action.defaults }, 'default'),
        action.id,
      );
      assert.deepEqual(
        implementation.bindingsFor(action.id, action.defaults, 'lynx'),
        interfaces.bindingsFor({ id: action.id, defaults: action.defaults }, 'lynx'),
        action.id,
      );
    }
    // An action the Lynx interface leaves out starts with no bindings there,
    // rather than silently inheriting the ordinary interface's key.
    assert.deepEqual(implementation.bindingsFor('quit', ['Ctrl+C', 'q'], 'lynx'), []);
  });

  check('the ordinary interface owns no extra keys and no file format', () => {
    assert.deepEqual(implementation.keyPolicy('default'), {
      key_definitions: null,
      labels: { keyboardTitle: 'Keyboard bindings' },
      has_key_file: false,
    });
  });

  check('the Lynx interface owns its function keys and its file format', () => {
    const policy = implementation.keyPolicy('lynx');
    assert.deepEqual(policy.key_definitions, interfaces.LYNX_KEY_DEFINITIONS);
    assert.deepEqual(policy.labels, {
      keyboardTitle: 'Lynx keyboard bindings',
      unsupportedHeading: 'Lynx commands with no TAWB equivalent (cannot be bound):',
      unsupportedPrefix: 'Imported Lynx command',
    });
    assert.equal(policy.has_key_file, true);
  });

  check('only the Lynx display asks for layout metadata', () => {
    assert.equal(implementation.needsLayoutMetadata('default'), false);
    assert.equal(implementation.needsLayoutMetadata('lynx'), true);
  });

  check('a transient page reads the same context actions on both runtimes', () => {
    assert.deepEqual(implementation.contextActions(), interfaces.LYNX_CONTEXT_ACTIONS);
    const actionFor = {
      '\r': 'activate', '\x1b[D': 'history-back', ' ': 'next-screen',
    };
    for (const [chunk, expected] of [
      ['\r', 'accept'], ['\x1b[D', 'cancel'], [' ', 'page-next'], ['x', null],
    ]) {
      assert.equal(implementation.contextNavigationAction(chunk, 'lynx', actionFor), expected, chunk);
    }
    // The gate is the interface: the same map answers nothing on default.
    assert.equal(implementation.contextNavigationAction('\r', 'default', actionFor), null);
    // And with no keymap at all, nothing is derived.
    assert.equal(implementation.contextNavigationAction('\r', 'lynx', null), null);
  });

  check('the cursor hides unless Lynx was asked to show it', () => {
    assert.equal(implementation.lynxHidesCursor('default', undefined), false);
    assert.equal(implementation.lynxHidesCursor('default', true), false);
    assert.equal(implementation.lynxHidesCursor('lynx', undefined), true,
      'absent means Lynx\'s own default, which is to hide it');
    assert.equal(implementation.lynxHidesCursor('lynx', false), true);
    assert.equal(implementation.lynxHidesCursor('lynx', true), false);
  });
}
