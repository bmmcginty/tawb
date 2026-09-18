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
