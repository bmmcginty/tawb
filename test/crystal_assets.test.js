'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractAxItems } = require('../src/ax_own');

const ROOT = path.join(__dirname, '..');

test('the embedded Crystal accessibility extractor matches the JavaScript source', () => {
  const header = '// Generated from src/ax_own.js extractAxItems; update with tools/update_crystal_assets.js.\n';
  const expected = `${header}(${extractAxItems.toString()})({layout:false})\n`;
  const actual = fs.readFileSync(path.join(ROOT, 'crystal/assets/extract_ax_items.js'), 'utf8');
  assert.equal(actual, expected);
});
