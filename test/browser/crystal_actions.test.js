'use strict';

// Acting on a page, from a real Firefox, by both runtimes.
//
// Activation through the element's own default action must land the way a
// mouse would — on the deepest descendant covering the aim point — and the
// real click must be one the browser accounts a person's, because that is
// the whole reason it exists. The hover must arrive from outside the
// element, or a menu waiting to be entered is never entered. The JavaScript
// oracle drives its own copy of the fixture through the reader's acting
// half; the native runtime joins the same kept browser, opens its own copy,
// and performs the same actions through its own. The two must not disagree
// about what the page heard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { clickThrough, prepareRealClick, submitsAutofilled } = require('../../src/click');
const { callAsync } = require('../crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

const FIXTURE = `<!doctype html><html><body>
<style>
  #menu, #menu ul { list-style: none; margin: 0; padding: 0; }
  #menu > li { position: relative; float: left; padding: 8px; }
  #menu li ul { position: absolute; width: 10em; margin-left: -1000em; }
  #menu li:hover ul { margin-left: 0; }
</style>
<a href="#" id="outer" role="button"><div id="inner"
  style="width:60px;height:20px;background:#eee"></div></a>
<button id="real" type="button">Press me</button>
<ul id="menu"><li id="item"><a href="javascript:;" id="itemlink">Members</a>
  <ul id="submenu"><li><a href="/sectionals">Sectionals</a></li></ul>
</li></ul>
<form><input id="user" name="user"><input id="pass" name="pass" type="password">
  <button id="save" type="submit">Save</button></form>
<input id="text" value="focus me">
<script>
  window.heard = [];
  window.clicks = [];
  document.getElementById('inner').addEventListener('click', () => {
    window.heard.push('inner');
  });
  document.getElementById('outer').addEventListener('click', (event) => {
    event.preventDefault();
    window.heard.push('outer');
  });
  document.getElementById('real').addEventListener('click', (event) => {
    window.clicks.push(event.isTrusted);
  });
</script>
</body></html>`;

// The same order both runtimes, because the actions share one pointer and
// one document: the focus must come after the click, or the click's own
// focus is what the probe would read.
const TARGETS = [
  { action: 'activate', selector: '#outer', index: 0 },
  { action: 'real_click', selector: '#real', index: 0 },
  { action: 'hover', selector: '#itemlink', index: 0 },
  { action: 'focus_control', selector: '#text', index: 0 },
  { action: 'submits_autofilled', selector: '#save', index: 0 },
];

// What the page heard once every action had been taken.
const PROBE = `() => ({
  heard: window.heard.slice(),
  clicks: window.clicks.slice(),
  menu: getComputedStyle(document.querySelector('#submenu')).marginLeft,
  focused: document.activeElement ? document.activeElement.id : '',
  activation: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
})`;

check('the page hears the same things however the runtime acts on it', async () => {
  const root = tempDir('tawb-crystal-actions-');
  const profile = path.join(root, 'profile');
  const pagePath = path.join(root, 'actions.html');
  fs.writeFileSync(pagePath, FIXTURE);
  const url = `file://${pagePath}`;

  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  try {
    // The JavaScript oracle, through the same door the reader uses.
    const page = await driver.context.newPage();
    await page.goto(url);
    const frame = page.mainFrame();
    const answers = [];
    for (const target of TARGETS) {
      // A bare expression, not a function source: the driver wraps a string
      // as `() => { return (...); }`, and a function source would come back
      // holding the function itself.
      const handle = await frame.evaluateHandle(
        `document.querySelectorAll('${target.selector}')[${target.index}]`);
      try {
        switch (target.action) {
          case 'activate':
            answers.push(await handle.evaluate(clickThrough));
            break;
          case 'focus_control':
            answers.push(await handle.evaluate((el) => { el.focus(); return true; }));
            break;
          case 'submits_autofilled':
            answers.push(await handle.evaluate(submitsAutofilled));
            break;
          case 'real_click': {
            const ready = await handle.evaluate(prepareRealClick);
            if (!ready || !ready.ok) throw new Error(ready && ready.reason);
            await driver.realClick(frame, handle);
            answers.push({ ok: true });
            break;
          }
          case 'hover': {
            const ready = await handle.evaluate(prepareRealClick);
            if (!ready || !ready.ok) throw new Error(ready && ready.reason);
            await driver.hover(frame, handle, ready);
            answers.push({ ok: true });
            break;
          }
          default:
            throw new Error(`unknown action ${target.action}`);
        }
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
    // Eval'd first, not passed as a string: the driver wraps a string
    // argument as a bare expression, and the probe is a function — eval'd,
    // its toString is the source the native runtime sends raw.
    const reactions = await frame.evaluate((0, eval)(PROBE));

    // What the oracle itself must have produced: a click aimed through the
    // labelled control at the element inside it, a click the browser
    // accounts a person's and grants activation for, a menu that opened
    // only because the pointer arrived from outside it, and a control
    // sitting under the keyboard.
    assert.deepEqual(reactions, {
      heard: ['inner', 'outer'],
      clicks: [true],
      menu: '0px',
      focused: 'text',
      activation: true,
    });

    // The native runtime, joining the same browser as a second reader.
    const broker = JSON.parse(
      fs.readFileSync(path.join(profile, 'tawb-broker.json'), 'utf8'));
    const native = await callAsync('firefox.actions_scenario', {
      url: `ws://127.0.0.1:${broker.port}/session`,
      page: url,
      targets: TARGETS,
      probe: PROBE,
    });
    assert.deepEqual(native.actions, answers);
    assert.deepEqual(native.reactions, reactions);
  } finally {
    await driver.close().catch(() => {});
    removeTempDir(root);
  }
});
