'use strict';

// The Lynx key decisions the terminal loop dispatches to, differenced between
// the JavaScript original and the Crystal port. Both run the same questions
// against a fake host that records every call, so the exact behavior and the
// interface-not-keymap gate are pinned without a terminal. Every case here
// existed before the dispatch moved; test/lynx_isolation.test.js still proves
// the same gate through src/index.js.

const test = require('node:test');
const assert = require('node:assert');

const { lynxActionsImplementations } = require('./crystal_impl');

const implementations = lynxActionsImplementations();

for (const implementation of implementations) {
  test(`${implementation.name}: active is the one interface gate`, () => {
    const h = implementation.harness();
    assert.equal(h.active(h.reader('lynx')), true);
    assert.equal(h.active(h.reader('default')), false);
    // A state with no interface at all is not Lynx either; the Crystal state
    // models the same outcome with its "default" fallback.
  });

  test(`${implementation.name}: a digit starts the number prompt only when the profile numbers items`, () => {
    const h = implementation.harness();
    const state = h.reader('lynx');
    assert.equal(h.digit('5', state), false, 'no numbering preference yet');
    h.setPreferences(state, { numberLinks: true, numberFields: false });
    assert.equal(h.digit('5', state), true);
    assert.deepEqual(h.calls.pop(), ['number', '5']);
    // A non-digit, and the default interface, derive nothing.
    assert.equal(h.digit('x', state), false);
    h.setInterface(state, 'default');
    assert.equal(h.digit('5', state), false);
  });

  test(`${implementation.name}: the Lynx screens are reached only in the Lynx interface`, async () => {
    const h = implementation.harness();
    const state = h.reader('lynx');
    for (const [action, label] of [
      ['help', 'help'], ['context-help', 'describe'], ['main-menu', 'main-menu'],
      ['toggle-trace', 'toggle-trace'], ['trace-log', 'trace-log'], ['options', 'options'],
    ]) {
      h.calls.length = 0;
      assert.equal(await h.action(action, state, {}), true, action);
      assert.deepEqual(h.calls.pop(), [label], action);
      h.setInterface(state, 'default');
      assert.equal(await h.action(action, state, {}), false, `${action} outside Lynx`);
      h.setInterface(state, 'lynx');
    }
  });

  test(`${implementation.name}: link-number opens the prompt whatever the interface says`, async () => {
    // The action exists only in the Lynx map, and reaching it has always
    // opened the prompt; the move must not add a gate that was not there.
    const h = implementation.harness();
    h.reader('default');
    assert.equal(await h.action('link-number', {}, {}), true);
    assert.deepEqual(h.calls.pop(), ['number', undefined]);
  });

  test(`${implementation.name}: an unknown action falls through untouched`, async () => {
    const h = implementation.harness();
    h.reader('lynx');
    assert.equal(await h.action('next-line', {}, {}), false);
    assert.equal(h.calls.length, 0);
  });

  test(`${implementation.name}: quick navigation enters a text field unless activation is required`, async () => {
    const h = implementation.harness();
    const state = h.reader('lynx', { item: { role: 'textbox', name: 'Query' } });
    await h.afterQuickNav({ line: 0, col: 0 }, state, {});
    assert.deepEqual(h.calls, [['beginTyping'], ['status', 'Enter text. Use arrows or Tab to move off of field.']]);

    // TEXTFIELDS_NEED_ACTIVATION leaves the field alone.
    h.calls.length = 0;
    h.setPreferences(state, { textfieldsNeedActivation: true });
    await h.afterQuickNav({ line: 0, col: 0 }, state, {});
    assert.deepEqual(h.calls, []);

    // A non-field, a missed jump, and the default interface all do nothing.
    h.calls.length = 0;
    h.setPreferences(state, {});
    h.setItem(state, { role: 'link', name: 'News' });
    await h.afterQuickNav({ line: 0, col: 0 }, state, {});
    await h.afterQuickNav(null, state, {});
    h.setInterface(state, 'default');
    h.setItem(state, { role: 'textbox', name: 'Query' });
    await h.afterQuickNav({ line: 0, col: 0 }, state, {});
    assert.deepEqual(h.calls, []);
  });

  test(`${implementation.name}: the popup close hint and searching type are per interface`, () => {
    const h = implementation.harness();
    assert.equal(h.popupCloseHint(h.reader('lynx')), 'q or Left');
    assert.equal(h.popupCloseHint(h.reader('default')), 'q or Esc');

    const lynx = h.reader('lynx');
    h.setPreferences(lynx, { searchCase: 'CASE_SENSITIVE' });
    assert.equal(h.searchCase(lynx), 'CASE_SENSITIVE');
    assert.equal(h.searchCase(h.reader('default')), null);
    assert.equal(h.searchCase(h.reader('lynx')), null);
  });

  test(`${implementation.name}: a Lynx internal list keeps the browse map and reads its own bindings`, () => {
    const h = implementation.harness();
    const state = h.reader('lynx');
    h.setKeys(state, h.keymap({ browse: { q: 'confirm-quit' } }));
    assert.equal(h.libraryKeepsBrowseMap(state), true);
    assert.equal(h.libraryAction(state, 'q'), 'confirm-quit');
    h.reader('default');
    assert.equal(h.libraryAction({}, 'q'), null);
  });

  test(`${implementation.name}: Lynx moves off a field with the arrows and stays in the browse map`, () => {
    const h = implementation.harness();
    const lynx = h.reader('lynx');
    assert.equal(h.tabArrow(lynx, '[ArrowUp]'), true);
    assert.equal(h.tabArrow(lynx, '[ArrowDown]'), true);
    assert.equal(h.tabArrow(lynx, 'x'), false);
    h.reader('default');
    assert.equal(h.tabArrow({}, '[ArrowUp]'), false);
    assert.equal(h.tabLandedMode(h.reader('lynx')), 'browse');
    assert.equal(h.tabLandedMode(h.reader('default')), 'forms');
    assert.equal(h.tabTypingStatus(h.reader('lynx'), 'Query'),
      'Enter text. Use arrows or Tab to move off of field.');
    assert.match(h.tabTypingStatus(h.reader('default'), 'Query'), /^Typing into "Query"/);

    const needs = h.reader('lynx');
    h.setPreferences(needs, { textfieldsNeedActivation: true });
    assert.equal(h.tabNeedsActivation(needs), true);
    assert.equal(h.tabNeedsActivation(h.reader('default')), false);
  });

  test(`${implementation.name}: the line-editor command escape is Lynx only`, () => {
    const h = implementation.harness();
    const state = h.reader('lynx');
    h.setKeys(state, h.keymap({ edit: { '\x16': 'edit-command' } }));
    assert.equal(h.typeCommand(state, '\x16'), true);
    assert.equal(h.typeCommand(state, 'x'), false);
    h.reader('default');
    assert.equal(h.typeCommand({}, '\x16'), false);
  });
}
