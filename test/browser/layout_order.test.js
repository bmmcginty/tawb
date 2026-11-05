'use strict';

// The diagnostic layouts against real rendering engines.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/layout_order.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/layout_order.test.js
//
// The fixture is the purchase-card shape the contract was written around: the
// product heading is first in the DOM, reviews follow it, and the card that
// holds the price and Add to cart button is last in the DOM but placed beside
// the heading by a CSS grid. Document order therefore reads reviews before the
// card, while both diagnostic orders put the card with the heading. Activation
// is checked after each order, because moving a block must not move the
// element it resolves to.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const FIXTURE = path.join(__dirname, 'walmart_layout.html');
const URL = `file://${FIXTURE}`;
const SOURCES = ['render', 'ax'];
const ORDERS = ['default', 'container', 'rectangle'];

const profile = tempDir(`tawb-layout-order-${ENGINE}-`);
let driver;
let page;

test.before(async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

async function snapshot(source, layoutOrder) {
  const core = new Core({ driver, page, source, sources: [source], layoutOrder });
  const blocks = await core.rescan({ page });
  return { core, blocks };
}

const lineOf = (blocks, needle) => blocks.findIndex((block) => block.text.includes(needle));

for (const source of SOURCES) {
  for (const order of ORDERS) {
    test(`${source}: layout-${order} places the purchase card and keeps it activatable`,
      async () => {
        const { core, blocks } = await snapshot(source, order);
        const product = lineOf(blocks, 'Product title');
        const reviews = lineOf(blocks, 'Reviews');
        const price = lineOf(blocks, '$10.50');
        const button = lineOf(blocks, 'Add to cart');
        for (const [name, at] of Object.entries({ product, reviews, price, button })) {
          assert.ok(at >= 0, `${name} was missing from the ${source} ${order} view`);
        }
        assert.ok(product < reviews, 'the fixture no longer starts with the product heading');
        if (order === 'default') {
          assert.ok(reviews < price,
            'document order put the purchase card before the reviews it follows');
          assert.equal(blocks.some((block) => block.item && block.item.visual), false,
            'layout-default paid for diagnostic geometry');
        } else {
          assert.ok(product < price && price < reviews,
            `${order} order did not move the purchase card beside the heading`);
          assert.ok(price < button, 'the purchase card lost its internal order');
          assert.ok(blocks.every((block) => block.item && block.item.visual && block.item.visual.rect),
            `${order} order did not collect geometry for every block`);
        }

        await page.evaluate(() => { window.presses = 0; });
        const item = blocks[button].item;
        const result = await core.activate(item, page);
        assert.ok(result && result.how, 'the reordered block did not activate');
        assert.equal(await page.evaluate(() => window.presses), 1,
          `the ${order} order activated something other than the purchase button`);
      });
  }
}
