'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractAxItems } = require('../src/ax_own');

const target = path.join(__dirname, '..', 'crystal', 'assets', 'extract_ax_items.js');
const header = '// Generated from src/ax_own.js extractAxItems; update with tools/update_crystal_assets.js.\n';
fs.writeFileSync(target, `${header}(${extractAxItems.toString()})({layout:false})\n`);
