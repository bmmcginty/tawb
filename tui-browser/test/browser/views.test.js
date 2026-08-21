'use strict';

// What each view makes of the test page, against a real browser.
//
//     npm run test:browser
//     xvfb-run -a npm run test:browser     # with no display of your own
//
// These are the questions that only a rendering engine can answer: whether an
// element is on screen, and what it computes to once the page's CSS has run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDriver } = require('../../src/driver');
const { snapshotFrameTree } = require('../../src/frames');
const { start: startTestPage } = require('../../tools/serve');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';

// A profile of this file's own. The default one is shared, and a browser is
// one instance per profile directory, so two test files that took it would
// rejoin the same browser, navigate the same tab out from under each other
// and close it while the other was still reading — which is what happened.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-views-'));

let shared = null;
async function browser() {
  if (shared) return shared;
  const pageServer = await startTestPage(0);
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(pageServer.url, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 1500));
  shared = { pageServer, driver, page };
  return shared;
}

test.after(async () => {
  if (!shared) return;
  await shared.driver.close().catch(() => {});
  shared.pageServer.server.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

const linesOf = async (view) => {
  const { page, driver } = await browser();
  const blocks = await snapshotFrameTree(page, view, { driver });
  return blocks.map((block) => block.text).join('\n');
};

// A display:contents element generates no box, so checkVisibility() calls it
// invisible whether or not its children are on screen. Both walkers used to
// ask it that question and drop the subtree, which on GitHub's issue list
// deleted everything between the header and the footer.
for (const view of ['ax', 'render']) {
  test(`${view} view: a wrapper that generates no box does not hide what it renders`, async () => {
    const text = await linesOf(view);
    assert.match(text, /Read through a wrapper that generates no box\./);
  });

  test(`${view} view: a closed disclosure still hides what is inside such a wrapper`, async () => {
    const text = await linesOf(view);
    assert.ok(!text.includes('Hidden behind a closed disclosure'),
      'a closed <details> hides its contents however they are wrapped');
    assert.match(text, /Shipping notes/);
  });
}
