'use strict';

// Where the DOM activation path aims.
//
// clickThrough does not call el.click() on the labelled control. A real mouse
// lands on the innermost element under the pointer and the event travels up
// from there, so a handler bound below the control hears a real click and
// never hears a click fired at the control itself. clickThrough therefore
// aims at a point and descends to the deepest descendant covering it.
//
// Which point it aims at is what these tests pin down.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { clickThrough } = require('../../src/click');
const { Core } = require('../../src/core');
const { snapshotFrameTree } = require('../../src/frames');
const { snapshotSourceBlocks } = require('../../src/source_html');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-click-through-');
let driver;

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

// The aim point is the middle of the element's first line box, not the middle
// of getBoundingClientRect(). The two differ for an inline element whose text
// wraps: getBoundingClientRect() returns the union of every line box, and the
// middle of that union lands in the leading between two lines, which the
// element does not occupy. Aiming there found no descendant covering it, so
// the click was fired at the link and a handler on the span inside the link
// never heard it.
test('a wrapped link is clicked through to the child on its first line', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <style>li { width: 190px; font: 13px sans-serif; line-height: 30px; }</style>
    <ul><li><a href="#" id="link"><span id="inner">Corporate Member Benefit</span>
      Option Change Form</a></li></ul>
    <script>
      window.heard = [];
      inner.addEventListener('click', () => window.heard.push('inner'));
      link.addEventListener('click', (event) => { event.preventDefault(); });
    </script>
  `));

  // The shape the test depends on: two line boxes with a gap between them,
  // and a span that occupies only the first line.
  const shape = await page.evaluate(() => {
    const link = document.querySelector('#link');
    const rects = Array.from(link.getClientRects());
    const span = document.querySelector('#inner').getBoundingClientRect();
    const box = link.getBoundingClientRect();
    return {
      lines: rects.length,
      gap: rects.length > 1 ? rects[1].top - (rects[0].top + rects[0].height) : 0,
      unionMiddleInSpan: box.top + box.height / 2 >= span.top
        && box.top + box.height / 2 <= span.bottom,
    };
  });
  assert.equal(shape.lines, 2, 'the link did not wrap onto two lines');
  assert.ok(shape.gap > 0, 'the two line boxes left no gap between them');
  assert.equal(shape.unionMiddleInSpan, false,
    'the middle of the union rectangle was inside the span after all');

  const link = await page.evaluateHandle(() => document.querySelector('#link'));
  await link.evaluate(clickThrough);
  await link.dispose().catch(() => {});

  const heard = await page.evaluate(() => window.heard);
  assert.deepEqual(heard, ['inner'],
    'the click did not reach the span on the link\'s first line');
});

// A media player can have a perfectly ordinary button and still refuse an
// untrusted press: playback needs user activation, which only the browser's
// own input pipeline grants. The event arrives, the player ignores it, and
// Play does nothing. The button is inside the application widget that owns
// the media element, so the DOM path asks for a trusted press instead.
test('a control inside a media player is pressed as a person', async () => {
  if (!driver) driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <div role="application" aria-label="Audio Player" id="player">
      <video></video>
      <button aria-label="Play" id="play" style="width:80px;height:40px">
        <span id="play-target">Play</span>
      </button>
    </div>
    <script>
      window.heard = [];
      document.getElementById('play').addEventListener('click', (event) => {
        window.heard.push({ target: event.target.id, trusted: event.isTrusted });
      });
    </script>
  `));

  const blocks = await snapshotFrameTree(page, 'ax', { driver });
  const button = blocks.find((block) => block.item && block.item.name === 'Play');
  assert.ok(button, 'the media play button was not read');

  const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
  const result = await core.activate(button.item, page);
  assert.equal(result.how, 'real-click',
    'the media control was not pressed with a trusted click');

  assert.deepEqual(await page.evaluate(() => window.heard),
    [{ target: 'play-target', trusted: true }],
    'the media control received an untrusted click');

  // The HTML view resolves its own element, but must take the same fallback.
  await page.evaluate(() => { window.heard = []; });
  const sourceBlocks = await snapshotSourceBlocks(page);
  const sourceButton = sourceBlocks.find((block) => block.item
    && block.item.tag === 'button' && block.item.attrs
    && block.item.attrs['aria-label'] === 'Play');
  assert.ok(sourceButton, 'the HTML view did not read the media play button');
  const sourceCore = new Core({ driver, page, source: 'source', sources: ['source'] });
  const sourceResult = await sourceCore.activate(sourceButton.item, page);
  assert.equal(sourceResult.how, 'real-click',
    'the HTML view did not use a trusted click on the media control');
  assert.deepEqual(await page.evaluate(() => window.heard),
    [{ target: 'play-target', trusted: true }],
    'the HTML view sent an untrusted click to the media control');
});

// The deepest node under the aim point is not always an HTMLElement. SVG has
// no click() of its own, so the DOM path used to throw before the page heard
// anything. The control still needs pressing, and a trusted pointer click is
// the one road that reaches the inner node and bubbles from it.
test('a control whose inner target has no click method is pressed as a person', async () => {
  if (!driver) driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto('data:text/html,' + encodeURIComponent(`
    <button aria-label="Icon button" style="padding:0;border:0;background:transparent">
      <svg width="40" height="40"><rect id="icon-target" width="40" height="40" fill="#ccc"></rect></svg>
    </button>
    <script>
      window.heard = [];
      document.getElementById('icon-target').addEventListener('click', (event) => {
        window.heard.push({ target: event.target.id, trusted: event.isTrusted });
      });
    </script>
  `));

  const blocks = await snapshotFrameTree(page, 'ax', { driver });
  const button = blocks.find((block) => block.item && block.item.name === 'Icon button');
  assert.ok(button, 'the icon button was not read');

  const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
  const result = await core.activate(button.item, page);
  assert.equal(result.how, 'real-click',
    'the missing click method was not answered with a trusted press');

  const heard = await page.evaluate(() => window.heard);
  assert.deepEqual(heard, [{ target: 'icon-target', trusted: true }],
    'the trusted press did not reach the SVG target');

  // The HTML view resolves its own element, but must take the same fallback.
  await page.evaluate(() => { window.heard = []; });
  const sourceBlocks = await snapshotSourceBlocks(page);
  const sourceButton = sourceBlocks.find((block) => block.item && block.item.tag === 'button');
  assert.ok(sourceButton, 'the HTML view did not read the icon button');
  const sourceCore = new Core({ driver, page, source: 'source', sources: ['source'] });
  const sourceResult = await sourceCore.activate(sourceButton.item, page);
  assert.equal(sourceResult.how, 'real-click',
    'the HTML view did not use the trusted press');
  assert.deepEqual(await page.evaluate(() => window.heard),
    [{ target: 'icon-target', trusted: true }],
    'the HTML view did not reach the SVG target');
});
