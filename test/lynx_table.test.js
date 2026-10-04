'use strict';

// A Lynx table row on one line, without a browser.
//
// The extractor's table metadata is covered against a real browser in
// test/browser/table_meta.test.js. What is tested here is everything after it:
// that a row becomes one display line with its columns lined up, that the
// spans it carries keep every cell reachable — cursor, activation item, quick
// navigation, the number prompt, a wrap — and that a row the layout cannot do
// (a cell holding a list) is left in reading order instead of being mangled.

const test = require('node:test');
const assert = require('node:assert');

const { layoutLines } = require('../src/layout');
const { renderLynxItem } = require('../src/lynx_display');
const { Keymap } = require('../src/keys');
const {
  blockUnder, currentBlock, handleBrowseKey, handleNumberKey, itemUnderCursor,
  openLinkNumberPrompt, positionForBlock, relayout, renderRow,
} = require('../src/index');

function item(role, name, extra = {}) { return { role, name, ...extra }; }

const at = (row, cell, extra = {}) => ({ id: 1, row, cell, header: false, ...extra });

function lynxState(blocks, preferences = {}) {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  // Activation of a field is a browser path with its own tests; these tests
  // are about where the cursor is, so nothing auto-enters here.
  keys.preferences = { numberLinks: true, numberFields: true, textfieldsNeedActivation: true, ...preferences };
  return {
    interface: 'lynx', mode: 'browse', keys, lines: [], cursor: 0, col: 0, scroll: 0,
    library: null, dialog: null, statusMsg: '', drawn: {}, inputSeen: false,
    core: { blocks, at() {}, markInput() {}, live: { refreshing: false } },
  };
}

function tableBlocks() {
  return [
    { text: 'Name', item: item('text', 'Name', { table: at(0, 0, { header: true }) }) },
    { text: 'Detail', item: item('text', 'Detail', { table: at(0, 1, { header: true }) }) },
    { text: '{Alpha}', item: item('link', 'Alpha', { href: '#one', table: at(1, 0) }) },
    { text: '(image) A picture', item: item('img', 'A picture', { table: at(1, 1) }) },
    { text: '[Cell field: v]', item: item('textbox', 'Cell field', { value: 'v', table: at(2, 0) }) },
    { text: 'Last', item: item('text', 'Last', { table: at(2, 1) }) },
  ];
}

function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  return Promise.resolve().then(fn).finally(() => { process.stdout.write = write; });
}

test('a row becomes one line with its columns lined up', () => {
  const state = lynxState(tableBlocks());
  relayout(state);
  const [header, first, second] = state.lines;

  assert.equal(header.spans.length, 2, 'the header row kept both cells');
  assert.equal(first.spans.length, 2, 'the link row kept both cells');
  assert.equal(first.text.indexOf('A picture'), header.text.indexOf('Detail'),
    'the second column starts at the same place in both rows');
  assert.equal(second.text.indexOf('Last'), header.text.indexOf('Detail'),
    'and in the row below');

  // The number sits immediately before its cell, and the span is the text, not
  // the marker, so the marker is never highlighted with the thing it numbers.
  assert.equal(first.text.slice(first.spans[0].start - 3, first.spans[0].start), '[1]');
  assert.equal(first.text.slice(first.spans[0].start, first.spans[0].end), 'Alpha');
  assert.equal(first.spans[0].displayNumber, 1);
  assert.equal(second.spans[0].displayNumber, 2);
});

test('the caret resolves to the cell it is standing in', () => {
  const state = lynxState(tableBlocks());
  relayout(state);
  const row = state.lines[1];

  state.cursor = 1;
  state.col = row.spans[0].start;
  assert.equal(currentBlock(state), state.core.blocks[2]);
  assert.equal(itemUnderCursor(state).name, 'Alpha');

  state.col = row.spans[1].start;
  assert.equal(currentBlock(state), state.core.blocks[3]);
  assert.equal(itemUnderCursor(state).name, 'A picture');

  // Anywhere in the padding before the second cell still means the first.
  state.col = row.spans[0].end + 1;
  assert.equal(currentBlock(state), state.core.blocks[2]);
});

