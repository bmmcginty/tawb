'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderLynxItem, renderLynxBlock } = require('../src/lynx_display');
const { hintText, moveSelection, relayout, renderRow, typingText } = require('../src/index');

function item(role, name, extra = {}) { return { role, name, ...extra }; }

function captureTerminal(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { fn(); } finally { process.stdout.write = write; }
  return chunks.join('');
}

test('the Lynx browse hint uses Lynx wording', () => {
  assert.equal(hintText({ interface: 'lynx', mode: 'browse' }),
    "Commands: Use arrow keys to move, '?' for help, 'q' to quit, '<-' to go back.");
});

test('the Lynx renderer uses Lynx form markers', () => {
  assert.equal(renderLynxItem(item('link', 'News')), 'News');
  assert.equal(renderLynxItem(item('button', 'Submit')), 'Submit');
  assert.equal(renderLynxItem(item('checkbox', 'Updates', { checked: false })), '[ ] Updates');
  assert.equal(renderLynxItem(item('checkbox', 'Updates', { checked: true })), '[X] Updates');
  assert.equal(renderLynxItem(item('checkbox', 'Updates', { checked: 'mixed' })), '[-] Updates');
  assert.equal(renderLynxItem(item('radio', 'Weekly', { checked: false })), '( ) Weekly');
  assert.equal(renderLynxItem(item('radio', 'Weekly', { checked: true })), '(*) Weekly');
  assert.equal(
    renderLynxItem(item('textbox', 'Search', { value: 'lynx' })),
    `Search lynx${'_'.repeat(16)}`,
  );
  assert.equal(renderLynxItem(item('combobox', 'Country', { value: 'Canada' })),
    'Country [Canada]');
  assert.equal(renderLynxItem(item('img', 'Map')), 'Map');
  assert.equal(renderLynxItem(item('img', '')), '[IMAGE]');
});

test('Lynx presentation is a display copy rather than changed core text', () => {
  const block = { text: '[*Save]', item: item('button', 'Save'), startsBlock: true };
  const rendered = renderLynxBlock(block);
  assert.equal(rendered.text, 'Save');
  assert.equal(block.text, '[*Save]');
  assert.notEqual(rendered, block);
});

test('Lynx relayout uses the profile renderer without changing core blocks', () => {
  const blocks = [{ text: '[*Save]', item: item('button', 'Save') }];
  const state = {
    interface: 'lynx', escapeUnicode: false, cursor: 0, scroll: 0, col: 0,
    library: null, dialog: null, core: { blocks, at() {} },
  };
  relayout(state);
  assert.equal(state.lines[0].text, 'Save');
  assert.equal(blocks[0].text, '[*Save]');
});

test('the current Lynx control is highlighted across wrapped rows', () => {
  const blocks = [{ text: 'A long link', item: item('link', 'A long link') }];
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, library: null, dialog: null,
    core: { blocks },
    lines: [
      { blockIndex: 0, text: 'A long', continuation: false },
      { blockIndex: 0, text: 'link', continuation: true },
    ],
  };
  assert.equal(renderRow(state, 0), '\x1b[7mA long\x1b[0m');
  assert.equal(renderRow(state, 1), '\x1b[7mlink\x1b[0m');
  assert.equal(state.lines[0].text, 'A long', 'ANSI did not enter searchable line text');
});

test('moving between Lynx links removes the old highlight and draws the new one', () => {
  const blocks = [
    { text: 'First', item: item('link', 'First') },
    { text: 'Second', item: item('link', 'Second') },
  ];
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    library: null, dialog: null, linkAddress: false, statusMsg: '', drawn: {},
    core: { blocks, at() {} },
    lines: [{ blockIndex: 0, text: 'First' }, { blockIndex: 1, text: 'Second' }],
  };
  const output = captureTerminal(() => moveSelection(state, 1, { url: () => 'https://example.test/' }));
  assert.ok(output.includes('\x1b[2KFirst'), JSON.stringify(output));
  assert.ok(output.includes('\x1b[2K\x1b[7mSecond\x1b[0m'), JSON.stringify(output));
});

test('Lynx headings are bold while ordinary prose remains plain', () => {
  const blocks = [
    { text: 'Heading', item: item('heading', 'Heading') },
    { text: 'Prose', item: item('text', 'Prose') },
  ];
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 1, library: null, dialog: null,
    core: { blocks },
    lines: [
      { blockIndex: 0, text: 'Heading' },
      { blockIndex: 1, text: 'Prose' },
    ],
  };
  assert.equal(renderRow(state, 0), '\x1b[1mHeading\x1b[0m');
  assert.equal(renderRow(state, 1), 'Prose');
});

test('editing a field retains Lynx label and underscore presentation', () => {
  const shown = typingText({
    interface: 'lynx', escapeUnicode: false,
    typing: { item: item('textbox', 'Search'), text: 'cat', caret: 2 },
  });
  assert.equal(shown.text, `Search cat${'_'.repeat(17)}`);
  assert.equal(shown.caretCol, 10);
});
