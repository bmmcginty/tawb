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
const { Core } = require('../../src/core');
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

check('file inputs and intercepted choosers receive the same files', async () => {
  const root = tempDir('tawb-crystal-files-');
  const profile = path.join(root, 'profile');
  const pagePath = path.join(root, 'files.html');
  const uploadPath = path.join(root, 'report.txt');
  fs.writeFileSync(uploadPath, 'a report from the terminal\n');
  fs.writeFileSync(pagePath, `<!doctype html><html><body>
<input type="file" id="plain">
<input type="file" id="hidden" style="display:none">
<button id="choose">Choose</button>
<script>
  window.picked = {};
  for (const id of ['plain', 'hidden']) {
    document.getElementById(id).addEventListener('change', (event) => {
      window.picked[id] = [...event.target.files].map((file) => file.name + ':' + file.size);
    });
  }
  document.getElementById('choose').onclick = () => document.getElementById('hidden').click();
</script></body></html>`);
  const url = `file://${pagePath}`;
  const probe = `() => ({ plain: window.picked.plain, hidden: window.picked.hidden })`;

  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  try {
    const page = await driver.context.newPage();
    await page.goto(url);
    const frame = page.mainFrame();
    const direct = await frame.evaluateHandle((sel) => document.querySelector(sel), '#plain');
    assert.equal(await driver.setFiles(direct, [uploadPath]), true);
    await direct.dispose();

    let chooserMeta = null;
    const chooserDone = new Promise((resolve, reject) => {
      driver.attachFileChooser(async (request) => {
        try {
          chooserMeta = { multiple: request.multiple, directory: request.directory };
          await request.setFiles([uploadPath]);
          resolve();
        } catch (error) {
          reject(error);
        }
      }).catch(reject);
    });
    assert.equal(await driver.armFileChooser(page), true);
    const button = await frame.evaluateHandle((sel) => document.querySelector(sel), '#choose');
    await driver.realClick(frame, button);
    await button.dispose();
    await chooserDone;
    const reactions = await frame.evaluate((0, eval)(probe));
    const expected = {
      direct: true,
      clicked: { ok: true },
      chooser: chooserMeta,
      reactions,
    };
    assert.deepEqual(reactions, {
      plain: ['report.txt:27'], hidden: ['report.txt:27'],
    });

    const broker = JSON.parse(
      fs.readFileSync(path.join(profile, 'tawb-broker.json'), 'utf8'));
    const native = await callAsync('firefox.files_scenario', {
      url: `ws://127.0.0.1:${broker.port}/session`, page: url,
      input: '#plain', button: '#choose', paths: [uploadPath], probe,
    });
    assert.deepEqual(native, expected);
    await page.close().catch(() => {});
  } finally {
    await driver.attachFileChooser(null).catch(() => {});
    await driver.close().catch(() => {});
    removeTempDir(root);
  }
});

// Adjusting a control with the keyboard it is required to support. A native
// range input honors ArrowRight and needs nothing else. A custom ARIA slider
// that advertises a range and then ignores every standard key gets its value
// mapped onto the range and pressed onto the track with trusted pointer
// input — the fallback. A control that is not a slider at all keeps the
// keyboard's own answer and never falls back, whatever its role.
const SLIDER_FIXTURE = `<!doctype html><html><body>
<input id="native" type="range" min="0" max="100" step="1" value="50">
<div id="custom" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="100"
  aria-valuenow="50" aria-valuestep="1"
  style="width:200px;height:24px;background:#ccc"></div>
<div id="spin" role="spinbutton" tabindex="0" aria-valuemin="0" aria-valuemax="100"
  aria-valuenow="50">50</div>
<script>
  const custom = document.getElementById('custom');
  custom.addEventListener('mousedown', (event) => {
    const rect = custom.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    custom.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  });
  const spin = document.getElementById('spin');
  spin.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') {
      const next = String(Number(spin.getAttribute('aria-valuenow')) + 1);
      spin.setAttribute('aria-valuenow', next);
      spin.textContent = next;
    }
  });
</script>
</body></html>`;

const SLIDER_TARGETS = [
  { action: 'adjust_control', selector: '#native', index: 0, role: 'slider', key: 'ArrowRight' },
  { action: 'adjust_control', selector: '#custom', index: 0, role: 'slider', key: 'ArrowRight' },
  { action: 'adjust_control', selector: '#spin', index: 0, role: 'spinbutton', key: 'ArrowRight' },
];

const SLIDER_PROBE = `() => ({
  native: document.getElementById('native').value,
  custom: document.getElementById('custom').getAttribute('aria-valuenow'),
  spin: document.getElementById('spin').getAttribute('aria-valuenow'),
})`;

check('a slider adjusts the same way however the runtime asks it', async () => {
  const root = tempDir('tawb-crystal-slider-');
  const profile = path.join(root, 'profile');
  const pagePath = path.join(root, 'slider.html');
  fs.writeFileSync(pagePath, SLIDER_FIXTURE);
  const url = `file://${pagePath}`;

  const driver = await openDriver({ engine: 'firefox', profile, log: () => {} });
  try {
    const page = await driver.context.newPage();
    await page.goto(url);
    const frame = page.mainFrame();
    const core = new Core({ driver, page, source: 'ax' });
    const answers = [];
    for (const target of SLIDER_TARGETS) {
      const handle = await frame.evaluateHandle(
        `document.querySelectorAll('${target.selector}')[${target.index}]`);
      try {
        answers.push(await core.adjustControlHandle(
          page.keyboard, frame, target.role, handle, target.key));
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
    const reactions = await frame.evaluate((0, eval)(SLIDER_PROBE));

    // The keyboard's own answer on the controls that honor it — no fallback,
    // no target, just the change — and the pointer fallback on the slider
    // that ignored the key, landing on the value the range asked for.
    assert.deepEqual(answers[0], { changed: true, fallback: false, before: '50', after: '51' });
    assert.deepEqual(answers[2], { changed: true, fallback: false, before: '50', after: '51' });
    assert.equal(answers[1].changed, true);
    assert.equal(answers[1].fallback, true);
    assert.equal(answers[1].target, 51);
    assert.equal(answers[1].before, '50');
    assert.equal(answers[1].after, '51');

    // The page ended in the same state the answers describe.
    assert.deepEqual(reactions, { native: '51', custom: '51', spin: '51' });

    // The native runtime, joining the same browser as a second reader.
    const broker = JSON.parse(
      fs.readFileSync(path.join(profile, 'tawb-broker.json'), 'utf8'));
    const native = await callAsync('firefox.actions_scenario', {
      url: `ws://127.0.0.1:${broker.port}/session`,
      page: url,
      targets: SLIDER_TARGETS,
      probe: SLIDER_PROBE,
    });
    assert.deepEqual(native.actions, answers);
    assert.deepEqual(native.reactions, reactions);
  } finally {
    await driver.close().catch(() => {});
    removeTempDir(root);
  }
});
