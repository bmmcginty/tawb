'use strict';

// The three classes of extra information and where a reader asked to hear
// them: context (the landmark, group, table cell), annotations (description,
// error, keystroke, described role, popup) and notes (asides).

const test = require('node:test');
const assert = require('node:assert');

const {
  displayMode, displaySettings, DEFAULTS,
} = require('../src/display');

test('a mode is one of the three, and nothing else is accepted', () => {
  for (const mode of ['inline', 'status', 'off']) assert.equal(displayMode('context', mode), mode);
  assert.equal(displayMode('context', undefined), DEFAULTS.context);
  assert.throws(() => displayMode('context', 'loud'), /Unknown context mode loud; use inline, status or off/);
  assert.deepEqual(displaySettings({ notes: 'off' }),
    { context: 'off', annotations: 'status', notes: 'off' });
});

const { buildBlocks } = require('../src/blocks');
const { rowDetail, contextLabel } = require('../src/display');

const main = (depth) => ({ role: 'main', name: '', container: true, depth });
const nav = (depth, name) => ({ role: 'navigation', name, container: true, depth });
const link = (depth, name, extra = {}) => ({ role: 'link', name, href: '/x', depth, ...extra });
const text = (depth, name) => ({ role: 'text', name, depth });
// The extractor puts a boundary around every block-level container; without
// one, consecutive prose is one sentence.
const BR = { role: '__break__', name: '' };

const ITEMS = [
  main(0), BR,
  text(1, 'Welcome'), BR,
  nav(1, 'Breadcrumb'), BR,
  link(2, 'Home'), BR,
  link(2, 'Docs'), BR,
];

test('containers never become lines, whatever the settings say', () => {
  for (const context of ['off', 'status']) {
    assert.deepEqual(buildBlocks(ITEMS, { context }).map((block) => block.text),
      ['Welcome', '{Home}', '{Docs}'], `a container became a line with context=${context}`);
  }
  // Inline context is a prefix on the line, never a line of its own.
  assert.equal(buildBlocks(ITEMS, { context: 'inline' }).length, 3);
});

test('context in the status row travels with the line it belongs to', () => {
  const blocks = buildBlocks(ITEMS, { context: 'status' });
  const home = blocks.find((block) => block.item.name === 'Home');
  assert.deepEqual(home.context, [{ role: 'main', name: '' }, { role: 'navigation', name: 'Breadcrumb' }]);
  assert.equal(rowDetail(home, { context: 'status', annotations: 'off', notes: 'off' }),
    'in: main › navigation Breadcrumb');
  const welcome = blocks.find((block) => block.text === 'Welcome');
  assert.equal(rowDetail(welcome, { context: 'status', annotations: 'off', notes: 'off' }), 'in: main');
});

test('context inline is said once at the start of a run', () => {
  const blocks = buildBlocks(ITEMS, { context: 'inline' });
  const lines = blocks.map((block) => block.text);
  assert.deepEqual(lines, [
    'in: main — Welcome',
    'in: main › navigation Breadcrumb — {Home}',
    '{Docs}',
  ]);
  assert.equal(lines.filter((line) => line.includes('in: ')).length, 2,
    'the context was not said once per run');
});

test('a context path names the role and only the name a container has', () => {
  assert.equal(contextLabel([{ role: 'main', name: '' }, { role: 'list', name: 'Results' }]),
    'main › list Results');
  assert.equal(contextLabel([]), '');
});
