'use strict';

// What the extractors record about a table, against a real browser.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/table_meta.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/table_meta.test.js
//
// The default interface must not change because of this, and does not: the
// last test reads the same page through the default view and checks the lines
// are exactly the blocks the extractor produced. What is added is the row,
// column, header and span of the cell each item came from, on both engines
// and in both extracted views.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const { relayout } = require('../../src/index');
const { snapshotFrameTree } = require('../../src/frames');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-table-meta-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

const PAGE = `
  <table>
    <caption>Cap</caption>
    <thead><tr><th>Name</th><th>Detail</th></tr></thead>
    <tbody>
      <tr><td><a href="#one">Alpha</a></td><td><img alt="A picture" src="x.png"></td></tr>
      <tr><td colspan="2">Spanning</td></tr>
    </tbody>
  </table>
  <p>Outside</p>
`;

async function openPage() {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(PAGE));
  return page;
}

function places(blocks) {
  return Object.fromEntries(blocks.map((block) => [
    block.item.name, block.item.table || null,
  ]));
}

test('both extracted views record the same table position for every cell', async () => {
  const page = await openPage();
  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source], layout: true });
    await core.rescan();
    const found = places(core.blocks);

    assert.deepEqual(found.Cap, { id: 1, caption: true }, `${source}: caption`);
    assert.deepEqual(found.Name, { id: 1, row: 0, cell: 0, header: true }, `${source}: first header`);
    assert.deepEqual(found.Detail, { id: 1, row: 0, cell: 1, header: true }, `${source}: second header`);
    assert.deepEqual(found.Alpha, { id: 1, row: 1, cell: 0, header: false }, `${source}: link cell`);
    assert.deepEqual(found['A picture'], { id: 1, row: 1, cell: 1, header: false }, `${source}: image cell`);
    assert.deepEqual(found.Spanning,
      { id: 1, row: 2, cell: 0, header: false, colspan: 2 }, `${source}: spanning cell`);
    assert.equal(found.Outside, null, `${source}: prose outside a table carries nothing`);
  }
});

test('nested tables and a rowspan are recorded for the nearest table', async () => {
  const page = await openPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <table>
      <tr><td rowspan="2">Tall</td><td>Outer</td></tr>
      <tr><td><table><tr><td>Inner</td></tr></table></td></tr>
    </table>
  `));
  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source], layout: true });
    await core.rescan();
    const found = places(core.blocks);

    assert.equal(found.Tall.rowspan, 2, `${source}: rowspan`);
    assert.equal(found.Tall.id, found.Outer.id, `${source}: one outer table`);
    assert.equal(found.Outer.row, 0, `${source}: first outer row`);
    assert.notEqual(found.Inner.id, found.Outer.id, `${source}: the inner table is its own`);
    assert.equal(found.Inner.row, 0, `${source}: first inner row`);
  }
});

test('the default view is exactly the blocks the extractor produced', async () => {
  const page = await openPage();
  const blocks = await snapshotFrameTree(page, 'ax');
  const state = {
    interface: 'default',
    core: { blocks, at() {} },
    keys: new Keymap({ terminfo: {}, load: false }),
    lines: [], cursor: 0, col: 0, scroll: 0, library: null, dialog: null,
  };
  relayout(state);
  assert.deepEqual(state.lines.map((line) => line.text), blocks.map((block) => block.text));
  assert.ok(state.lines.every((line) => !line.displayPrefix && !line.displayNumber));
});

test('without the layout request the extractor records no table placement', async () => {
  const page = await openPage();
  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source] });
    await core.rescan();
    assert.ok(core.blocks.every((block) => !block.item.table),
      `${source}: no table metadata without a layout request`);
  }
});
