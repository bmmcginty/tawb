'use strict';

// The Crystal Lynx front end's presentation of a page. There is no JavaScript
// counterpart to difference against here: the interactive loop wraps the core
// in a binding that rebuilds its JSON block list on every read, so a check
// that compared the displayed list with `state.core.blocks` by identity never
// matched and the Lynx vocabulary — numbering included — was dropped from a
// real page. The conformance core is asked to rebuild its list the same way,
// which is what makes that question testable without a terminal.

const test = require('node:test');
const assert = require('node:assert');
const { callAsync } = require('./crystal_impl');

function stateWith(preferences) {
  return {
    interface: 'lynx',
    // load: false keeps a real keys-lynx.json out of the answer.
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

test('a core that rebuilds its block list is still shown with Lynx numbering', async () => {
  const result = await callAsync('reader.draw', {
    state: stateWith({ keypadMode: 'LINKS_ARE_NUMBERED', numberLinks: true, numberFields: false }),
    page: { url: 'https://example.test/' },
    actions: [{ op: 'relayout' }],
  });
  const lines = visible(result.results[0].value);
  assert.ok(lines.some((text) => text.includes('[1]Example')),
    `the link was not numbered: ${JSON.stringify(lines)}`);
});
