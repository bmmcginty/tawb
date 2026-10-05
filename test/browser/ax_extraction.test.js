'use strict';

// The shim the AX walk leaves behind for activation.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/ax_extraction.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/ax_extraction.test.js
//
// Every item an extraction returns names its element by position in the node
// list it publishes on the window, and activation looks an element up by that
// position later. A walk asked for a second, privileged pass can throw partway
// through — a page with media controls asks for one, and on Firefox a frame or
// a browser-owned root can refuse it. If the node list is published before the
// walk finishes, the caller falls back to the complete earlier extraction while
// its indices now point off the end of a short list, and every control on the
// page stops activating. These tests pin the recovery, not the failure.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { extractAxItems } = require('../../src/ax_own');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-ax-extraction-');
let driver;

test.before(async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

async function openPage(html) {
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), {
    waitUntil: 'domcontentloaded',
  });
  return page;
}

const publishedNodes = (page) => page.evaluate(() => {
  const nodes = window[Symbol.for('tweb.ax')];
  return nodes ? nodes.length : null;
});

test('a failed privileged walk leaves the previous node list in place', async () => {
  const page = await openPage('<!doctype html><p>one</p><p>two</p><button>Press me</button>');

  const items = await page.evaluate(extractAxItems, {});
  assert.ok(items.length > 0);
  const before = await publishedNodes(page);
  assert.ok(before > 0, 'the successful walk published its node list');

  // A privileged root whose childNodes cannot be read is exactly the shape
  // that reaches the walker on a page it cannot fully pierce.
  const installed = await page.evaluate(() => {
    const root = { get childNodes() { throw new Error('Permission denied to access property childNodes'); } };
    window[Symbol.for('tweb.pierce')] = () => [[document.body, root, undefined, 'closed']];
    return true;
  });
  assert.equal(installed, true);

  const failed = await page.evaluate(extractAxItems, { pierce: true })
    .then(() => false, () => true);
  assert.equal(failed, true, 'the privileged walk was expected to throw');

  const after = await publishedNodes(page);
  assert.equal(after, before, 'the failed walk replaced the complete node list with a partial one');

  // The list still answers the question activation asks of it.
  const last = await page.evaluate(() => {
    const nodes = window[Symbol.for('tweb.ax')];
    return nodes && nodes.length ? nodes[nodes.length - 1].tagName : null;
  });
  assert.ok(last, 'the surviving node list came up empty');
});

test('a finished walk publishes the list its items point at', async () => {
  const page = await openPage('<!doctype html><p>alpha</p><a href="#x">beta</a>');

  const items = await page.evaluate(extractAxItems, {});
  const nodes = await publishedNodes(page);
  assert.ok(nodes > 0);

  // Every recorded index resolves to an element, which is what makes the
  // returned items activatable rather than merely readable.
  const unresolved = await page.evaluate(() => {
    const list = window[Symbol.for('tweb.ax')];
    return list.some((node) => !node || !node.tagName);
  });
  assert.equal(unresolved, false, 'a published node list had a hole');
  assert.ok(items.some((item) => typeof item.axIndex === 'number'));
});
