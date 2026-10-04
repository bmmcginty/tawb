'use strict';

// Keeping the reader's place across a view switch.
//
// The four views of one page are four different line lists, so the switch is
// the one movement where a line number means nothing and the element a line
// came from is the only thing that survives. These tests drive the switch
// through handleBrowseKey with a core that describes two views of the same
// page, so the place code runs exactly as it does against a browser.

const test = require('node:test');
const assert = require('node:assert');

const { layoutLines } = require('../src/layout');
const { Keymap } = require('../src/keys');
const { handleBrowseKey } = require('../src/index');

function axBlock(text, index) {
  return { text, item: { role: 'text', name: text, axIndex: index } };
}

function renderBlock(text, index) {
  return { text, item: { role: 'text', name: text, renderIndex: index } };
}

// A core with two views of one page. The accessibility view lists the target
// second; the rendered view puts it after unrelated content, which is what a
// line number cannot survive and an element reference can.
function twoViewCore(renderBlocks) {
  const axBlocks = [axBlock('Intro', 0), axBlock('Target', 1), axBlock('Tail', 2)];
  const core = {
    source: 'ax',
    sourceOf: { ax: axBlocks, render: renderBlocks },
    blocks: axBlocks,
    restoreTo: -1,
    restored: 0,
    anchor: () => ({ source: 'ax', text: 'Target' }),
    restore: () => { core.restored += 1; return core.restoreTo; },
    handleFor: async () => null,
    at() {},
    markInput() {},
    rescan: async () => { core.blocks = core.sourceOf[core.source]; },
  };
  return core;
}

function viewState(core) {
  return {
    core,
    // The switch itself is the same code in both interfaces; the default
    // profile is the one whose behavior must not change.
    interface: 'default',
    keys: new Keymap({ terminfo: {}, load: false }),
    sources: ['ax', 'render'],
    lines: layoutLines(core.blocks, 79),
    cursor: 1,
    col: 0,
    scroll: 0,
    mode: 'browse',
    statusMsg: '',
    statusHeldUntil: 0,
    title: '',
    inputSeen: false,
    library: null,
    dialog: null,
    linkAddress: false,
    drawn: { title: null, address: null, hint: null, status: null },
  };
}

function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; });
}

test('a view switch keeps the reader on the same content, not the same line', async () => {
  const core = twoViewCore([
    renderBlock('Filler', 0), renderBlock('More filler', 1), renderBlock('Target', 2),
  ]);
  const state = viewState(core);
  assert.equal(state.lines[state.cursor].text, 'Target');

  await quietly(() => handleBrowseKey('\\', state, { url: () => 'https://example.test/' }));

  assert.equal(core.source, 'render');
  assert.equal(state.lines[state.cursor].text, 'Target');
  assert.equal(state.statusMsg, 'PAGE view.');
});

test('a place that is gone from the new view falls back to the anchor and says so', async () => {
  const core = twoViewCore([renderBlock('Filler', 0), renderBlock('More filler', 1)]);
  core.restoreTo = 1;
  const state = viewState(core);

  await quietly(() => handleBrowseKey('\\', state, { url: () => 'https://example.test/' }));

  assert.equal(core.source, 'render');
  assert.equal(core.restored, 1, 'the anchor was the fallback');
  assert.equal(state.cursor, 1);
  assert.equal(state.statusMsg, 'PAGE view — nearest place.');
});
