'use strict';

// The other half of compatibility: nothing about the Lynx interface may reach
// a reader who has not asked for it. Every feature below is gated on
// state.interface or on the profile the keymap was built with, and each test
// here drives the feature's own code path with the default interface to prove
// the gate holds — including the case where a Lynx keymap or preference has
// somehow ended up on a default-interface state.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./tmpdir');
const { Keymap } = require('../src/keys');
const {
  contextNavigationAction, handleBrowseKey, hintText, relayout, renderRow,
} = require('../src/index');

function item(role, name, extra = {}) { return { role, name, ...extra }; }

function lynxKeys() {
  return new Keymap({ terminfo: {}, profile: 'lynx', load: false });
}

test('the default interface lays out and renders the core blocks unchanged', () => {
  const blocks = [
    { text: '# Heading', item: item('heading', 'Heading', { level: 1 }) },
    { text: '{News}', item: item('link', 'News') },
    { text: '[*Save]', item: item('button', 'Save') },
  ];
  const state = {
    // No interface at all is the same as the default one.
    keys: lynxKeys(),
    escapeUnicode: false, cursor: 1, scroll: 0, col: 0,
    core: { blocks, at() {} },
    lines: [], library: null, dialog: null,
  };
  relayout(state);
  assert.deepEqual(state.lines.map((line) => line.text),
    ['# Heading', '{News}', '[*Save]']);
  for (const line of state.lines) {
    assert.ok(!line.displayNumber);
    assert.ok(!line.displayPrefix);
    assert.ok(!line.displaySuffix);
    assert.ok(!line.displayIndent);
  }
  assert.equal(renderRow(state, 0), '# Heading', 'headings are not bold by default');
  assert.equal(renderRow(state, 1), '{News}', 'the current link is not reverse-video');
});

test('default hints keep their own wording', () => {
  assert.match(hintText({ mode: 'browse' }), /^j\/k line/);
  assert.equal(hintText({ interface: 'default', mode: 'type' }),
    'Typing — Tab: next control  Esc: stop  Enter: submit');
  assert.equal(hintText({ interface: 'default', mode: 'number' }),
    'Follow link number — Enter: follow  g: move  Esc: cancel');
});

test('transient navigation ignores Lynx bindings outside the Lynx interface', () => {
  // A lynx keymap on a default-interface state: the physical h/j/k/l keys are
  // still only their own TAWB actions, so no context operation is derived.
  const state = { interface: 'default', keys: lynxKeys() };
  for (const chunk of ['h', 'j', 'k', 'l', '\x1b[D', '\x1b[C']) {
    assert.equal(contextNavigationAction(chunk, state), null, JSON.stringify(chunk));
  }
  // The gate is the interface, not the keymap: the same binding answers in
  // the Lynx interface and is ignored outside it.
  assert.equal(contextNavigationAction('b', { interface: 'lynx', keys: lynxKeys() }),
    'page-previous');
  assert.equal(contextNavigationAction('b', { interface: 'default', keys: lynxKeys() }), null);
});

test('digits are never a link number outside the Lynx interface', async () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  // Even a numbering preference that a Lynx import would have set is not
  // enough: the digit shortcut is gated on the interface too.
  keys.preferences = { numberLinks: true, numberFields: true };
  const state = {
    interface: 'default', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keys, inputSeen: false, library: null, dialog: null, statusMsg: '', drawn: {},
    core: { blocks: [{ text: 'News', item: item('link', 'News') }], at() {}, markInput() {} },
    lines: [{ blockIndex: 0, text: 'News', displayNumber: 1 }],
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await handleBrowseKey('2', state, { url: () => 'https://example.test/' });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(state.mode, 'browse');
  assert.equal(state.linkNumber, undefined);
});

test('the two interfaces read their own key files and nothing else', () => {
  const directory = tempDir('tawb-interface-files-');
  const ordinaryFile = path.join(directory, 'keys.json');
  const lynxFile = path.join(directory, 'keys-lynx.json');
  fs.writeFileSync(ordinaryFile, JSON.stringify({ version: 1, actions: { quit: ['~'] } }));
  fs.writeFileSync(lynxFile, JSON.stringify({ version: 1, actions: { 'confirm-quit': ['y'] } }));

  const ordinary = new Keymap({ terminfo: {}, file: ordinaryFile });
  assert.equal(ordinary.actionFor('~'), 'quit');
  assert.equal(ordinary.actionFor('y'), null, 'keys-lynx.json was not read');

  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', file: lynxFile });
  assert.equal(lynx.actionFor('y'), 'confirm-quit');
  assert.equal(lynx.actionFor('~'), null, 'keys.json was not read');
});

test('default bindings and actions are the ones TAWB always had', () => {
  const keys = new Keymap({ terminfo: {}, load: false });
  assert.equal(keys.actionFor('g'), 'top');
  assert.equal(keys.actionFor('\\'), 'cycle-view');
  assert.equal(keys.actionFor('l'), 'next-link');
  assert.equal(keys.actionFor('k'), 'previous-line');
  assert.equal(keys.actionFor('='), 'where');
  assert.equal(keys.actionFor('0'), null);
  assert.equal(keys.actionFor('A'), null);
  assert.equal(keys.editingActionFor('\x16'), null, 'Ctrl+V is not a command escape');
  // The actions the Lynx interface added are not in the default interface at
  // all, so the keyboard screen cannot offer a reader a key for one.
  for (const id of ['document-info', 'link-number', 'list-links', 'options', 'help']) {
    assert.equal(keys.byId.get(id), undefined, id);
  }
});

test('each keyboard screen offers only its own interface\'s actions', () => {
  const { wizardRows } = require('../src/key_wizard');
  const ordinary = new Keymap({ terminfo: {}, load: false });
  const lynx = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  const offered = (keys) => new Set(wizardRows(keys)
    .filter((row) => row.type === 'action').map((row) => row.action.id));

  const ordinaryIds = offered(ordinary);
  const lynxIds = offered(lynx);
  for (const id of ['help', 'main-menu', 'options', 'document-info', 'list-links', 'source-view']) {
    assert.equal(ordinaryIds.has(id), false, `${id} is offered by the default wizard`);
    assert.equal(lynxIds.has(id), true, `${id} is missing from the Lynx wizard`);
  }
  // Quick navigation belongs to the ordinary reading keys. Lynx moves through
  // a page with numbers and pages, so none of it is offered there.
  for (const id of ['next-heading', 'next-field', 'next-paragraph', 'toggle-live', 'where']) {
    assert.equal(lynxIds.has(id), false, `${id} leaked into the Lynx wizard`);
  }
});

test('each profile saves to its own file', () => {
  assert.equal(path.basename(new Keymap({ terminfo: {}, profile: 'default', load: false }).file),
    'keys.json');
  assert.equal(path.basename(new Keymap({ terminfo: {}, profile: 'lynx', load: false }).file),
    'keys-lynx.json');
});
