'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { numberLynxBlocks, renderLynxItem, renderLynxBlock } = require('../src/lynx_display');
const { layoutLines } = require('../src/layout');
const {
  contextNavigationAction, handleBrowseKey, handleNumberKey, hintText,
  moveSelection, openLinkNumberPrompt,
  parseLynxNumberExpression, relativeLinkNumber, relayout, renderRow, typingText,
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
  assert.equal(renderLynxItem(item('iframe', 'about:blank')), 'IFRAME: about:blank');
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
  assert.equal(state.lines[0].displayIndent, 3);
  assert.equal(renderRow(state, 0), '   \x1b[7mSave\x1b[0m');
  assert.equal(blocks[0].text, '[*Save]');
});

test('Lynx layout uses its default margins and heading alignment as metadata', () => {
  const blocks = [
    { text: 'One', item: item('heading', 'One', { level: 1 }) },
    { text: 'Two', item: item('heading', 'Two', { level: 2 }) },
    { text: 'Three', item: item('heading', 'Three', { level: 3 }) },
    { text: 'text', item: item('text', 'text') },
  ].map((block) => renderLynxBlock(block));
  const lines = layoutLines(blocks, 40);
  assert.deepEqual(lines.map((line) => line.displayIndent), [18, 0, 2, 3]);
  assert.deepEqual(lines.map((line) => line.text), ['One', 'Two', 'Three', 'text']);
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

test('Lynx context navigation follows imported vi browse bindings', () => {
  const keys = new Keymap({
    terminfo: {}, profile: 'lynx', load: false,
    bindings: {
      'history-back': ['h'], 'next-focusable': ['j'],
      'previous-focusable': ['k'], activate: ['l'], 'list-links': ['L'],
      'next-screen': ['Ctrl+F'], top: ['Ctrl+A'], bottom: ['Ctrl+E'],
    },
  });
  const state = { interface: 'lynx', keys };
  assert.equal(contextNavigationAction('h', state), 'cancel');
  assert.equal(contextNavigationAction('j', state), 'next');
  assert.equal(contextNavigationAction('k', state), 'previous');
  assert.equal(contextNavigationAction('l', state), 'accept');
  assert.equal(contextNavigationAction('\x06', state), 'page-next');
  assert.equal(contextNavigationAction('\x01', state), 'first');
  assert.equal(contextNavigationAction('\x05', state), 'last');
  assert.equal(contextNavigationAction('j', { ...state, interface: 'default' }), null);
});

test('zero explicitly opens the Lynx number prompt when numbering is hidden', async () => {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: false, numberFields: false };
  const block = { text: 'News', item: item('link', 'News') };
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keys, inputSeen: false, library: null, dialog: null, statusMsg: '', drawn: {},
    core: { blocks: [block], at() {}, markInput() {} },
    lines: [{ blockIndex: 0, text: 'News' }],
  };
  await captureTerminalAsync(() => handleBrowseKey('0', state, {
    url: () => 'https://example.test/',
  }));
  assert.equal(state.mode, 'number');
  assert.equal(state.linkNumber.text, '');
});

test('Lynx number expressions accept page, relative, and move suffixes', () => {
  assert.deepEqual(parseLynxNumberExpression('12'),
    { number: 12, command: 'follow', relative: 0 });
  assert.deepEqual(parseLynxNumberExpression('3p'),
    { number: 3, command: 'page', relative: 0 });
  assert.deepEqual(parseLynxNumberExpression('2+p'),
    { number: 2, command: 'page', relative: 1 });
  assert.deepEqual(parseLynxNumberExpression('2p-'),
    { number: 2, command: 'page', relative: -1 });
  assert.deepEqual(parseLynxNumberExpression('4-g'),
    { number: 4, command: 'move', relative: -1 });
  assert.equal(parseLynxNumberExpression('3pg'), null);

  const prompt = {
    cursor: 4,
    targets: [
      { number: 1, line: 0 }, { number: 2, line: 3 }, { number: 3, line: 6 },
    ],
  };
  assert.equal(relativeLinkNumber(prompt, 1, 1), 3);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 2);
  prompt.cursor = 3;
  assert.equal(relativeLinkNumber(prompt, 1, 1), 3);
  assert.equal(relativeLinkNumber(prompt, 1, -1), 1);
});

test('the number prompt snapshots targets and moves to numbered fields', async () => {
  const keys = new Keymap({ terminfo: {}, profile: 'lynx', load: false });
  keys.preferences = { numberLinks: true, numberFields: true };
  const blocks = [
    { text: 'News', item: item('link', 'News') },
    { text: 'Search', item: item('textbox', 'Search') },
    { text: 'More', item: item('textbox', 'More') },
  ];
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keys, keyReader: null, inputSeen: false, library: null, dialog: null,
    linkAddress: false, statusMsg: '', drawn: {},
    core: { blocks, at() {}, markInput() {} },
    lines: [
      { blockIndex: 0, text: 'News', displayNumber: 1, displayPrefix: '[1]' },
      { blockIndex: 1, text: 'Search', displayNumber: 2, displayPrefix: '[2]' },
      { blockIndex: 2, text: 'More', displayNumber: 3, displayPrefix: '[3]' },
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
    openLinkNumberPrompt(state, '1+');
    await handleNumberKey('g', state, page);
  });
  assert.equal(state.cursor, 2, 'relative g moved without activating the field');
  assert.equal(state.statusMsg, 'Link 3.');

  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '9');
    await handleNumberKey('\r', state, page);
  });
  assert.equal(state.cursor, 2, 'an invalid number did not move the cursor');
  assert.equal(state.statusMsg, 'No link 9 on this page.');
});

test('the p number suffix moves to an absolute or relative screen page', async () => {
  const blocks = Array.from({ length: 45 }, (_, index) => ({
    text: `Line ${index + 1}`, item: item(index === 0 ? 'link' : 'text', `Line ${index + 1}`),
  }));
  const state = {
    interface: 'lynx', mode: 'browse', cursor: 0, scroll: 0, col: 0,
    keyReader: null, inputSeen: false, library: null, dialog: null,
    linkAddress: false, statusMsg: '', drawn: {},
    core: { blocks, at() {}, markInput() {} },
    lines: blocks.map((block, blockIndex) => ({
      blockIndex, text: block.text,
      ...(blockIndex === 0 ? { displayNumber: 1 } : {}),
    })),
  };
  const page = { url: () => 'https://example.test/' };
  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '2p');
    await handleNumberKey('\r', state, page);
  });
  const height = Math.max(1, (process.stdout.rows || 24) - 6);
  const pages = Math.ceil(state.lines.length / height);
  const second = Math.min(2, pages);
  assert.equal(state.cursor, (second - 1) * height);
  assert.equal(state.statusMsg, `Page ${second} of ${pages}.`);

  await captureTerminalAsync(async () => {
    openLinkNumberPrompt(state, '1p+');
    await handleNumberKey('\r', state, page);
  });
  const next = Math.min(second + 1, pages);
  assert.equal(state.cursor, (next - 1) * height);
  assert.equal(state.statusMsg, `Page ${next} of ${pages}.`);
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
