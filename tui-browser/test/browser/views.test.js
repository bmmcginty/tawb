'use strict';

// What each view makes of a page, against a real browser.
//
//     npm run test:browser
//     xvfb-run -a npm run test:browser     # with no display of your own
//
// These are the questions only a rendering engine can answer: whether an
// element is on screen, and what it computes to once the page's CSS has run.
// Guessing at them from markup is exactly the mistake these tests exist to
// catch, so every case here is a small construct read through a real browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { openDriver } = require('../../src/driver');
const { snapshotFrameTree } = require('../../src/frames');
const { start: startTestPage } = require('../../tools/serve');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const VIEWS = ['ax', 'render'];

// A profile of this file's own. The default one is shared, and a browser is
// one instance per profile directory, so two test files that took it would
// rejoin the same browser, navigate the same tab out from under each other
// and close it while the other was still reading.
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

// Fixtures get a tab and a server of their own, so reading one cannot disturb
// the test page in the other tab — which matters more than it sounds: a modal
// dialog makes the whole rest of its document inert, and a fixture that
// opened one in the shared page would empty every other test.
let fixture = null;
async function readFixture(html, view) {
  const { driver } = await browser();
  if (!fixture) {
    let body = '';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const page = await driver.newTab();
    fixture = {
      server,
      page,
      url: `http://127.0.0.1:${server.address().port}/`,
      set: (h) => { body = h; },
      showing: null,
    };
  }
  if (fixture.showing !== html) {
    fixture.set(html);
    await fixture.page.goto(fixture.url, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 250));
    fixture.showing = html;
  }
  const blocks = await snapshotFrameTree(fixture.page, view, { driver });
  return blocks.map((block) => block.text).join('\n');
}

