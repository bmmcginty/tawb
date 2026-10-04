'use strict';

// Lynx inline reflow after extraction has retained an HTML flow identity.
//
// Core blocks remain one browser-backed item apiece. Only the Lynx display
// copy joins them, and spans map every piece of the paragraph back to those
// blocks for highlighting, navigation and activation.

const test = require('node:test');
const assert = require('node:assert');

const { Keymap } = require('../src/keys');
const {
  blockUnder, currentBlock, findQuickNav, itemUnderCursor, openLinkNumberPrompt,
  positionForBlock, relayout, renderRow,
} = require('../src/index');

function item(role, name, flow, extra = {}) { return { role, name, flow, ...extra }; }

function blocks() {
  return [
    { text: 'Before', item: item('text', 'Before', 1), startsBlock: true },
    { text: '{one}', item: item('link', 'one', 1, { href: '#one' }) },
    { text: 'after', item: item('text', 'after', 1) },
    { text: 'Second', item: item('text', 'Second', 2), startsBlock: true },
    { text: '{two}', item: item('link', 'two', 2, { href: '#two' }) },
  ];
}

function stateFor(coreBlocks, preferences = {}) {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: false, ...preferences };
  return {
    interface: 'lynx', mode: 'browse', keys, lines: [], cursor: 0, col: 0, scroll: 0,
    library: null, dialog: null, statusMsg: '', drawn: {}, inputSeen: false,
    core: { blocks: coreBlocks, at() {}, live: { refreshing: false } },
  };
}

test('prose and an inline link become one display paragraph, but the next paragraph does not', () => {
  const state = stateFor(blocks());
  relayout(state);

  assert.deepEqual(state.lines.map((line) => line.text), [
    'Before [1]one after',
    'Second [2]two',
  ]);
  assert.deepEqual(state.lines[0].spans.map((span) => span.blockIndex), [0, 1, 2]);
  assert.deepEqual(state.lines[1].spans.map((span) => span.blockIndex), [3, 4]);

  const link = state.lines[0].spans[1];
  assert.equal(state.lines[0].text.slice(link.start, link.end), 'one');
  assert.equal(state.lines[0].text.slice(link.start - 3, link.start), '[1]',
    'the number is before and outside the link span');
});

test('joining follows prose punctuation rather than inserting spaces blindly', () => {
  const state = stateFor([
    { text: 'Open (', item: item('text', 'Open (', 1) },
    { text: '{inside}', item: item('link', 'inside', 1) },
    { text: ',', item: item('text', ',', 1) },
    { text: 'then close)', item: item('text', 'then close)', 1) },
  ], { numberLinks: false });
  relayout(state);
  assert.equal(state.lines[0].text, 'Open (inside, then close)');
});

test('the caret, highlight and number resolve to the original link block', () => {
  const state = stateFor(blocks());
  relayout(state);
  const line = state.lines[0];
  const link = line.spans[1];
  state.cursor = 0;
  state.col = link.start;

  assert.equal(currentBlock(state), state.core.blocks[1]);
  assert.equal(blockUnder(state, line, link.start), state.core.blocks[1]);
  assert.equal(itemUnderCursor(state).name, 'one');
  assert.deepEqual(positionForBlock(state, 1), { line: 0, col: link.start });

  const rendered = renderRow(state, 0);
  assert.match(rendered, /Before \[1\]\x1b\[7mone\x1b\[0m after/);
  assert.ok(!rendered.includes('\x1b[7m[1]'), 'the number is not highlighted');

  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { openLinkNumberPrompt(state); } finally { process.stdout.write = write; }
  assert.equal(state.linkNumber.map.get(1), state.core.blocks[1]);
  assert.equal(state.linkNumber.map.get(2), state.core.blocks[4]);
});

test('a wrapped paragraph keeps every fragment mapped to its source block', () => {
  const columns = process.stdout.columns;
  process.stdout.columns = 20;
  try {
    const state = stateFor([
      { text: 'A sentence before', item: item('text', 'A sentence before', 1) },
      { text: '{a long inline link}', item: item('link', 'a long inline link', 1) },
      { text: 'and prose after it', item: item('text', 'and prose after it', 1) },
    ]);
    relayout(state);
    assert.ok(state.lines.length > 1);
    const linkRows = state.lines.filter((line) => (line.spans || []).some((span) => span.blockIndex === 1));
    assert.ok(linkRows.length >= 1, 'the link survived wrapping');
    const position = positionForBlock(state, 1);
    assert.ok(state.lines[position.line].continuation,
      'the link begins on a continuation row in this fixture');
    state.cursor = 0;
    assert.deepEqual(findQuickNav(state, (one) => one.role === 'link', 1), position,
      'quick navigation finds an item that begins on a continuation row');
    assert.ok(state.lines.some((line) => (line.spans || []).some((span) => span.blockIndex === 2)),
      'the trailing prose survived wrapping');
    for (const line of state.lines) {
      for (const span of line.spans || []) {
        assert.ok(span.start >= 0 && span.end <= line.text.length);
        assert.ok(span.start < span.end);
      }
    }
  } finally {
    process.stdout.columns = columns;
  }
});

test('the default interface leaves the same blocks on separate lines', () => {
  const coreBlocks = blocks();
  const state = {
    interface: 'default', core: { blocks: coreBlocks, at() {} },
    keys: new Keymap({ terminfo: {}, load: false }),
    lines: [], cursor: 0, col: 0, scroll: 0, library: null, dialog: null,
  };
  relayout(state);
  assert.deepEqual(state.lines.map((line) => line.text), coreBlocks.map((block) => block.text));
  assert.ok(state.lines.every((line) => !line.spans));
});
