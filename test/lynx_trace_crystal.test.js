'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { tempDir } = require('./tmpdir');
const { readerImplementations } = require('./crystal_impl');
const log = require('../src/log');

const implementations = readerImplementations(require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const draw = (implementation, spec) => implementation.drawAsync
  ? implementation.drawAsync(spec)
  : Promise.resolve(implementation.draw(spec));

function state(logDir) {
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'lynx', logDir,
    cursor: 0, col: 0, scroll: 0, title: 'Page', statusMsg: '', drawn: {},
    lines: [{ text: 'Page', blockIndex: 0 }],
    keys: { profile: 'lynx' },
    core: {
      source: 'ax', blocks: [{ text: 'Page', item: null }],
      live: { enabled: true, dirty: false, refreshing: false, snapshotCostMs: 0 },
    },
  };
}

for (const implementation of implementations) {
  test(`${implementation.name}: Lynx toggles and displays its trace`,
    { skip: needsCrystal }, async () => {
      if (implementation.name === 'JavaScript') await log.disableLog();
      try {
        const result = await draw(implementation, {
          state: state(tempDir('tawb-lynx-trace-crystal-')),
          page: { url: 'https://example.test/', title: 'Page' },
          actions: [
            { op: 'browseKey', chunk: '\x14' },
            { op: 'browseKey', chunk: ';' },
          ],
        });
        assert.equal(result.state.mode, 'library');
        assert.equal(result.state.library.label, 'Trace Log');
        assert.ok(result.state.library.rows.some((row) => row.includes('trace.enabled')));
        assert.match(result.state.title, /^Trace Log — /);
      } finally {
        if (implementation.name === 'JavaScript') await log.disableLog();
      }
    });

  test(`${implementation.name}: Lynx explains that an unopened trace is off`,
    { skip: needsCrystal }, async () => {
      if (implementation.name === 'JavaScript') await log.disableLog();
      const result = await draw(implementation, {
        state: state(tempDir('tawb-lynx-trace-off-crystal-')),
        page: { url: 'https://example.test/', title: 'Page' },
        actions: [{ op: 'browseKey', chunk: ';' }],
      });
      assert.equal(result.state.mode, 'browse');
      assert.match(result.state.statusMsg, /Trace logging is off/);
    });
}
