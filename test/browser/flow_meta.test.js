'use strict';

// The paragraph identity retained by both browser extractors.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/flow_meta.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/flow_meta.test.js
//
// Flattening has to split an inline link from the prose around it so the link
// keeps its browser identity. The shared flow number says which of those
// separate items came from one HTML block container. It is metadata only: the
// last test proves that the default interface still lays out the exact blocks
// the extractor produced.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { Keymap } = require('../../src/keys');
const { relayout } = require('../../src/index');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-flow-meta-');
let driver;

test.after(async () => {
  if (driver) await driver.close();
  removeTempDir(profile);
});

const PAGE = `
  <p>Before <a href="#one">one</a> after <em>styled</em> text.</p>
  <p><a href="#two">two</a> alone.</p>
  <div>Outer <p>Inner <a href="#three">three</a> prose.</p> Tail <a href="#four">four</a>.</div>
  <ul><li><a href="#five">five</a></li><li><a href="#six">six</a></li></ul>
  <table><tr><td>Cell <a href="#seven">seven</a> end.</td><td>Other</td></tr></table>
  <div role="link" tabindex="0">Block link</div>
`;

async function openPage() {
  driver = driver || await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(PAGE));
  return page;
}

function named(blocks, name) {
  const found = blocks.find((block) => block.item && block.item.name === name);
  assert.ok(found, `missing ${JSON.stringify(name)} in ${blocks.map((block) => block.item.name).join(' | ')}`);
  return found;
}

for (const source of ['ax', 'render']) {
  test(`${source} records one flow for inline neighbours and different flows at blocks`, async () => {
    const page = await openPage();
    const core = new Core({ driver, page, source, sources: [source], layout: true });
    await core.rescan();
    const blocks = core.blocks;

    const before = named(blocks, 'Before');
    const one = named(blocks, 'one');
    const after = named(blocks, 'after styled text.');
    assert.ok(before.item.flow, 'a paragraph has an identity');
    assert.equal(one.item.flow, before.item.flow, 'its inline link shares it');
    assert.equal(after.item.flow, before.item.flow, 'and the prose after the link shares it');

    const two = named(blocks, 'two');
    assert.notEqual(two.item.flow, before.item.flow, 'the next paragraph is separate');
    assert.equal(named(blocks, 'alone.').item.flow, two.item.flow);

    const inner = named(blocks, 'Inner');
    assert.equal(named(blocks, 'three').item.flow, inner.item.flow, 'a nested paragraph has its own run');
    assert.notEqual(inner.item.flow, named(blocks, 'Outer').item.flow);
    assert.equal(named(blocks, 'Tail').item.flow, named(blocks, 'four').item.flow,
      'flow resumes in the outer container without crossing the nested paragraph');

    assert.notEqual(named(blocks, 'five').item.flow, named(blocks, 'six').item.flow,
      'list items remain separate blocks');
    assert.equal(named(blocks, 'Cell').item.flow, named(blocks, 'seven').item.flow,
      'inline content in one cell shares a run');
    assert.notEqual(named(blocks, 'seven').item.flow, named(blocks, 'Other').item.flow,
      'the next cell is another run');
    assert.equal(named(blocks, 'Block link').item.flow, undefined,
      'a block element wearing a link role is not made inline');
  });
}

test('flow metadata changes no default line', async () => {
  const page = await openPage();
  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source], layout: true });
    await core.rescan();
    const state = {
      interface: 'default', core,
      keys: new Keymap({ terminfo: {}, load: false }),
      lines: [], cursor: 0, col: 0, scroll: 0, library: null, dialog: null,
    };
    relayout(state);
    assert.deepEqual(state.lines.map((line) => line.text), core.blocks.map((block) => block.text), source);
    assert.ok(state.lines.every((line) => !line.spans), source);
  }
});

test('without the layout request the extractor records no flow', async () => {
  const page = await openPage();
  for (const source of ['ax', 'render']) {
    const core = new Core({ driver, page, source, sources: [source] });
    await core.rescan();
    assert.ok(core.blocks.every((block) => block.item.flow === undefined),
      `${source}: no flow metadata without a layout request`);
  }
});
