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
const { extractVisible } = require('../../src/render_html');

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

test('AX and PAGE collect layout geometry only when it is requested', async () => {
  const page = await openPage(`<!doctype html>
    <main style="display:grid;grid-template-columns:300px 200px;gap:20px">
      <h1 style="grid-column:1;grid-row:1">Product</h1>
      <section style="grid-column:1;grid-row:2">Reviews</section>
      <aside style="grid-column:2;grid-row:1">Current price is $10.50</aside>
      <span style="display:none">Hidden</span>
    </main>
    <div style="display:flex;direction:rtl"><span>Flex first</span><span>Flex second</span></div>
    <table><tr><td>Cell A</td><td>Cell B</td></tr></table>`);

  for (const extractor of [extractAxItems, extractVisible]) {
    const ordinary = await page.evaluate(extractor, {});
    assert.equal(ordinary.some((item) => item.visual), false,
      'a default snapshot paid for diagnostic geometry');

    const rectangles = await page.evaluate(extractor, { visual: 'rectangle' });
    const rectangleProduct = rectangles.find((item) => (item.name || item.text) === 'Product');
    assert.ok(rectangleProduct?.visual?.rect, 'rectangle mode omitted an item rectangle');
    assert.ok(rectangles.every((item) => item.visual?.path == null),
      'rectangle mode measured unused ancestor paths');
    const containers = await page.evaluate(extractor, { visual: 'container' });
    const containerProduct = containers.find((item) => (item.name || item.text) === 'Product');
    assert.ok(Array.isArray(containerProduct?.visual?.path),
      'container mode omitted an ancestor path');
    assert.ok(containers.every((item) => item.visual?.rect == null),
      'container mode measured unused item rectangles');

    // The legacy boolean requests both forms and remains useful to callers
    // inspecting all visual metadata in one extraction.
    const measured = await page.evaluate(extractor, { visual: true });
    // The geometry belongs to whatever holds the text: with structural roles
    // in the tree that is the container (the cell, the named region) rather
    // than the text item inside it, so prefer the item that carries a path.
    const named = (text) => measured.find((item) => (item.name || item.text) === text
      && item.visual?.path?.length)
      || measured.find((item) => (item.name || item.text) === text);
    const product = named('Product');
    const reviews = named('Reviews');
    // The purchase card is the <aside> landmark itself: its text is a child
    // item now, and the box that sits in the grid is the container.
    const price = measured.find((item) => item.role === 'complementary' && item.visual?.path?.length)
      || named('Current price is $10.50');
    assert.ok(product?.visual?.rect, 'the product heading had no rectangle');
    assert.ok(reviews?.visual?.rect, 'the review block had no rectangle');
    assert.ok(price?.visual?.rect, 'the purchase card had no rectangle');
    assert.equal(product.visual.path.at(-1).kind, 'grid');
    assert.equal(product.visual.path.at(-1).container, price.visual.path.at(-1).container,
      'grid siblings did not name the same layout container');
    assert.notEqual(product.visual.path.at(-1).group, price.visual.path.at(-1).group,
      'separate grid children were collapsed into one group');
    assert.ok(price.visual.rect.top < reviews.visual.rect.top,
      'the browser did not report the CSS placement that contradicts DOM order');
    const flex = named('Flex first');
    const cell = named('Cell A');
    assert.equal(flex.visual.path.at(-1).kind, 'flex');
    assert.equal(flex.visual.path.at(-1).direction, 'rtl');
    assert.equal(cell.visual.path.at(-1).kind, 'table');
    assert.equal(measured.some((item) => (item.name || item.text) === 'Hidden'), false);
  }
});

