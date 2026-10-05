'use strict';

// The Lynx key file, and the names the keyboard screen uses.
//
// The file is keyed by Lynx function name so that a reader who knows Lynx can
// read and write their own bindings in the vocabulary of the program they came
// from, and so that one Lynx function is always one entry. The screen shows the
// same names.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap, actionsFor } = require('../src/keys');
const { wizardRows, rowText } = require('../src/key_wizard');
const {
  actionForFunction, functionForAction, functionNames, parseKeyFile, serialiseKeyFile,
} = require('../src/lynx_keymap');
const { BROWSE_FUNCTIONS, EDIT_FUNCTIONS } = require('../src/lynx_config');

test('no Lynx function is folded onto another action', () => {
  // Two functions writing one action would mean one of them could not be
  // expressed in a file keyed by function name, and a reader's binding on it
  // would be lost when they saved.
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

test('every action the Lynx interface offers can be written by name', () => {
  for (const action of actionsFor('lynx')) {
    assert.ok(functionForAction(action.id),
      `${action.id} has no Lynx function or TAWB_ name to be saved under`);
  }
});

test('the extensions live in the same namespace, under a TAWB_ prefix', () => {
  assert.equal(actionForFunction('TAWB_CYCLE_VIEW'), 'cycle-view');
  assert.equal(actionForFunction('TAWB_PAGE_KEYBOARD'), 'page-keyboard');
  assert.equal(functionForAction('new-tab'), 'TAWB_NEW_TAB');
  // Lynx's own name wins when an action has both, which none does today.
  assert.equal(functionForAction('list-links'), 'LIST');
  assert.equal(functionForAction('quit'), null, 'the default interface has no Lynx name');
});

test('a function-keyed file is read into the actions it names', () => {
  const actions = parseKeyFile(JSON.stringify({
    version: 2,
    functions: {
      LIST: ['l', 'x'],
      NEXT_LINK: ['j'],
      TAWB_CYCLE_VIEW: ['^O'],
      SHELL: ['!'],
      MALFORMED: 'not a list',
    },
  }));
  assert.deepEqual(actions, {
    'list-links': ['l', 'x'],
    'next-focusable': ['j'],
    'cycle-view': ['^O'],
  });
});

test('a file written before the functions were told apart still loads', () => {
  const actions = parseKeyFile(JSON.stringify({
    version: 1, actions: { 'list-links': ['x'], 'confirm-quit': ['~'] },
  }));
  assert.deepEqual(actions, { 'list-links': ['x'], 'confirm-quit': ['~'] });
  assert.equal(parseKeyFile('not json'), null);
  assert.equal(parseKeyFile('{}'), null);
});

test('the Lynx keymap saves by function name, in its own file', () => {
  const directory = tempDir('tawb-lynx-keyfile-');
  const file = path.join(directory, 'keys-lynx.json');
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', file, load: false });
  keys.assign('list-links', 'x');
  keys.assign('cycle-view', '\x0f');
  keys.unbind('source-view');
  keys.save();

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(written.functions.LIST, ['x']);
  assert.deepEqual(written.functions.TAWB_CYCLE_VIEW, ['Ctrl+O']);
  assert.deepEqual(written.functions.SOURCE, []);
  assert.equal(Object.hasOwn(written, 'actions'), false, 'an action-keyed document was written');

  const loaded = new Keymap({ terminfo: {}, profile: 'lynx', file });
  assert.equal(loaded.actionFor('x'), 'list-links');
  assert.equal(loaded.actionFor('\x0f'), 'cycle-view');
  assert.equal(loaded.actionFor('\\'), null, 'the saved unbinding did not arrive');
});

test('the ordinary interface still writes its own file, unchanged', () => {
  const directory = tempDir('tawb-default-keyfile-');
  const file = path.join(directory, 'keys.json');
  const keys = new Keymap({ terminfo: {}, file, load: false });
  keys.assign('quit', 'x');
  keys.save();
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.version, 1);
  assert.deepEqual(written.actions.quit, ['x']);
  assert.equal(Object.hasOwn(written, 'functions'), false);
});

test('a version-1 Lynx file is read and re-saved by function name', () => {
  const directory = tempDir('tawb-lynx-keyfile-old-');
  const file = path.join(directory, 'keys-lynx.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, actions: { 'list-links': ['x'], 'source-view': ['y'] },
  }));
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', file });
  assert.equal(keys.actionFor('x'), 'list-links');
  assert.equal(keys.actionFor('y'), 'source-view');
  keys.save();
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(written.functions.LIST, ['x']);
  assert.deepEqual(written.functions.SOURCE, ['y']);
});

test('serialising writes every action the interface has, so nothing is lost', () => {
  const actions = actionsFor('lynx').map((action) => ({
    ...action, bindings: action.id === 'list-links' ? ['l'] : [],
  }));
  const written = JSON.parse(serialiseKeyFile(actions));
  assert.equal(Object.keys(written.functions).length, actions.length);
  assert.ok(written.functions.NEXT_LINK, 'a function the interface acts on is missing');
});

test('the keyboard screen names Lynx functions for the Lynx interface', () => {
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  const rows = wizardRows(lynx).filter((row) => row.type === 'action');
  const list = rows.find((row) => row.action.id === 'list-links');
  assert.match(rowText(list, lynx), /^LIST — .*, l$/);
  // The extensions are named too, so they are findable rather than anonymous.
  const cycle = rows.find((row) => row.action.id === 'cycle-view');
  assert.match(rowText(cycle, lynx), /^TAWB_CYCLE_VIEW — /);

  // The ordinary interface has no such vocabulary and its rows are unchanged.
  const ordinary = new Keymap({ terminfo: {}, load: false });
  const quit = wizardRows(ordinary).find((row) => row.action.id === 'quit');
  assert.match(rowText(quit, ordinary), /^Quit, /);
  assert.equal(ordinary.functionNames.size, 0,
    'the ordinary screen grew a Lynx vocabulary');
});
