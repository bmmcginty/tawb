'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { escapeNonAscii, escapedOffset } = require('../src/unicode_escape');
const { findText, relayout, typingText } = require('../src/index');

test('non-ASCII code points become unambiguous ASCII escapes', () => {
  assert.equal(
    escapeNonAscii('café 中文 — 😀 e\u0301'),
    'caf\\u00E9 \\u4E2D\\u6587 \\u2014 \\U0001F600 e\\u0301',
  );
  assert.equal(escapeNonAscii('plain ASCII 123!'), 'plain ASCII 123!');
});

test('escaped field offsets count terminal columns without changing browser offsets', () => {
  const text = 'a中😀z';
  assert.equal(escapedOffset(text, 1), 1);
  assert.equal(escapedOffset(text, 2), 7);
  assert.equal(escapedOffset(text, 4), 17);
});

test('page relayout escapes display copies and leaves core text unchanged', () => {
  const block = { text: '{中文}', item: { role: 'link', name: '中文' } };
  const state = {
    core: { blocks: [block], at() {} },
    lines: [], cursor: 0, col: 0, scroll: 0,
    escapeUnicode: true,
  };

  relayout(state);

  assert.equal(state.lines[0].text, '{\\u4E2D\\u6587}');
  assert.equal(block.text, '{中文}');
  assert.equal(block.item.name, '中文');
});

test('editing keeps the browser value intact and maps its caret to escaped columns', () => {
  const state = {
    escapeUnicode: true,
    typing: { item: { name: '名称' }, text: 'a中😀z', caret: 4 },
  };
  assert.deepEqual(typingText(state), {
    text: '[\\u540D\\u79F0: a\\u4E2D\\U0001F600z]',
    caretCol: 33,
  });
});

test('a pasted Unicode search finds its escaped page representation', () => {
  const state = {
    escapeUnicode: true,
    lines: [{ text: 'before \\u4E2D after' }],
    cursor: 0,
    col: 0,
  };
  assert.deepEqual(findText(state, '中', 1), { line: 0, col: 7, wrapped: false });
});
