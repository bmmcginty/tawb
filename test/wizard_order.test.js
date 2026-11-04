'use strict';

// The keyboard screen's display order is a table of its own. It must not be
// the order of ACTIONS, which decides which action wins a shared key, and it
// must not lose an action: a binding the reader cannot find is a binding they
// cannot change.

const test = require('node:test');
const assert = require('node:assert');

const { ACTIONS } = require('../src/keys');
const { profilesFor } = require('../src/interfaces');
const { WIZARD_SECTIONS, sectionsFor } = require('../src/wizard_order');

const named = new Set(WIZARD_SECTIONS.flatMap((section) => section.actions));

test('every action in either interface has a place in the table', () => {
  const missing = ACTIONS.map((action) => action.id).filter((id) => !named.has(id));
  assert.deepEqual(missing, [],
    `actions with no section, which would fall into Other: ${missing.join(', ')}`);
});

test('no action is named twice', () => {
  const seen = new Set();
  const duplicates = [];
  for (const section of WIZARD_SECTIONS) {
    for (const id of section.actions) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
  }
  assert.deepEqual(duplicates, []);
});

test('a profile sees only its own actions, in the table order and without empty headings', () => {
  const ordinary = sectionsFor(ACTIONS.filter((action) => profilesFor(action.id).includes('default')));
  assert.deepEqual(ordinary.map((section) => section.title), [
    'Leave, and run a command',
    'Page: move',
    'Page: jump by feature',
    'Page: act on the current line',
    'Page: find',
    'Page: address, history and tabs',
    'Page: view, refresh and status',
    'Lists: page references and browser data',
    'Browser dialogs',
    'Editing a field',
    'Help, setup and diagnostics',
  ]);
  // The reader's order from the move section: character before line.
  assert.deepEqual(ordinary[1].rows.map((action) => action.id).slice(0, 4),
    ['next-character', 'previous-character', 'next-line', 'previous-line']);
  // Download precedes the webpage keyboard, as asked.
  assert.deepEqual(ordinary[3].rows.map((action) => action.id),
    ['activate', 'real-click', 'hover-line', 'close-popup',
      'download-link', 'page-keyboard']);

  const lynx = sectionsFor(ACTIONS.filter((action) => profilesFor(action.id).includes('lynx')));
  assert.equal(lynx.some((section) => section.title === 'Browser dialogs'), true);
  assert.equal(lynx.find((section) => section.title === 'Page: move')
    .rows.some((action) => action.id === 'next-half-screen'), true);
});

test('an action the table does not name is kept in a trailing section', () => {
  const actions = [
    { id: 'quit', label: 'Quit' },
    { id: 'future-action', label: 'Something new' },
  ];
  assert.deepEqual(sectionsFor(actions).map((section) => [section.key, section.rows.map((row) => row.id)]), [
    ['leave', ['quit']],
    ['other', ['future-action']],
  ]);
});
