'use strict';

// A dialog the browser drew for itself, against a real browser.
//
//     npm run test:browser
//
// This is the half of the feature that cannot be stubbed, because the whole of
// it is the browser drawing a window nothing in the protocol describes and
// then being answered through the accessibility interface it publishes for
// screen readers.
//
// The dialog used here is a plain `alert()`, which Chromium draws as a native
// views dialog exactly as it draws an extension's install confirmation — same
// mechanism, no network, no Web Store, no extension left behind. It is also
// worth having for its own sake: an alert is a modal that stops the page's own
// script until it is answered, so before this a reader met it as a page that
// had quietly stopped.
//
// Firefox is left out on purpose. Its alerts never reach the accessibility
// tree at all when a WebDriver session is attached, because the session's
// prompt handling dismisses them first — a fact about BiDi rather than about
// this feature, and its install doorhanger (which is what the feature is for)
// is not dismissed that way.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-native-');

const MESSAGE = 'Your session will expire in 2 minutes.';
const PAGE = `<!doctype html><meta charset="utf-8"><title>asking</title>
<script>
  window.answered = false;
  setTimeout(() => { alert(${JSON.stringify(MESSAGE)}); window.answered = true; }, 300);
</script>`;

async function serve() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const waitFor = async (condition, ms = 15000, each = null) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (each) await each();
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

test('the browser asking something in a window of its own reaches the reader', async (t) => {
  if (ENGINE !== 'chromium') {
    t.skip('Firefox dismisses page dialogs itself while a BiDi session is attached');
    return;
  }
  const { server, url } = await serve();
  const driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  let watch = null;
  try {
    const asked = [];
    // Pressed first and recorded afterwards, so that a test which has seen
    // the dialog has also seen it answered: a page whose script is stopped by
    // a modal answers nothing, these evaluations included.
    //
    // The pause before pressing is not politeness. Chromium discards input
    // that arrives within about half a second of a dialog appearing — its
    // protection against clickjacking — and discards it silently: the press
    // answers true and nothing happens. A reader reading the question is
    // never near that window; a test that presses the instant it hears is.
    watch = await driver.watchNativeDialogs(async (dialog) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const ok = dialog.buttons.find((button) => /^ok$/i.test(button.name));
      if (ok) await dialog.press(ok);
      asked.push(dialog);
    });
    if (!watch) {
      // No accessibility bus on this machine, which is a thing about the
      // machine rather than a failure: the feature is unavailable and says so.
      t.skip('this machine has no accessibility bus for the browser to answer on');
      return;
    }

    const page = await driver.context.newPage();
    // Not awaited: the alert stops the page's own script, and with it
    // everything that waits on the page having finished.
    page.goto(url).catch(() => {});

    assert.ok(await waitFor(() => asked.length > 0), 'the dialog was never noticed');
    const dialog = asked[0];
    // The dialog's own words, not a summary of them: what the browser says is
    // the whole of what the reader has to go on.
    assert.ok(
      dialog.lines.some((line) => line.includes(MESSAGE)),
      `expected the message among ${JSON.stringify(dialog.lines)}`,
    );
    // And who is asking, which for a page dialog is the origin rather than
    // the page's own idea of its name.
    assert.ok(
      dialog.lines.some((line) => line.includes('127.0.0.1')),
      `expected the origin among ${JSON.stringify(dialog.lines)}`,
    );
    assert.deepEqual(dialog.buttons.map((button) => button.name), ['OK']);

    // Answering it let the page go on, which is the point: a modal nobody can
    // see is a page that has stopped for no reason the reader can discover.
    let answered = false;
    await waitFor(() => answered, 10000, async () => {
      answered = await page.evaluate(() => window.answered).catch(() => false);
    });
    assert.equal(answered, true, 'the page never resumed after the dialog was answered');
  } finally {
    if (watch) watch.stop();
    await driver.close();
    server.close();
  }
});
