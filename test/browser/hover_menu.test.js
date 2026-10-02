'use strict';

// A dropdown menu, opened the way a sighted user opens one.
//
// A submenu's contents do not exist until the pointer is over the item above
// them, and pages arrange that in more than one way. Both arrangements below
// were measured on https://celticchoir.ca/, whose Shape5 Joomla template
// contains both: the template ships a CSS-only menu for a browser without
// script, and MenuMatic replaces it with a script-driven one on
// jQuery(document).ready.
//
// Neither arrangement can be reached by a reader without the pointer:
//
//   parked off-screen   the link is in the accessibility tree, so the reader
//                       can see the line, and `m` refuses it with "cannot be
//                       brought onto the screen" because a document does not
//                       scroll left of zero
//   display:none        the link is not in the accessibility tree at all, so
//                       there is no line to move to and nothing to refuse

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');
const { prepareRealClick } = require('../../src/click');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-hover-menu-');
let driver;

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

// The CSS-only arrangement. The submenu is a real box the whole time, a
// thousand ems to the left of the viewport, and `#nav li:hover ul` brings it
// back. Nothing in the page listens for anything: only the pointer's own
// :hover state moves it, which is why synthetic mouse events cannot open this
// one and a real pointer must.
const CSS_MENU = `
  <style>
    #nav, #nav ul { list-style: none; margin: 0; padding: 0; }
    #nav > li { position: relative; float: left; padding: 8px; }
    #nav li ul { position: absolute; width: 10em; margin-left: -1000em; }
    #nav li:hover ul { margin-left: 0; }
  </style>
  <ul id="nav">
    <li><a href="javascript:;">Members</a>
      <ul><li><a href="/sectionals">Sectionals</a></li></ul>
    </li>
  </ul>
`;

// The script arrangement. The submenu is moved out of the menu into a
// container elsewhere in the document, as MenuMatic does, and the wrapper it
// lands in is display:none until a mouseover handler shows it.
const SCRIPT_MENU = `
  <style>
    #nav, #nav ul, #subs ul { list-style: none; margin: 0; padding: 0; }
    #nav > li { float: left; padding: 8px; }
    #subs { position: absolute; top: 40px; left: 0; }
    #subs > div { display: none; }
  </style>
  <ul id="nav"><li id="parent"><a href="javascript:;">Members</a></li></ul>
  <div id="subs"></div>
  <script>
    const wrap = document.createElement('div');
    wrap.innerHTML = '<ul><li><a href="/sectionals" tabindex="-1">Sectionals</a></li></ul>';
    document.querySelector('#subs').appendChild(wrap);
    document.querySelector('#parent').addEventListener('mouseover', () => {
      wrap.style.display = 'block';
    });
  </script>
`;

async function readerView(page) {
  const core = new Core({ driver, page, source: 'ax' });
  await core.rescan();
  return core;
}

function lineFor(core, name) {
  const block = core.blocks.find((b) => b.item && b.item.name === name);
  return block ? block.item : null;
}

test('the pointer opens a submenu parked off the side of the viewport', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  await page.goto(`data:text/html,${encodeURIComponent(CSS_MENU)}`);

  let core = await readerView(page);
  const shut = lineFor(core, 'Sectionals');
  assert.ok(shut, 'the parked submenu link was not in the reader\'s view');

  // The refusal this whole feature exists for, asked directly.
  const before = await core.handleFor(shut, page);
  const refused = await before.evaluate(prepareRealClick);
  await before.dispose().catch(() => {});
  assert.equal(refused.ok, false, 'the parked link was reachable before the hover');
  assert.match(refused.reason, /cannot be brought onto the screen/);

  const parent = lineFor(core, 'Members');
  assert.ok(parent, 'the menu item that opens the submenu was not in the view');
  const hovered = await core.hover(parent, page);
  assert.ok(hovered.ok, `the hover was refused: ${hovered.reason}`);

  // Re-read the page, as Alt+M does once the menu has had a moment to open.
  await new Promise((resolve) => setTimeout(resolve, 600));
  core = await readerView(page);
  const open = lineFor(core, 'Sectionals');
  assert.ok(open, 'the submenu link left the view when the menu opened');
  const after = await core.handleFor(open, page);
  const ready = await after.evaluate(prepareRealClick);
  await after.dispose().catch(() => {});
  assert.ok(ready.ok, `the link was still unreachable with the menu open: ${ready.reason}`);
});

test('the pointer opens a submenu a script keeps hidden elsewhere in the document', async () => {
  const page = await driver.newTab();
  await page.goto(`data:text/html,${encodeURIComponent(SCRIPT_MENU)}`);

  let core = await readerView(page);
  assert.equal(lineFor(core, 'Sectionals'), null,
    'a display:none submenu link reached the reader\'s view');

  const parent = lineFor(core, 'Members');
  assert.ok(parent, 'the menu item that opens the submenu was not in the view');
  const hovered = await core.hover(parent, page);
  assert.ok(hovered.ok, `the hover was refused: ${hovered.reason}`);

  await new Promise((resolve) => setTimeout(resolve, 600));
  core = await readerView(page);
  const open = lineFor(core, 'Sectionals');
  assert.ok(open, 'the submenu link did not appear when the menu opened');

  // tabindex="-1" is what MenuMatic puts on every submenu link, so the line
  // is unreachable by Tab even now. Activating a line does not go through
  // the tab order, so it is still pressable.
  const handle = await core.handleFor(open, page);
  const ready = await handle.evaluate(prepareRealClick);
  await handle.dispose().catch(() => {});
  assert.ok(ready.ok, `the revealed link was unreachable: ${ready.reason}`);
});
