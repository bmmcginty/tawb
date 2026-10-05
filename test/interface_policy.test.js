'use strict';

// Which actions, terminal keys and key-file format each interface owns. This
// policy used to be spread through src/keys.js; it now lives in
// src/interfaces.js, and these tests pin it there.

const test = require('node:test');
const assert = require('node:assert');

const {
  LYNX_KEY_DEFINITIONS, LYNX_ONLY_ACTIONS, DEFAULT_ONLY_ACTIONS,
  profilesFor, keyPolicy,
} = require('../src/interfaces');
const { KEY_DEFINITIONS, Keymap } = require('../src/keys');

test('an action belongs to the interface that can reach it', () => {
  // A Lynx-only function is not offered to the ordinary interface.
  assert.deepEqual(profilesFor('options'), ['lynx']);
  assert.deepEqual(profilesFor('help'), ['lynx']);
  // A reading command Lynx deliberately leaves out is not offered to Lynx.
  assert.deepEqual(profilesFor('next-heading'), ['default']);
  assert.deepEqual(profilesFor('where'), ['default']);
  // Everything else exists in both.
  assert.deepEqual(profilesFor('activate'), ['default', 'lynx']);
  assert.deepEqual(profilesFor('next-screen'), ['default', 'lynx']);
});

test('the two action sets name real, disjoint groups', () => {
  for (const id of LYNX_ONLY_ACTIONS) {
    assert.ok(!DEFAULT_ONLY_ACTIONS.has(id), `${id} is in both sets`);
  }
  assert.ok(LYNX_ONLY_ACTIONS.has('link-number'));
  assert.ok(DEFAULT_ONLY_ACTIONS.has('toggle-live'));
});

test('the Lynx function keys stay out of the shared table', () => {
  assert.equal(LYNX_KEY_DEFINITIONS.F2.cap, 'kf2');
  assert.equal(LYNX_KEY_DEFINITIONS.F12.cap, 'kf12');
  // The ordinary table names none of them, so a default reader pays for no
  // extra terminfo lookups.
  for (const name of Object.keys(LYNX_KEY_DEFINITIONS)) {
    assert.equal(KEY_DEFINITIONS[name], undefined, name);
  }
});

test('the interface policy gives each profile its definitions and codec', () => {
  const ordinary = keyPolicy('default');
  assert.equal(ordinary.keyDefinitions, null);
  assert.equal(ordinary.keyFile, null);

  const lynx = keyPolicy('lynx');
  assert.equal(lynx.keyDefinitions, LYNX_KEY_DEFINITIONS);
  assert.equal(typeof lynx.keyFile.parse, 'function');
  assert.equal(typeof lynx.keyFile.serialise, 'function');
  assert.equal(lynx.keyFile.functionNames([{ id: 'list-links' }]).get('list-links'), 'LIST');
});

test('a Keymap draws its vocabulary and codec from the policy', () => {
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  // Only Lynx names F2, and only its screen labels actions by function.
  assert.equal(lynx.namedSequences.has('F2'), true);
  assert.equal(lynx.functionNames.get('list-links'), 'LIST');

  const ordinary = new Keymap({ terminfo: {}, load: false });
  assert.equal(ordinary.namedSequences.has('F2'), false);
  assert.equal(ordinary.functionNames.size, 0);
});
