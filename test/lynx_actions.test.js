'use strict';

// The Lynx decisions the terminal loop dispatches to. These tests drive the
// module directly with a fake host, so the exact behavior and the
// interface-not-keymap gate are pinned without a terminal. Every case here
// existed before the dispatch moved; test/lynx_isolation.test.js still proves
// the same gate through src/index.js.

const test = require('node:test');
const assert = require('node:assert');

const { createLynxActions } = require('../src/lynx_actions');
const { Keymap } = require('../src/keys');

function keymap({ browse = {}, edit = {} } = {}) {
  return {
    actionFor: (chunk) => browse[chunk] || null,
    editingActionFor: (chunk) => edit[chunk] || null,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const actions = createLynxActions({
    fallbackKeymap: keymap(),
    keyIs: (chunk, name) => chunk === `[${name}]`,
    setStatus: (state, msg) => calls.push(['status', msg]),
    currentItem: (state) => state.item || null,
    isField: (role) => role === 'textbox',
    async beginTyping() { calls.push(['beginTyping']); return true; },
    openLinkNumberPrompt: (state, digits) => calls.push(['number', digits]),
    openHelp: () => calls.push(['help']),
    describeCurrent: () => calls.push(['describe']),
    async openMainMenu() { calls.push(['main-menu']); },
    openOptions: () => calls.push(['options']),
    async openTraceLog() { calls.push(['trace-log']); },
    async toggleTrace() { calls.push(['toggle-trace']); },
    ...overrides,
  });
  return { actions, calls };
}

function reader(interfaceName = 'lynx', extra = {}) {
  return {
    interface: interfaceName,
    keys: new Keymap({ terminfo: {}, profile: interfaceName === 'lynx' ? 'lynx' : 'default', load: false }),
    ...extra,
  };
}

test('active is the one interface gate', () => {
  const { actions } = harness();
  assert.equal(actions.active(reader('lynx')), true);
  assert.equal(actions.active(reader('default')), false);
  assert.equal(actions.active({}), false);
});

test('a digit starts the number prompt only when the profile numbers items', () => {
  const { actions, calls } = harness();
  const state = reader('lynx');
  assert.equal(actions.digit('5', state), false, 'no numbering preference yet');
  state.keys.preferences = { numberLinks: true, numberFields: false };
  assert.equal(actions.digit('5', state), true);
  assert.deepEqual(calls.pop(), ['number', '5']);
  // A non-digit, and the default interface, derive nothing.
  assert.equal(actions.digit('x', state), false);
  state.interface = 'default';
  assert.equal(actions.digit('5', state), false);
});

test('the Lynx screens are reached only in the Lynx interface', async () => {
  const { actions, calls } = harness();
  const state = reader('lynx');
  for (const [action, label] of [
    ['help', 'help'], ['context-help', 'describe'], ['main-menu', 'main-menu'],
    ['toggle-trace', 'toggle-trace'], ['trace-log', 'trace-log'], ['options', 'options'],
  ]) {
    calls.length = 0;
    assert.equal(await actions.action(action, state, {}), true, action);
    assert.deepEqual(calls.pop(), [label], action);
    state.interface = 'default';
    assert.equal(await actions.action(action, state, {}), false, `${action} outside Lynx`);
    state.interface = 'lynx';
  }
});

test('link-number opens the prompt whatever the interface says', async () => {
  // The action exists only in the Lynx map, and reaching it has always opened
  // the prompt; the move must not add a gate that was not there.
  const { actions, calls } = harness();
  assert.equal(await actions.action('link-number', reader('default'), {}), true);
  assert.deepEqual(calls.pop(), ['number', undefined]);
});

test('an unknown action falls through untouched', async () => {
  const { actions, calls } = harness();
  assert.equal(await actions.action('next-line', reader('lynx'), {}), false);
  assert.equal(calls.length, 0);
});

test('quick navigation enters a text field unless activation is required', async () => {
  const { actions, calls } = harness();
  const state = reader('lynx', { item: { role: 'textbox', name: 'Query' } });
  await actions.afterQuickNav({ line: 0, col: 0 }, state, {});
  assert.deepEqual(calls, [['beginTyping'], ['status', 'Enter text. Use arrows or Tab to move off of field.']]);

  // TEXTFIELDS_NEED_ACTIVATION leaves the field alone.
  calls.length = 0;
  state.keys.preferences = { textfieldsNeedActivation: true };
  await actions.afterQuickNav({ line: 0, col: 0 }, state, {});
  assert.deepEqual(calls, []);

  // A non-field, a missed jump, and the default interface all do nothing.
  calls.length = 0;
  state.keys.preferences = {};
  state.item = { role: 'link', name: 'News' };
  await actions.afterQuickNav({ line: 0, col: 0 }, state, {});
  await actions.afterQuickNav(null, state, {});
  state.interface = 'default';
  state.item = { role: 'textbox', name: 'Query' };
  await actions.afterQuickNav({ line: 0, col: 0 }, state, {});
  assert.deepEqual(calls, []);
});

test('the popup close hint and searching type are per interface', () => {
  const { actions } = harness();
  assert.equal(actions.popupCloseHint(reader('lynx')), 'q or Left');
  assert.equal(actions.popupCloseHint(reader('default')), 'q or Esc');

  const lynx = reader('lynx');
  lynx.keys.preferences = { searchCase: 'CASE_SENSITIVE' };
  assert.equal(actions.searchCase(lynx), 'CASE_SENSITIVE');
  assert.equal(actions.searchCase(reader('default')), null);
  assert.equal(actions.searchCase({ interface: 'lynx' }), null);
});

test('a Lynx internal list keeps the browse map and reads its own bindings', () => {
  const { actions } = harness();
  const state = reader('lynx');
  state.keys = keymap({ browse: { q: 'confirm-quit' } });
  assert.equal(actions.libraryKeepsBrowseMap(state), true);
  assert.equal(actions.libraryAction(state, 'q'), 'confirm-quit');
  assert.equal(actions.libraryAction(reader('default'), 'q'), null);
});

test('Lynx moves off a field with the arrows and stays in the browse map', () => {
  const { actions } = harness();
  const lynx = reader('lynx');
  assert.equal(actions.tabArrow(lynx, '[ArrowUp]'), true);
  assert.equal(actions.tabArrow(lynx, '[ArrowDown]'), true);
  assert.equal(actions.tabArrow(lynx, 'x'), false);
  assert.equal(actions.tabArrow(reader('default'), '[ArrowUp]'), false);
  assert.equal(actions.tabLandedMode(lynx), 'browse');
  assert.equal(actions.tabLandedMode(reader('default')), 'forms');
  assert.equal(actions.tabTypingStatus(lynx, 'Query'),
    'Enter text. Use arrows or Tab to move off of field.');
  assert.match(actions.tabTypingStatus(reader('default'), 'Query'), /^Typing into "Query"/);

  lynx.keys.preferences = { textfieldsNeedActivation: true };
  assert.equal(actions.tabNeedsActivation(lynx), true);
  assert.equal(actions.tabNeedsActivation(reader('default')), false);
});

test('the line-editor command escape is Lynx only', () => {
  const { actions } = harness();
  const state = reader('lynx');
  state.keys = keymap({ edit: { '\x16': 'edit-command' } });
  assert.equal(actions.typeCommand(state, '\x16'), true);
  assert.equal(actions.typeCommand(state, 'x'), false);
  assert.equal(actions.typeCommand(reader('default'), '\x16'), false);
});
