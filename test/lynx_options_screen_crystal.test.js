'use strict';

// Lynx's Options screen, opened and driven the way the interactive front end
// opens it. The module itself is covered by test/lynx_options_crystal.test.js;
// what this checks is the wiring the loop was missing — that the key reaches
// the screen at all, and that a preference changed there and kept is in effect
// the moment the screen closes.

const test = require('node:test');
const assert = require('node:assert');
const { callAsync } = require('./crystal_impl');

function stateWith(preferences) {
  return {
    interface: 'lynx',
    keys: { load: false, preferences },
    core: {
      source: 'ax',
      freshBlocks: true,
      blocks: [
        { text: 'See', item: { role: 'text', name: 'See' } },
        { text: '{Example}', item: { role: 'link', name: 'Example', href: 'https://example.test/' } },
      ],
    },
  };
}

function visible(lines) {
  return lines.map((line) => `${line.displayPrefix}${line.text}${line.displaySuffix}`);
}

test('the options screen opens, and a preference changed there applies at once', async () => {
  const result = await callAsync('reader.draw', {
    state: stateWith({ keypadMode: 'NUMBERS_AS_ARROWS', numberLinks: false, numberFields: false }),
    page: { url: 'https://example.test/' },
    actions: [
      { op: 'openOptions' },
      { op: 'optionsKey', chunk: 'K' },  // choose the keypad mode
      { op: 'optionsKey', chunk: ' ' },  // next value: links are numbered
      { op: 'optionsKey', chunk: '\r' }, // keep it
      { op: 'optionsKey', chunk: 'r' },  // return to the page, for this session
      { op: 'relayout' },
    ],
  });
  assert.equal(result.results[0].value, 'options', 'the options screen did not open');
  assert.ok(result.results[0].writes.join('').includes('Options Menu'),
    'the options screen was not drawn');
  assert.equal(result.results[4].value, 'browse', 'the screen did not close');
  const lines = visible(result.results[5].value);
  assert.ok(lines.some((text) => text.includes('[1]Example')),
    `the changed preference was not applied: ${JSON.stringify(lines)}`);
});