test('a presentational role cannot hide a control the platform exposes', async () => {
  // WAI-ARIA refuses role="presentation" and role="none" when the element is
  // focusable or carries a global ARIA attribute, and browsers refuse them the
  // same way. Taking the author's word instead turned every such control into
  // prose: the reCAPTCHA checkbox on Facebook's two-step page sits in a
  // presentational frame and could not be pressed at all.
  const page = await openPage(`<!doctype html><body>
    <button role="presentation">Presentational button</button>
    <a role="presentation" href="/next">Presentational link</a>
    <input type="checkbox" role="presentation" aria-label="Agree">
    <input type="text" role="none" aria-label="Your name">
    <select role="presentation" aria-label="Pick one"><option>One</option></select>
    <details><summary role="presentation">More</summary><p>Body</p></details>
    <button role="presentation" aria-label="Close">x</button>
  </body>`);

  const items = await page.evaluate(extractAxItems, {});
  const has = (role, name) => items.some((item) => item.role === role && item.name === name);
  assert.ok(has('button', 'Presentational button'), 'a presentational button was not a button');
  assert.ok(has('link', 'Presentational link'), 'a presentational link was not a link');
  assert.ok(has('checkbox', 'Agree'),
    'a presentational checkbox lost its role to its aria-label');
  assert.ok(has('textbox', 'Your name'), 'a presentational text field was not editable');
  assert.ok(has('combobox', 'Pick one'), 'a presentational select was not a combobox');
  assert.ok(has('button', 'More'), 'a presentational summary lost its disclosure');
  assert.ok(has('button', 'Close'),
    'a button that is both presentational and named in ARIA lost both');
});

test('a presentational role still removes the semantics nothing depends on', async () => {
  // The refusal is narrowly scoped: where nothing is focusable and no global
  // ARIA attribute is set, the author's request stands, and a reader should
  // still get the text — a heading is not a stop, but it is not lost either.
  const page = await openPage(`<!doctype html><body>
    <h2 role="presentation">Plain title</h2>
    <ul role="presentation"><li role="presentation">Plain item</li></ul>
    <h2 role="presentation" aria-label="Named title">Plain title</h2>
    <div aria-hidden="true"><button>Hidden button</button></div>
  </body>`);

  const items = await page.evaluate(extractAxItems, {});
  const has = (role, name) => items.some((item) => item.role === role && item.name === name);
  assert.ok(has('text', 'Plain title'), 'the text of a presentational heading was lost');
  assert.equal(has('heading', 'Plain title'), false,
    'a presentational heading kept a role the author removed');
  assert.ok(has('text', 'Plain item'), 'the text of a presentational list item was lost');
  assert.ok(has('heading', 'Named title'),
    'a heading carrying a global ARIA attribute lost its role');
  // aria-hidden is a separate question and stays honoured: this change is
  // about which role an exposed element has, not about what is exposed.
  assert.equal(items.some((item) => item.name === 'Hidden button'), false,
    'aria-hidden content was exposed by the presentational-role change');
});

test('what a control says beyond its name is carried, not dropped', async () => {
  const page = await openPage(`<!doctype html><body>
    <button aria-describedby="d" aria-keyshortcuts="Alt+D"
      aria-roledescription="destructive action" aria-haspopup="dialog">Delete</button>
    <span id="d" hidden>Cannot be undone</span>
    <input aria-label="Email" aria-invalid="true" aria-errormessage="e">
    <span id="e">Must contain an at sign</span>
    <div role="button" tabindex="0" aria-description="Opens a menu">Options</div>
  </body>`);

  const items = await page.evaluate(extractAxItems, {});
  const remove = items.find((item) => item.name === 'Delete');
  assert.ok(remove, 'the described button was not in the tree');
  assert.equal(remove.annotation?.description, 'Cannot be undone',
    'a description pointing at hidden text was lost');
  assert.equal(remove.annotation?.keyshortcuts, 'Alt+D');
  assert.equal(remove.annotation?.roleDescription, 'destructive action');
  assert.equal(remove.annotation?.haspopup, 'dialog');

  const email = items.find((item) => item.name === 'Email');
  assert.equal(email.annotation?.error, 'Must contain an at sign',
    'the error message for an invalid field was lost');

  const options = items.find((item) => item.name === 'Options');
  assert.equal(options.annotation?.description, 'Opens a menu', 'aria-description was lost');
});
