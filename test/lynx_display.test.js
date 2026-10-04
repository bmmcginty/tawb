'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { numberLynxBlocks, renderLynxItem, renderLynxBlock } = require('../src/lynx_display');
const { layoutLines } = require('../src/layout');
const {
  handleNumberKey, hintText, moveSelection, openLinkNumberPrompt, relayout, renderRow, typingText,
} = require('../src/index');
const { Keymap } = require('../src/keys');

function item(role, name, extra = {}) { return { role, name, ...extra }; }

function captureTerminal(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { fn(); } finally { process.stdout.write = write; }
  return chunks.join('');
}

async function captureTerminalAsync(fn) {
  const write = process.stdout.write;
  const chunks = [];
  process.stdout.write = (text) => { chunks.push(String(text)); return true; };
  try { await fn(); } finally { process.stdout.write = write; }
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

test('Lynx numbers links and fields in one reading-order sequence', () => {
  const blocks = [
    { text: 'intro', item: item('text', 'intro') },
    { text: 'News', item: item('link', 'News') },
    { text: 'Search ____________________', item: item('textbox', 'Search') },
    { text: 'Go', item: item('button', 'Go') },
  ];
  const numbered = numberLynxBlocks(blocks, {
    numberLinks: true, numberFields: true,
    numberLinksOnLeft: true, numberFieldsOnLeft: false,
  });
  assert.equal(numbered[0].displayNumber, undefined);
  assert.equal(numbered[1].displayPrefix, '[1]');
  assert.equal(numbered[2].displaySuffix, '[2]');
  assert.equal(numbered[3].displaySuffix, '[3]');

  const lines = layoutLines(numbered, 20);
  assert.equal(lines.find((line) => line.blockIndex === 1).text, 'News');
  assert.equal(lines.find((line) => line.blockIndex === 1).displayPrefix, '[1]');
  assert.equal(lines.findLast((line) => line.blockIndex === 2).displaySuffix, '[2]');
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
  state.lines[0].displayPrefix = '[1]';
  assert.equal(renderRow(state, 0), '[1]\x1b[7mA long\x1b[0m');
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

test('the number prompt snapshots targets and moves to numbered fields', async () => {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: true };
  const blocks = [
    { text: 'News', item: item('link', 'News') },
    { text: 'Search', item: item('textbox', 'Search') },
  ];
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keys, keyReader: null, inputSeen: false, library: null, dialog: null,
    linkAddress: false, statusMsg: '', drawn: {},
    core: { blocks, at() {}, markInput() {} },
    lines: [
      { blockIndex: 0, text: 'News', displayNumber: 1, displayPrefix: '[1]' },
      { blockIndex: 1, text: 'Search', displayNumber: 2, displayPrefix: '[2]' },
    ],
  };
  const page = { url: () => 'https://example.test/' };
  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '2');
    assert.equal(state.mode, 'number');
    await handleNumberKey('\r', state, page);
  });
  assert.equal(state.mode, 'browse');
  assert.equal(state.cursor, 1);
  assert.equal(state.statusMsg, 'Link 2.');

  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '9');
    await handleNumberKey('\r', state, page);
  });
  assert.equal(state.cursor, 1, 'an invalid number did not move the cursor');
  assert.equal(state.statusMsg, 'No link 9 on this page.');
});

test('the number prompt keeps its captured block identity across page changes', async () => {
  const original = { text: 'Original', item: item('link', 'Original') };
  const replacement = { text: 'Replacement', item: item('link', 'Replacement') };
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true };
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keys, keyReader: null, inputSeen: false,
    library: null, dialog: null, linkAddress: false, statusMsg: '', drawn: {},
    core: { blocks: [original], at() {}, markInput() {} },
    lines: [{ blockIndex: 0, text: 'Original', displayNumber: 1 }],
  };
  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '1');
    state.core.blocks = [replacement];
    state.lines = [{ blockIndex: 0, text: 'Replacement', displayNumber: 1 }];
    await handleNumberKey('g', state, { url: () => 'https://example.test/' });
  });
  assert.equal(state.statusMsg, 'No link 1 on this page.');
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