test.after(async () => {
  if (fixture) fixture.server.close();
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

// --- the test page ---------------------------------------------------------

for (const view of VIEWS) {
  test(`${view} view: a wrapper that generates no box does not hide what it renders`, async () => {
    assert.match(await linesOf(view), /Read through a wrapper that generates no box\./);
  });

  test(`${view} view: a closed disclosure still hides what is inside such a wrapper`, async () => {
    const text = await linesOf(view);
    assert.ok(!text.includes('Hidden behind a closed disclosure'),
      'a closed <details> hides its contents however they are wrapped');
    assert.match(text, /Shipping notes/);
  });
}

// --- what counts as on screen ----------------------------------------------

// One construct per case, each carrying a marker the assertions look for.
// `want` is 'read' or 'skip', or a view-by-view object where the two views
// differ on purpose.
const CONSTRUCTS = [
  ['a plain paragraph', 'read', '<p>M01</p>'],
  ['a display:contents wrapper', 'read', '<div style="display:contents"><p>M02</p></div>'],
  ['nested display:contents wrappers', 'read',
    '<div style="display:contents"><div style="display:contents"><p>M03</p></div></div>'],
  ['a list that generates no box', 'read', '<ul style="display:contents"><li>M04</li></ul>'],
  ['bare text in a display:contents wrapper', 'read', '<div style="display:contents">M05</div>'],
  ['visibility:hidden', 'skip', '<div style="visibility:hidden"><p>M06</p></div>'],
  // visibility is inherited but a descendant may set it back, and the browser
  // then renders that descendant alone. A walk that stops at the ancestor
  // never finds it.
  ['a visible child of a visibility:hidden parent', 'read',
    '<div style="visibility:hidden"><p style="visibility:visible">M07</p></div>'],
  ['content-visibility:hidden', 'skip', '<div style="content-visibility:hidden"><p>M08</p></div>'],
  // Content the browser has merely not got to yet is the off-screen text this
  // program exists to reach, so it is read rather than skipped.
  ['content-visibility:auto', 'read',
    '<div style="content-visibility:auto;contain-intrinsic-size:200px"><p>M09</p></div>'],
  ['the hidden attribute', 'skip', '<div hidden><p>M10</p></div>'],
  // Inert content is on screen and has a box, and nothing in its style says
  // it is gone; the specification says to hide it from assistive technology,
  // and a control the browser will not activate is worse than absent.
  ['an inert subtree', 'skip', '<div inert><p>M12</p><button>M13</button></div>'],
  ['aria-hidden', 'skip', '<div aria-hidden="true"><p>M14</p></div>'],
  // The accessibility tree carries text painted at zero opacity; the view of
  // what is on screen does not. The two disagree on purpose.
  ['opacity:0', { ax: 'read', render: 'skip' }, '<div style="opacity:0"><p>M15</p></div>'],
  ['the visually-hidden pattern', 'read',
    '<p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">M16</p>'],
  ['content positioned off screen', 'read', '<p style="position:absolute;left:-9999px">M17</p>'],
  ['content in a zero-sized clipping box', 'read',
    '<div style="width:0;height:0;overflow:hidden"><p>M18</p></div>'],
  ['the summary of a closed disclosure', 'read', '<details><summary>M19</summary><p>M20x</p></details>'],
  ['the body of a closed disclosure', 'skip', '<details><summary>M21x</summary><p>M20</p></details>'],
  ['the body of an open disclosure', 'read', '<details open><summary>M21</summary><p>M22</p></details>'],
  ['a visibility:collapse table row', 'skip',
    '<table><tr style="visibility:collapse"><td>M23</td></tr><tr><td>M24x</td></tr></table>'],
  ['a template', 'skip', '<template><p>M25</p></template>'],
  ['a dialog that is not open', 'skip', '<dialog><p>M27</p></dialog>'],
  ['a closed popover', 'skip', '<div popover><p>M30</p></div>'],
  ['content in an open shadow root', 'read', '<div id="sr1"></div>'],
  ['the fallback content of an empty slot', 'read', '<div id="sr2"></div>'],
];

const CONSTRUCT_PAGE = `<!doctype html><meta charset="utf-8"><title>constructs</title>
${CONSTRUCTS.map(([, , html]) => html).join('\n')}
<script>
  document.getElementById('sr1').attachShadow({ mode: 'open' }).innerHTML = '<p>M31</p>';
  document.getElementById('sr2').attachShadow({ mode: 'open' }).innerHTML = '<slot><p>M32</p></slot>';
</script>`;

// Which markers each case owns. A marker suffixed with x is scaffolding for a
// neighbouring case and is not asserted on here.
const MARKERS = {
  'a plain paragraph': ['M01'],
  'a display:contents wrapper': ['M02'],
  'nested display:contents wrappers': ['M03'],
  'a list that generates no box': ['M04'],
  'bare text in a display:contents wrapper': ['M05'],
  'visibility:hidden': ['M06'],
  'a visible child of a visibility:hidden parent': ['M07'],
  'content-visibility:hidden': ['M08'],
  'content-visibility:auto': ['M09'],
  'the hidden attribute': ['M10'],
  'an inert subtree': ['M12', 'M13'],
  'aria-hidden': ['M14'],
  'opacity:0': ['M15'],
  'the visually-hidden pattern': ['M16'],
  'content positioned off screen': ['M17'],
  'content in a zero-sized clipping box': ['M18'],
  'the summary of a closed disclosure': ['M19'],
  'the body of a closed disclosure': ['M20'],
  'the body of an open disclosure': ['M22'],
  'a visibility:collapse table row': ['M23'],
  'a template': ['M25'],
  'a dialog that is not open': ['M27'],
  'a closed popover': ['M30'],
  'content in an open shadow root': ['M31'],
  'the fallback content of an empty slot': ['M32'],
};

for (const view of VIEWS) {
  for (const [what, want] of CONSTRUCTS) {
    const expected = typeof want === 'string' ? want : want[view];
    test(`${view} view: ${what} is ${expected === 'read' ? 'read' : 'not read'}`, async () => {
      const text = await readFixture(CONSTRUCT_PAGE, view);
      for (const marker of MARKERS[what]) {
        assert.equal(text.includes(marker), expected === 'read',
          `${marker} should be ${expected} in the ${view} view`);
      }
    });
  }
}

// --- names a stylesheet wrote ----------------------------------------------

// Generated content is in no node, so a walk over the DOM alone never sees a
// word of it — and a button whose only text is a ::before disappears outright
// rather than merely losing its name.
const PSEUDO_PAGE = `<!doctype html><meta charset="utf-8"><title>pseudo</title>
<style>
  #b::before { content: "Save"; }
  #l::after { content: " (opens in a new window)"; }
  #c::before { content: counter(nope); }
</style>
<button id="b"></button>
<a id="l" href="/x">Docs</a>
<button id="c">Plain</button>`;

test('ax view: a control whose only text comes from a stylesheet is still named', async () => {
  assert.match(await readFixture(PSEUDO_PAGE, 'ax'), /\[\*Save\]/);
});

test('ax view: generated content after a name is part of the name', async () => {
  assert.match(await readFixture(PSEUDO_PAGE, 'ax'), /\{Docs \(opens in a new window\)\}/);
});

test('ax view: a name is not given the unresolved text of a counter', async () => {
  const text = await readFixture(PSEUDO_PAGE, 'ax');
  assert.match(text, /\[\*Plain\]/);
  assert.ok(!text.includes('counter'), 'content that is not a literal string is left out');
});

// --- names reached through a reference --------------------------------------

// aria-labelledby is read out of the referenced element whether or not it is
// on screen, and the exception covers hiddenness that element's contents
// inherit — but not hiddenness a descendant declared for itself.
const LABELLEDBY_PAGE = `<!doctype html><meta charset="utf-8"><title>labelledby</title>
<button aria-labelledby="whole">unused</button>
<span id="whole" style="display:none">alpha <span>beta</span></span>
<button aria-labelledby="part">unused</button>
<span id="part">gamma <span style="display:none">delta</span></span>`;

test('ax view: a hidden label is read through to its nested content', async () => {
  assert.match(await readFixture(LABELLEDBY_PAGE, 'ax'), /\[\*alpha beta\]/);
});

test('ax view: a label does not pick up what it hid on purpose', async () => {
  const text = await readFixture(LABELLEDBY_PAGE, 'ax');
  assert.match(text, /\[\*gamma\]/);
  assert.ok(!text.includes('delta'), 'a descendant hidden while its parent is shown was singled out');
});

// A modal dialog is its own page, because it inerts everything else in the
// document it is opened in — which is the whole point of the case.
const MODAL_PAGE = `<!doctype html><meta charset="utf-8"><title>modal</title>
<p>D01 ordinary prose</p>
<button>D02 a button on the page</button>
<dialog id="d"><p>D03 inside the dialog</p><button>D04 in the dialog</button></dialog>
<script>document.getElementById('d').showModal();</script>`;

for (const view of VIEWS) {
  test(`${view} view: an open modal dialog is read`, async () => {
    const text = await readFixture(MODAL_PAGE, view);
    assert.match(text, /D03/);
    assert.match(text, /D04/);
  });

  test(`${view} view: an open modal dialog inerts the page behind it`, async () => {
    const text = await readFixture(MODAL_PAGE, view);
    assert.ok(!text.includes('D01'), 'prose behind a modal is inert');
    assert.ok(!text.includes('D02'), 'a control behind a modal cannot be activated, so it is not offered');
  });
}