test('only the current cell is highlighted, and not its number', () => {
  const state = lynxState(tableBlocks());
  relayout(state);
  state.cursor = 1;
  state.col = state.lines[1].spans[0].start;

  const rendered = renderRow(state, 1);
  assert.ok(rendered.includes('\x1b[7mAlpha\x1b[0m'), JSON.stringify(rendered));
  assert.ok(!rendered.includes('\x1b[7m[1]'), 'the number is outside the highlight');
  assert.ok(rendered.includes('A picture'), 'the other cell is still on the line');

  state.col = state.lines[1].spans[1].start;
  const second = renderRow(state, 1);
  assert.ok(!second.includes('\x1b[7m'), 'a plain text cell is not highlighted');
});

test('quick navigation lands on the cell, not the start of the row', async () => {
  const state = lynxState(tableBlocks());
  relayout(state);
  state.cursor = 0;
  state.col = 0;

  await quietly(() => handleBrowseKey('\x1b[B', state, {}));
  assert.equal(state.cursor, 1, 'down moved to the link row');
  assert.equal(state.col, state.lines[1].spans[0].start, 'and to the link itself');
  assert.equal(itemUnderCursor(state).name, 'Alpha');

  await quietly(() => handleBrowseKey('\x1b[B', state, {}));
  assert.equal(state.cursor, 2);
  assert.equal(state.col, state.lines[2].spans[0].start);
  assert.equal(itemUnderCursor(state).name, 'Cell field');
});

test('a number in a row prompts, moves, and names the cell it moved to', async () => {
  const state = lynxState(tableBlocks());
  relayout(state);

  let answer;
  await quietly(async () => {
    openLinkNumberPrompt(state);
    assert.deepEqual([...state.linkNumber.map.keys()], [1, 2]);
    await handleNumberKey('1', state, {});
    answer = await handleNumberKey('g', state, {});
  });
  assert.equal(answer, undefined);
  assert.equal(state.cursor, 1, 'the link row');
  assert.equal(state.col, state.lines[1].spans[0].start, 'the link cell');
  assert.equal(state.statusMsg, 'Link 1.');

  // A field number moves without submitting, and its own cell is found.
  await quietly(async () => {
    openLinkNumberPrompt(state);
    await handleNumberKey('2', state, {});
    await handleNumberKey('g', state, {});
  });
  assert.equal(state.cursor, 2);
  assert.equal(state.col, state.lines[2].spans[0].start);
  assert.equal(state.statusMsg, 'Link 2.');
});

test('inline prose and a link make one cell before its row is laid out', () => {
  const blocks = [
    { text: 'Heading', item: item('text', 'Heading', { table: at(0, 0, { header: true }) }) },
    { text: 'Value', item: item('text', 'Value', { table: at(0, 1, { header: true }) }) },
    { text: 'Before', item: item('text', 'Before', { flow: 10, table: at(1, 0) }) },
    { text: '{Alpha}', item: item('link', 'Alpha', { flow: 10, href: '#one', table: at(1, 0) }) },
    { text: 'after', item: item('text', 'after', { flow: 10, table: at(1, 0) }) },
    { text: 'Four', item: item('text', 'Four', { flow: 11, table: at(1, 1) }) },
  ];
  const state = lynxState(blocks);
  relayout(state);

  assert.equal(state.lines.length, 2);
  const [header, row] = state.lines;
  assert.equal(row.text.slice(row.spans[0].start, row.spans[0].end), 'Before');
  assert.equal(row.text.slice(row.spans[1].start, row.spans[1].end), 'Alpha');
  assert.equal(row.text.slice(row.spans[2].start, row.spans[2].end), 'after');
  assert.equal(row.text.slice(row.spans[3].start, row.spans[3].end), 'Four');
  assert.equal(row.spans[3].start, header.spans[1].start,
    'the second cell still lines up after its first cell was reflowed');
  assert.equal(row.text.slice(row.spans[1].start - 3, row.spans[1].start), '[1]');
});

