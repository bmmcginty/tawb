'use strict';

// The content coverage page, read through every view and both interfaces.
//
//     TWEB_TEST_BROWSER=chromium node --test test/browser/content_coverage.test.js
//     TWEB_TEST_BROWSER=firefox  node --test test/browser/content_coverage.test.js
//
// The page itself is pinned, without a browser, by test/content_coverage.test.js.
// What only a browser can answer is whether each view actually reaches the
// content the page carries. This reads the same checked-in bytes the reader
// opens with `npm run coverage`, over a data: URL so the case needs no server.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { snapshotFrameTree } = require('../../src/frames');
const { Core } = require('../../src/core');
const { lynxBlocks } = require('../../src/lynx_display');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'content-coverage.html'), 'utf8');
const URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE);

const profile = tempDir('tweb-content-coverage-');
let driver;
let page;
const cache = new Map();

test.before(async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await new Promise((resolve) => setTimeout(resolve, 1200));
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

async function view(name) {
  if (cache.has(name)) return cache.get(name);
  const blocks = await snapshotFrameTree(page, name, { driver });
  const result = { blocks, text: blocks.map((block) => block.text).join('\n') };
  cache.set(name, result);
  return result;
}

const SECTIONS = Array.from({ length: 25 }, (unused, index) => `C${String(index + 1).padStart(2, '0')}`);

// The two text views that every reader starts from. Each has to reach every
// category the page carries, even where the two disagree about how to say it.
for (const name of ['ax', 'render']) {
  test(`${name}: every coverage category is reachable`, async () => {
    const { text } = await view(name);
    assert.match(text, /# TAWB content coverage/);
    for (const id of SECTIONS) assert.match(text, new RegExp(`C${id.slice(1)}`), `missing ${id} in ${name}`);
  });
}

test('ax: the semantic vocabulary is rendered', async () => {
  const { text } = await view('ax');
  assert.match(text, /# An h1 used as a section heading/);
  assert.match(text, /###### An h6 used as a section heading/);
  assert.match(text, /\{An ordinary in-page link\}/);
  assert.match(text, /\[\*An ARIA button on a span\]/);
  assert.match(text, /\[Text field: Typed text\]/);
  assert.match(text, /\[\*A checked checkbox, checked\]/);
  assert.match(text, /\[A native select: A select option two\]/);
  assert.match(text, /\[ARIA slider: 35/);
  assert.match(text, /\(image\) An image with alt text/);
  assert.match(text, /\(audio\) Coverage audio/);
  assert.match(text, /<frame: A same-origin frame>/);
  assert.match(text, /Prose inside the frame\./);
});

test('render: the page view reaches controls and pictures', async () => {
  const { text } = await view('render');
  assert.match(text, /# An h1 used as a section heading/);
  assert.match(text, /\{An ordinary in-page link\}/);
  assert.match(text, /\[\*Mute\]/);
  assert.match(text, /\[Text field: Typed text\]/);
  // A picture the page painted but gave no text to belongs to this view.
  assert.match(text, /\(image: embedded svg\)/);
  assert.match(text, /\(audio\) paused/);
  assert.match(text, /<frame: A same-origin frame>/);
});

test('both text views read open shadow roots', async () => {
  for (const name of ['ax', 'render']) {
    const { text } = await view(name);
    assert.match(text, /Prose in an open shadow root\./, name);
    assert.match(text, /An open-shadow button/, name);
    // A slot renders its fallback when nothing was assigned to it.
    assert.match(text, /Slot fallback: default named default unnamed/, name);
  }
});

test('the page view never reaches inside a closed shadow root', async () => {
  assert.ok(!(await view('render')).text.includes('Prose in a closed shadow root.'),
    'the page view reached inside a closed shadow root');
  // Where the driver can enter a closed root at all — Chromium, over CDP —
  // the semantic view reads it and SOURCE marks the boundary. Firefox's
  // driver cannot, and driver_firefox.js says so; there is nothing to assert
  // about the content in that case.
  if (ENGINE === 'chromium') {
    assert.match((await view('ax')).text, /Prose in a closed shadow root\./);
    assert.match((await view('ax')).text, /A closed-shadow button/);
    assert.match((await view('source')).text, /#closed-shadow-root/);
  }
});

test('both text views skip content the page marked as gone', async () => {
  const hidden = [
    'Content hidden by the hidden attribute.',
    'Content hidden from assistive technology by aria-hidden.',
    'Content hidden by display none.',
    'Content hidden by visibility hidden.',
    'Content hidden by content-visibility.',
    'Content made inert.',
    'Content inside a template, which is never rendered.',
    'Body of the closed disclosure, which must not be read while closed.',
    'A closed dialog that must not be read.',
    'A popover panel, closed until the trigger is pressed.',
  ];
  for (const name of ['ax', 'render']) {
    const { text } = await view(name);
    for (const marker of hidden) assert.ok(!text.includes(marker), `${name} read ${marker}`);
  }
});

test('the views keep their documented disagreement about painted content', async () => {
  // Zero opacity is text as far as the accessibility tree is concerned and
  // not on screen as far as the page view is concerned.
  assert.match((await view('ax')).text, /Content painted at zero opacity\./);
  assert.ok(!(await view('render')).text.includes('Content painted at zero opacity.'),
    'the page view read text painted at zero opacity');
  // A painted background image has no accessible name but is worth a line.
  assert.ok(!(await view('ax')).text.includes('(image: embedded svg)'),
    'the accessibility tree named a background image');
  assert.match((await view('render')).text, /\(image: embedded svg\)/);
});

test('inspect pairs each item with the element that produced it', async () => {
  const { text } = await view('inspect');
  assert.match(text, /\[\*A checked checkbox, checked\]\s*<input[^>]*type="checkbox"/);
  assert.match(text, /\[A native range: 35\]\s*<input[^>]*type="range"/);
  // Chromium hands back real browser-owned markup; Firefox cannot expose it
  // safely and answers with native-control descriptors instead.
  if (ENGINE === 'chromium') assert.match(text, /#user-agent-shadow-root/);
});

test('source shows the live markup and its shadow boundaries', async () => {
  const { text } = await view('source');
  assert.match(text, /<h1/);
  assert.match(text, /<table/);
  assert.match(text, /<video/);
  assert.match(text, /<audio/);
  assert.match(text, /#open-shadow-root/);
  if (ENGINE === 'chromium') assert.match(text, /#closed-shadow-root/);
});

test('the Lynx interface renders the page in Lynx control vocabulary', async () => {
  const core = new Core({ driver, page, source: 'ax', sources: ['ax'], layout: true });
  await core.rescan();
  const blocks = lynxBlocks(core.blocks, { numberLinks: true, numberFields: true });
  const text = blocks.map((block) => `${block.displayPrefix || ''}${block.text}${block.displaySuffix || ''}`).join('\n');

  assert.match(text, /\[X\] A checked checkbox/);
  assert.match(text, /\[ \] An unchecked checkbox/);
  assert.match(text, /\[-\] A mixed checkbox/);
  assert.match(text, /\(\*\) Native radio one/);
  assert.match(text, /Text field Typed text_+/);
  assert.match(text, /A native select \[A select option two\]/);
  assert.match(text, /A native range \[35\]/);
  assert.match(text, /CAPTION: A table with a caption/);
  assert.match(text, /IFRAME: A same-origin frame/);
  assert.match(text, /\[Coverage audio, paused/);
  // Links and fields are numbered, in reading order and without gaps. The
  // number lives on the block or, for a composite row, on each span, so read
  // it from there rather than from the text, where a value like [35] would
  // look like a marker.
  const numbers = [];
  for (const block of blocks) {
    if (block.spans && block.spans.length) {
      for (const span of block.spans) if (span.displayNumber) numbers.push(span.displayNumber);
    } else if (block.displayNumber) {
      numbers.push(block.displayNumber);
    }
  }
  assert.ok(numbers.length > 5, 'the Lynx interface numbered nothing');
  assert.deepEqual(numbers, numbers.map((unused, index) => index + 1), 'numbers are not contiguous in reading order');
});

test('activating a coverage control runs the browser path', async () => {
  const { blocks } = await view('ax');
  const toggle = blocks.find((block) => block.item && block.item.name === 'Toggle the pressed state');
  assert.ok(toggle, 'the C25 toggle is in the accessibility view');
  const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
  await core.activate(toggle.item, page);
  assert.equal(
    await page.evaluate(() => document.getElementById('c25-toggle').getAttribute('aria-pressed')),
    'true',
  );
});
