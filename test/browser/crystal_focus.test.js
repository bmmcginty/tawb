'use strict';

// The focus an activation moved, from a real Firefox, by both runtimes.
//
// A page can implement a skip link without a real fragment target: the page's
// click handler calls focus() on the destination instead. The URL then says
// nothing happened, while a graphical browser follows the new focus. Three
// things have to agree, and none of them can be checked without a real
// browser moving real focus: that a synchronous focus change is seen, that a
// deferred one is waited for, and that focus landing on the control that was
// pressed is not a destination and must not move the reader.
//
// The JavaScript oracle drives its own copy of the fixture through the
// reader's own focus half; the native runtime joins the same kept browser,
// opens its own copy, and does the same through its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { exactBlockForElement } = require('../../src/place');
const { armActivationFocus, focusedByActivation, cancelActivationFocus } = require('../../src/focus');
const { callAsync } = require('../crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

const FIXTURE = `<!doctype html><html><body>
<button id="source" onclick="destination.focus()">Move focus</button>
<a href="#" id="destination">Destination</a>
<button id="delayed" onclick="setTimeout(() => destination.focus(), 40)">Later</button>
<button id="self" onclick="this.focus()">Self</button>
<button id="quiet" onclick="void 0">Quiet</button>
</body></html>`;

// The same steps in the same order for both runtimes: focus is one property
// of one document, so what went before decides what "changed" means.
const STEPS = [
  // A handler that focuses its destination before the click returns, which
  // is the ordinary skip link.
  { type: 'activate', selector: '#source' },
  { type: 'blur' },
  // A handler that defers focus through a timer, which the bounded watch is
  // for.
  { type: 'activate', selector: '#delayed' },
  { type: 'blur' },
  // A pointer activation ordinarily focuses the thing that was pressed. That
  // is not a destination and must not move the terminal reader.
  { type: 'activate', selector: '#self', waitMs: 50 },
  { type: 'blur' },
  // Nothing focused at all.
  { type: 'activate', selector: '#quiet', waitMs: 50 },
  { type: 'blur' },
  // An activation that raised before anything was pressed: the observation is
  // cancelled, and cancelling again finds nothing, so a later activation
  // cannot inherit it.
  { type: 'cancel', selector: '#source' },
];

check('both runtimes follow the same focus to the same block', async () => {
  const root = tempDir('tawb-crystal-focus-');
  const profile = path.join(root, 'profile');
  const pagePath = path.join(root, 'focus.html');
  fs.writeFileSync(pagePath, FIXTURE);
  const url = `file://${pagePath}`;

  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  try {
    const page = await driver.context.newPage();
    await page.goto(url);
    const frame = page.mainFrame();
    const core = new Core({ driver, page, source: 'ax' });
    await core.rescan();

    const answers = [];
    for (const step of STEPS) {
      if (step.type === 'blur') {
        // eslint-disable-next-line no-await-in-loop
        await frame.evaluate(() => {
          if (document.activeElement) document.activeElement.blur();
        });
        answers.push(true);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const source = await frame.evaluateHandle(
        `document.querySelector('${step.selector}')`);
      // eslint-disable-next-line no-await-in-loop
      const tracker = await armActivationFocus(frame, source);
      if (step.type === 'cancel') {
        // eslint-disable-next-line no-await-in-loop
        await cancelActivationFocus(tracker);
        // eslint-disable-next-line no-await-in-loop
        const twice = await cancelActivationFocus(tracker);
        answers.push({ cancelled: true, twice });
        // eslint-disable-next-line no-await-in-loop
        await source.dispose().catch(() => {});
        continue;
      }
      // Clicked through the element's own default action, which is what Enter
      // on a line does, so the focus observed is the one the page moved.
      // eslint-disable-next-line no-await-in-loop
      await frame.evaluate(`document.querySelector('${step.selector}').click()`);
      // eslint-disable-next-line no-await-in-loop
      const focused = await focusedByActivation(tracker, { waitMs: step.waitMs ?? 250 });
      // eslint-disable-next-line no-await-in-loop
      await source.dispose().catch(() => {});
      if (!focused) {
        answers.push({ found: false });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const id = await focused.handle.evaluate((element) => element.id);
      // eslint-disable-next-line no-await-in-loop
      const block = await exactBlockForElement(
        { source: core.source, blocks: core.blocks }, page, focused.handle, focused.frame);
      const item = block >= 0 && core.blocks[block] ? core.blocks[block].item : null;
      answers.push({
        found: true, id, name: (item && item.name) || '', block,
      });
      // eslint-disable-next-line no-await-in-loop
      await focused.handle.dispose().catch(() => {});
    }

    // What the oracle itself must have produced, because a differential that
    // agrees on the wrong answer is no use.
    assert.equal(answers[0].found, true, 'the synchronous focus change was not observed');
    assert.equal(answers[0].id, 'destination');
    assert.equal(answers[0].name, 'Destination');
    assert.ok(answers[0].block >= 0, 'the destination is not a block in this view');
    assert.equal(answers[2].id, 'destination', 'the deferred focus change was not waited for');
    assert.equal(answers[4].found, false,
      'focus on the activated control was mistaken for a destination');
    assert.equal(answers[6].found, false);
    assert.deepEqual(answers[8], { cancelled: true, twice: false });

    // The native runtime, joining the same browser as a second reader.
    const broker = JSON.parse(
      fs.readFileSync(path.join(profile, 'tawb-broker.json'), 'utf8'));
    const native = await callAsync('focus.scenario', {
      url: `ws://127.0.0.1:${broker.port}/session`,
      page: url,
      source: 'ax',
      steps: STEPS,
    }, { timeoutMs: 60000 });
    assert.deepEqual(native.answers, answers);
  } finally {
    await driver.close().catch(() => {});
    removeTempDir(root);
  }
});