test('a row whose cell holds several block-level runs is left in reading order', () => {
  const blocks = [
    { text: 'List cell', item: item('text', 'List cell', { table: at(0, 0) }) },
    { text: 'Second item', item: item('text', 'Second item', { table: at(0, 0) }) },
    { text: 'Plain text', item: item('text', 'Plain text', { table: at(0, 1) }) },
  ];
  const state = lynxState(blocks);
  relayout(state);
  assert.deepEqual(state.lines.map((line) => line.text), ['List cell', 'Second item', 'Plain text']);
  assert.ok(state.lines.every((line) => !line.spans), 'nothing was merged');
});

test('a caption is named, and a colspan widens its column', () => {
  const blocks = [
    { text: 'Cap', item: item('text', 'Cap', { table: { id: 1, caption: true } }) },
    { text: 'A', item: item('text', 'A', { table: at(0, 0, { header: true }) }) },
    { text: 'B', item: item('text', 'B', { table: at(0, 1, { header: true }) }) },
    { text: 'A long spanning sentence', item: item('text', 'A long spanning sentence', { table: at(1, 0, { colspan: 2 }) }) },
  ];
  const state = lynxState(blocks);
  relayout(state);
  assert.equal(state.lines[0].text, 'CAPTION: Cap');
  assert.equal(renderLynxItem(blocks[0].item), 'CAPTION: Cap');
  assert.equal(state.lines[1].spans.length, 2);
  const spanning = state.lines[2];
  assert.equal(spanning.spans.length, 1, 'the spanning row has one cell');
  assert.equal(spanning.spans[0].blockIndex, 3);
});

test('a row wider than the window wraps without losing a span', () => {
  const width = 40;
  const columns = process.stdout.columns;
  process.stdout.columns = width;
  try {
    const long = 'x'.repeat(Math.floor(width * 0.7));
    const blocks = [
      { text: long, item: item('text', long, { table: at(0, 0) }) },
      { text: 'Second', item: item('link', 'Second', { href: '#two', table: at(0, 1) }) },
    ];
    const state = lynxState(blocks);
    relayout(state);
    assert.ok(state.lines.length > 1, 'the row wrapped');
    const flats = state.lines.flatMap((line) => line.spans || []);
    const second = flats.filter((span) => span.blockIndex === 1);
    assert.equal(second.length, 1, 'the second cell appears on exactly one wrapped row');
    for (const line of state.lines) {
      for (const span of line.spans || []) {
        assert.ok(span.start >= 0 && span.end <= line.text.length,
          `span ${span.start}-${span.end} fits line of ${line.text.length}`);
        assert.ok(span.start < span.end, 'a span is not empty');
      }
    }
    // The highlight follows the cell onto whichever wrapped row it landed on.
    const lineIndex = state.lines.findIndex((line) => (line.spans || []).some((span) => span.blockIndex === 1));
    state.cursor = lineIndex;
    state.col = state.lines[lineIndex].spans.find((span) => span.blockIndex === 1).start;
    assert.match(renderRow(state, lineIndex), /\x1b\[7mSecond\x1b\[0m/);
  } finally {
    process.stdout.columns = columns;
  }
});

test('a block in a merged row still has a screen position', () => {
  const state = lynxState(tableBlocks());
  relayout(state);
  assert.deepEqual(positionForBlock(state, 2), { line: 1, col: state.lines[1].spans[0].start });
  assert.deepEqual(positionForBlock(state, 3), { line: 1, col: state.lines[1].spans[1].start });
  assert.equal(positionForBlock(state, 99), null);
  assert.equal(blockUnder(state, state.lines[1], state.lines[1].spans[1].start), state.core.blocks[3]);
});

test('the default interface is untouched by any of it', () => {
  const blocks = tableBlocks();
  const state = {
    interface: 'default',
    core: { blocks, at() {} },
    keys: new Keymap({ terminfo: {}, load: false }),
    lines: [], cursor: 0, col: 0, scroll: 0, library: null, dialog: null,
  };
  relayout(state);
  assert.deepEqual(state.lines.map((line) => line.text), blocks.map((block) => block.text));
  assert.ok(state.lines.every((line) => !line.spans));
  assert.equal(renderRow(state, 2), '{Alpha}');
  assert.equal(layoutLines(blocks, 80).length, blocks.length);
});
