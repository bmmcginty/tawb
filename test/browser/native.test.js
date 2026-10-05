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
const fs = require('node:fs');

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

async function serve(content = PAGE) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(content);
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

// A browser that exposes no accessibility tree is only this test's problem
// when there was a bus for it to expose one on. A machine with no D-Bus at
// all is an ordinary machine, and the feature says so rather than failing; a
// bus that is up and a browser that still describes nothing is the regression
// these tests exist for. The driver logs which one it was.
function skipWithoutBus(t, events) {
  // The driver logs whether it came up on a bus at all: `served` for one it
  // owns, `found` for a desktop's. With either, a browser that describes no
  // windows is the regression; with neither, there is nothing to answer on.
  const busWasUp = events.some((entry) => entry.event === 'a11y.bus.served'
    || entry.event === 'a11y.bus.found');
  if (busWasUp) {
    assert.fail('the accessibility bus is up, but the browser described no windows');
  }
  const last = [...events].reverse().find((entry) => entry.event === 'native.unavailable');
  const reason = (last && last.detail && last.detail.reason) || 'no accessibility bus';
  t.skip(`no accessibility bus to answer on: ${reason}`);
}

test('a Firefox microphone permission doorhanger reaches the reader', async (t) => {
  if (ENGINE !== 'firefox') {
    t.skip('this is Firefox browser chrome');
    return;
  }
  // Supply a virtual device so the test reaches permission checking on
  // machines without audio hardware. Firefox still asks before opening it.
  fs.writeFileSync(
    `${profile}/user.js`, 'user_pref("media.navigator.streams.fake", true);\n',
  );
  const asking = `<!doctype html><meta charset="utf-8"><title>microphone</title>
    <button id="ask">Join</button>
    <script>ask.onclick = () => navigator.mediaDevices.getUserMedia({ audio: true });</script>`;
  const { server, url } = await serve(asking);
  const events = [];
  const driver = await openDriver({
    engine: ENGINE, profile, broker: false,
    log: (event, detail) => events.push({ event, detail }),
  });
  let watch = null;
  try {
    const dialogs = [];
    watch = await driver.watchNativeDialogs(async (dialog) => {
      dialogs.push(dialog);
      const block = dialog.buttons.find((button) => /^block$/i.test(button.name));
      if (block) await dialog.press(block);
    });
    // Firefox is expected to expose this one. With no bus there is nothing to
    // expose it on and the test has nothing to say; with a bus and no tree
    // there is a real failure.
    if (!watch) {
      skipWithoutBus(t, events);
      return;
    }

    const page = driver.context.pages()[0] || await driver.context.newPage();
    await page.goto(url);
    await page.evaluate(() => document.querySelector('#ask').click());
    assert.ok(await waitFor(() => dialogs.length > 0), 'the microphone prompt was never noticed');

    const dialog = dialogs[0];
    assert.ok(dialog.lines.some((line) => /use your microphone/i.test(line)));
    assert.deepEqual(dialog.buttons.map((button) => button.name), ['Block', 'Allow']);
  } finally {
    if (watch) watch.stop();
    await driver.close();
    server.close();
  }
});

test('the browser asking something in a window of its own reaches the reader', async (t) => {
  if (ENGINE !== 'chromium') {
    t.skip('Firefox dismisses page dialogs itself while a BiDi session is attached');
    return;
  }
  const { server, url } = await serve();
  const events = [];
  const driver = await openDriver({
    engine: ENGINE, profile, log: (event, detail) => events.push({ event, detail }),
  });
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
      skipWithoutBus(t, events);
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
