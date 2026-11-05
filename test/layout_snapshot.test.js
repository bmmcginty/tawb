'use strict';

// The diagnostic layouts are a snapshot option, not a persistent page-side
// mode: a default snapshot asks the extractor for no geometry at all, and an
// active layout asks for it once and permutes the resulting blocks. These
// checks pin the request at the seam between the core and the PAGE extractor,
// where a lost option is silent — the page still reads, just in document order.

const test = require('node:test');
const assert = require('node:assert');

const { Core, snapshotBlocks } = require('../src/core');

const rect = (top, left, width = 80, height = 20) => ({ top, left, width, height });

function pageWith(entries) {
  const options = [];
  const frame = {
    url: () => 'https://example.test/',
    async evaluate(fn, given) {
      options.push(given);
      return entries;
    },
    async $$() { return []; },
    childFrames() { return []; },
  };
  return {
    options,
    page: {
      url: () => 'https://example.test/',
      mainFrame: () => frame,
      frames: () => [frame],
    },
  };
}

const ENTRIES = [
  {
    kind: 'text', text: 'Product', index: 0, block: true,
    visual: { rect: rect(10, 10), direction: 'ltr', writingMode: 'horizontal-tb' },
  },
  {
    kind: 'text', text: 'Reviews', index: 1, block: true,
    visual: { rect: rect(200, 10), direction: 'ltr', writingMode: 'horizontal-tb' },
  },
  {
    kind: 'text', text: '$10.50', index: 2, block: true,
    visual: { rect: rect(11, 300), direction: 'ltr', writingMode: 'horizontal-tb' },
  },
];

test('layout-default snapshots ask for no visual geometry', async () => {
  const { page, options } = pageWith(ENTRIES);
  const blocks = await snapshotBlocks(page, 'render', { layoutOrder: 'default' });
  assert.deepEqual(blocks.map((block) => block.text), ['Product', 'Reviews', '$10.50']);
  assert.deepEqual(options, [{ layout: false, visual: false }],
    'a default snapshot paid for diagnostic box measurement');
});

test('a diagnostic snapshot asks for geometry and orders the same blocks', async () => {
  const rectangle = pageWith(ENTRIES);
  const rectangleBlocks = await snapshotBlocks(rectangle.page, 'render', {
    layoutOrder: 'rectangle',
  });
  assert.deepEqual(rectangle.options, [{ layout: false, visual: true }]);
  assert.deepEqual(rectangleBlocks.map((block) => block.text),
    ['Product', '$10.50', 'Reviews']);
  assert.equal(rectangleBlocks[1].item.renderIndex, 2,
    'the sorter rebuilt a block instead of moving the original');

  const container = pageWith(ENTRIES.map((entry) => ({
    ...entry,
    visual: {
      ...entry.visual,
      path: [{
        container: 1, group: entry.index + 1, kind: 'grid', direction: 'ltr',
        writingMode: 'horizontal-tb', position: 'static', rect: entry.visual.rect,
      }],
    },
  })));
  const containerBlocks = await snapshotBlocks(container.page, 'render', {
    layoutOrder: 'container',
  });
  assert.deepEqual(containerBlocks.map((block) => block.text),
    ['Product', '$10.50', 'Reviews']);
});

test('a live rebuild keeps using the selected layout order', async () => {
  const { page } = pageWith(ENTRIES);
  const core = new Core({
    driver: {}, page, source: 'render', sources: ['render'], layoutOrder: 'rectangle',
  });
  await core.rescan();
  assert.deepEqual(core.texts(), ['Product', '$10.50', 'Reviews']);

  await core.rebuild(core.anchor());
  assert.deepEqual(core.texts(), ['Product', '$10.50', 'Reviews'],
    'a rebuild quietly returned to document order');
});
