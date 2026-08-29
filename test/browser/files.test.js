'use strict';

// Attaching a file, against a real browser.
//
//     npm run test:browser
//     TWEB_TEST_BROWSER=firefox npm run test:browser
//
// Both halves are the browser's own work and neither can be stubbed. The
// ordinary case gives a file input its files directly, because the reader
// pressed Enter on the input and the element is already in hand. The awkward
// case is a button that clicks a hidden input — most of the upload widgets on
// the web, with no control a reader could find — where the browser hands the
// chooser over instead: `Page.setInterceptFileChooserDialog` on Chromium,
// `input.fileDialogOpened` on Firefox.
//
// What both assert is the same thing, and it is the page's word rather than
// ours: the `change` event fired and `input.files` holds the file.
//
// The third test is the one that matters for a reader: a chooser that is
// never answered leaves nothing open and wedges nothing. There is no dialog
// anywhere to leave behind — that is the whole reason for taking it over at
// this level rather than driving a window.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-files-');

const PAGE = `<!doctype html><meta charset="utf-8"><title>upload</title>
<input type="file" id="plain">
<input type="file" id="hidden" style="display:none">
<button id="button" style="width:200px;height:50px">Upload a document</button>
<script>
  window.picked = {};
  window.chooserAsked = 0;
  for (const id of ['plain', 'hidden']) {
    document.getElementById(id).addEventListener('change', (e) => {
      window.picked[id] = [...e.target.files].map((f) => f.name + ':' + f.size);
    });
  }
  document.getElementById('button').onclick = () => {
    window.chooserAsked += 1;
    document.getElementById('hidden').click();
  };
</script>`;

let shared = null;
async function browser() {
  if (shared) return shared;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-upload-'));
  fs.writeFileSync(path.join(dir, 'report.txt'), 'a report from the terminal\n');
  shared = { server, url, driver, dir, file: path.join(dir, 'report.txt') };
  return shared;
}

test.after(async () => {
  if (!shared) return;
  await shared.driver.close().catch(() => {});
  shared.server.close();
  fs.rmSync(shared.dir, { recursive: true, force: true });
});

// A real click, which is what a chooser needs: a scripted click carries no
// user activation and opens nothing on either engine. This is the driver's
// own real-click path, the one behind the `m` key.
async function clickFor(driver, page, id) {
  const handle = await page.evaluateHandle((which) => {
    const el = document.getElementById(which);
    el.scrollIntoView();
    return el;
  }, id);
  await driver.realClick(page, handle);
}

const waitFor = async (condition, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

test('a file input the reader activated is given its file directly', async () => {
  const { driver, url, file } = await browser();
  const page = await driver.context.newPage();
  try {
    await page.goto(url);
    const handle = await page.evaluateHandle(() => document.getElementById('plain'));
    await driver.setFiles(handle, [file]);
    // The page's own word for it: the change event fired and the file is
    // there, exactly as if a chooser had been used.
    assert.ok(await waitFor(async () => (await page.evaluate(() => JSON.stringify(window.picked.plain || null))) !== 'null'));
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.picked.plain)),
      JSON.stringify(['report.txt:27']),
    );
  } finally {
    await page.close().catch(() => {});
  }
});

test('a chooser raised by something else is handed over instead of being drawn', async () => {
  const { driver, url, file } = await browser();
  const page = await driver.context.newPage();
  try {
    const asked = [];
    await driver.attachFileChooser(async (request) => {
      asked.push(request);
      await request.setFiles([file]);
    });
    await page.goto(url);
    assert.ok(await driver.armFileChooser(page), 'the chooser could not be armed');

    // The button clicks a hidden input — no control a reader could find, and
    // the case the handover exists for.
    await clickFor(driver, page, 'button');
    assert.ok(await waitFor(async () => asked.length > 0), 'the browser never handed the chooser over');
    assert.equal(asked[0].multiple, false, 'this input takes one file');
    assert.ok(await waitFor(async () => (await page.evaluate(() => JSON.stringify(window.picked.hidden || null))) !== 'null'));
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.picked.hidden)),
      JSON.stringify(['report.txt:27']),
    );
  } finally {
    await driver.attachFileChooser(null).catch(() => {});
    await page.close().catch(() => {});
  }
});

test('a chooser the reader cancels leaves nothing open and nothing wedged', async () => {
  const { driver, url } = await browser();
  const page = await driver.context.newPage();
  try {
    let asked = 0;
    // What escaping the prompt does. Answering with no files is not
    // politeness: Firefox holds a dialog it has not been answered about and
    // raises no other until it is, so a reader who escaped would find that
    // uploading had stopped working in that tab.
    await driver.attachFileChooser(async (request) => {
      asked += 1;
      await request.cancel();
    });
    await page.goto(url);
    assert.ok(await driver.armFileChooser(page));

    await clickFor(driver, page, 'button');
    assert.ok(await waitFor(async () => asked > 0));

    // No dialog was ever drawn, so there is nothing to dismiss: the page goes
    // on answering, and it has no file.
    assert.equal(await page.evaluate(() => document.title), 'upload');
    assert.equal(await page.evaluate(() => JSON.stringify(window.picked.hidden || null)), 'null');

    // And the next one arrives, so cancelling has cost the reader nothing.
    //
    // The pause is Firefox's, and it is the same kind of machine-speed
    // artefact as Chromium discarding a press that lands too soon: asked
    // again within a moment of a cancelled dialog it raises nothing, though
    // the page's own click handler runs. A reader typing a path and pressing
    // keys is never that fast; a test firing both clicks back to back is.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await clickFor(driver, page, 'button');
    assert.ok(await waitFor(async () => asked > 1), 'a second chooser never came');
  } finally {
    await driver.attachFileChooser(null).catch(() => {});
    await page.close().catch(() => {});
  }
});
