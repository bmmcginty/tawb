'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractAxItems } = require('../src/ax_own');
const { readFieldStateInPage } = require('../src/core');
const { CLEAR_SCRIPT, PIERCE_PARENT_SCRIPT, libraryParentScript } = require('../src/firefox');

const assets = {
  'extract_ax_items.js': {
    source: 'src/ax_own.js extractAxItems',
    value: `(${extractAxItems.toString()})({layout:false})`,
  },
  'firefox_clear.js': { source: 'src/firefox.js CLEAR_SCRIPT', value: CLEAR_SCRIPT },
  'firefox_pierce.js': { source: 'src/firefox.js PIERCE_PARENT_SCRIPT', value: PIERCE_PARENT_SCRIPT },
  'firefox_library.js': { source: 'src/firefox.js libraryParentScript()', value: libraryParentScript() },
  'read_field_state.js': { source: 'src/core.js readFieldStateInPage', value: readFieldStateInPage.toString() },
};

for (const [name, { source, value }] of Object.entries(assets)) {
  const target = path.join(__dirname, '..', 'crystal', 'assets', name);
  const header = `// Generated from ${source}; update with tools/update_crystal_assets.js.\n`;
  fs.writeFileSync(target, `${header}${value.trim()}\n`);
}
