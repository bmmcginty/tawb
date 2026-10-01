'use strict';

// A TAWB adaptation of the W3C ARIA-AT toggle-button test plan:
// https://github.com/w3c-cg/aria-at/tree/master/tests/apg/toggle-button
//
// ARIA-AT's upstream harness records what JAWS, NVDA, and VoiceOver announce;
// it cannot drive TAWB directly. These tests preserve its product-independent
// assertions instead: navigation reaches the control, its role/name/state are
// conveyed, operating it works, and the changed state is conveyed.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { extractAxItems } = require('../../src/ax_own');
const { renderLine } = require('../../src/aria');
const { clickThrough } = require('../../src/click');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-aria-at-');
let driver;
let page;

const PAGE = `<!doctype html><meta charset="utf-8"><title>ARIA-AT toggle button</title>
<a id="before" href="#before">Navigate forwards from here</a>
<a tabindex="0" role="button" id="toggle" aria-pressed="false">Mute</a>
<a id="after" href="#after">Navigate backwards from here</a>
<script>
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') !== 'true');
  });
</script>`;

async function toggleLine() {
  const items = await page.evaluate(extractAxItems, {});
  const item = items.find((candidate) => candidate.name === 'Mute');
  assert.ok(item, 'the Mute toggle button was absent from the accessibility view');
  return renderLine(item);
}

test.before(async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
});

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

test('ARIA-AT: navigation reaches the toggle button in document order', async () => {
  await page.evaluate(() => document.querySelector('#before').focus());
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'after');
});

test('ARIA-AT: a not-pressed toggle conveys its role, name, and state', async () => {
  await page.evaluate(() => document.querySelector('#toggle').setAttribute('aria-pressed', 'false'));
  assert.equal(await toggleLine(), '[*Mute, not pressed]');
});

test('ARIA-AT: operating the toggle conveys the changed pressed state', async () => {
  await page.evaluate(() => document.querySelector('#toggle').setAttribute('aria-pressed', 'false'));
  const toggle = await page.evaluateHandle(() => document.querySelector('#toggle'));
  try {
    await toggle.evaluate(clickThrough);
  } finally {
    await toggle.dispose().catch(() => {});
  }
  assert.equal(await toggleLine(), '[*Mute, pressed]');
});
