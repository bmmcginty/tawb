'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractAxItems } = require('../src/ax_own');
const { CLEAR_SCRIPT, PIERCE_PARENT_SCRIPT, libraryParentScript } = require('../src/firefox');

const ROOT = path.join(__dirname, '..');

const assets = {
  'extract_ax_items.js': {
    source: 'src/ax_own.js extractAxItems',
    value: `(${extractAxItems.toString()})({layout:false})`,
  },
  'firefox_clear.js': { source: 'src/firefox.js CLEAR_SCRIPT', value: CLEAR_SCRIPT },
  'firefox_pierce.js': { source: 'src/firefox.js PIERCE_PARENT_SCRIPT', value: PIERCE_PARENT_SCRIPT },
  'firefox_library.js': { source: 'src/firefox.js libraryParentScript()', value: libraryParentScript() },
};

for (const [name, { source, value }] of Object.entries(assets)) {
  test(`the embedded Crystal asset ${name} matches the JavaScript source`, () => {
    const header = `// Generated from ${source}; update with tools/update_crystal_assets.js.\n`;
    const expected = `${header}${value.trim()}\n`;
    const actual = fs.readFileSync(path.join(ROOT, 'crystal/assets', name), 'utf8');
    assert.equal(actual, expected);
  });
}
