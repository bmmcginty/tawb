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
const http = require('node:http');

const { tempDir, removeTempDir } = require('../tmpdir');

const { openDriver } = require('../../src/driver');
const { snapshotFrameTree } = require('../../src/frames');
const { Core } = require('../../src/core');
const { start: startTestPage } = require('../../tools/serve');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const VIEWS = ['ax', 'render'];

// A profile of this file's own. The default one is shared, and a browser is
// one instance per profile directory, so two test files that took it would
// rejoin the same browser, navigate the same tab out from under each other
// and close it while the other was still reading.
const profile = tempDir('tweb-views-');

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
    // A fixture with something to wait for says so, rather than the harness
    // guessing at a delay: media metadata arrives when it arrives.
    await fixture.page.waitForFunction(
      () => window.__ready === undefined || window.__ready === true, null, { timeout: 5000 },
    ).catch(() => {});
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
  removeTempDir(profile);
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
<button id="c">Plain</button>
<style>#w span::before { content: attr(data-content); display: block; height: 0; visibility: hidden; }</style>
<a id="w" href="/w"><span data-content="Insights">Insights</span></a>`;

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

test('ax view: a name is not doubled by a hidden pseudo element reserving width', async () => {
  const text = await readFixture(PSEUDO_PAGE, 'ax');
  assert.match(text, /\{Insights\}/);
  assert.ok(!text.includes('InsightsInsights'),
    'drawing a bolder copy of a tab behind itself is layout, not content');
});

test('ax view: an SVG image can name a link', async () => {
  const text = await readFixture(
    '<a href="/"><svg role="img" aria-label="Home"><path d="M0 0"></path></svg></a>',
    'ax',
  );
  assert.match(text, /\{Home\}/);
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

const NESTED_CONTROLS_PAGE = `<!doctype html><meta charset="utf-8"><title>nested controls</title>
<div role="button" aria-label="Player" tabindex="0">
  <div role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100"
       aria-valuenow="35" aria-orientation="vertical" tabindex="0">
    <div role="button" aria-label="Mute" tabindex="0"></div>
  </div>
</div>`;

for (const view of VIEWS) {
  test(`${view} view: focusable controls nested inside controls remain operable`, async () => {
    const text = await readFixture(NESTED_CONTROLS_PAGE, view);
    assert.match(text, /\[\*Player\]/);
    assert.match(text, /\[Volume: 35(?:, vertical)?\]/);
    assert.match(text, /\[\*Mute\]/);
  });
}

test('inspect view identifies invalid nested focusable controls', async () => {
  const text = await readFixture(NESTED_CONTROLS_PAGE, 'inspect');
  assert.match(text, /Volume.*focusable inside button/);
  assert.match(text, /Mute.*focusable inside slider/);
});

const POINTER_SLIDER_PAGE = `<!doctype html><meta charset="utf-8"><title>pointer slider</title>
<div role="slider" aria-label="Pointer volume" aria-valuemin="0" aria-valuemax="100"
     aria-valuenow="0" tabindex="0" style="width:20px;height:100px;background:#ccc"></div>
<script>
  const slider = document.querySelector('[role=slider]');
  slider.addEventListener('click', event => {
    const box = slider.getBoundingClientRect();
    const value = Math.round(100 * (1 - (event.clientY - box.top) / box.height));
    slider.setAttribute('aria-valuenow', Math.max(0, Math.min(100, value)));
  });
</script>`;

test('a slider that ignores keys is adjusted through its visual track', async () => {
  await readFixture(POINTER_SLIDER_PAGE, 'ax');
  const { driver } = await browser();
  const blocks = await snapshotFrameTree(fixture.page, 'ax', { driver });
  const slider = blocks.find((block) => block.item && block.item.role === 'slider');
  assert.ok(slider);
  const core = new Core({ driver, page: fixture.page, source: 'ax', sources: ['ax'] });
  const result = await core.adjustControl(slider.item, 'ArrowUp', fixture.page);
  const value = await fixture.page.evaluate(
    () => Number(document.querySelector('[role=slider]').getAttribute('aria-valuenow')));
  assert.equal(result.fallback, true);
  assert.equal(result.changed, true);
  assert.ok(value >= 3 && value <= 7, `pointer set ${value}, not approximately 5`);
});

test('ax view: a hidden label is read through to its nested content', async () => {
  assert.match(await readFixture(LABELLEDBY_PAGE, 'ax'), /\[\*alpha beta\]/);
});

test('ax view: a label does not pick up what it hid on purpose', async () => {
  const text = await readFixture(LABELLEDBY_PAGE, 'ax');
  assert.match(text, /\[\*gamma\]/);
  assert.ok(!text.includes('delta'), 'a descendant hidden while its parent is shown was singled out');
});

const TWO_LABELS_PAGE = `<!doctype html><meta charset="utf-8"><title>labels</title>
<label for="dob">Date of birth</label>
<label for="dob">(day, month, year)</label>
<input id="dob">`;

test('ax view: a field labelled twice is named by both labels', async () => {
  assert.match(await readFixture(TWO_LABELS_PAGE, 'ax'), /\[Date of birth \(day, month, year\)\]/);
});

// --- where a player has got to ---------------------------------------------

// Asked of the element, because the page stops saying: YouTube freezes its
// own clock at whatever it read when the controls last auto-hid, and they
// hide after a few seconds without a mouse, which for a reader is always.
//
// The audio is built here rather than fetched — three seconds of silence as a
// data URI — so the case needs no network and no fixture file.
const MEDIA_PAGE = `<!doctype html><meta charset="utf-8"><title>media</title>
<audio id="a" controls></audio>
<script>
  window.__ready = false;
  const rate = 8000, seconds = 3, samples = rate * seconds;
  const buf = new ArrayBuffer(44 + samples);
  const view = new DataView(buf);
  const str = (at, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  str(36, 'data'); view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) view.setUint8(44 + i, 128);
  let binary = '';
  for (const byte of new Uint8Array(buf)) binary += String.fromCharCode(byte);
  const el = document.getElementById('a');
  el.addEventListener('loadedmetadata', () => { el.currentTime = 1; window.__ready = true; }, { once: true });
  el.src = 'data:audio/wav;base64,' + btoa(binary);
</script>`;

for (const view of VIEWS) {
  test(`${view} view: a player reports where it has got to`, async () => {
    assert.match(await readFixture(MEDIA_PAGE, view), /\(audio\) paused, 0:01 of 0:03/);
  });
}

test('source view marks the browser-owned media shadow tree', async () => {
  const text = await readFixture(MEDIA_PAGE, 'source');
  assert.match(text, /#user-agent-shadow-root/i);
  assert.match(text, /<(?:input|button|native-control)/i);
});

test('inspect view pairs native media semantics with browser-owned markup', async () => {
  const text = await readFixture(MEDIA_PAGE, 'inspect');
  assert.match(text, /(?:audio time scrubber|position).*<(?:input|native-control)/i);
  assert.match(text, /#(?:privileged|user-agent)-shadow-root/i);
});

test('ax view: visible native player controls are rendered', async () => {
  const text = await readFixture(MEDIA_PAGE, 'ax');
  assert.match(text, /\[\*play\]/i);
  assert.match(text, /\[\*mute\]/i);
  assert.match(text, /\[(?:audio time scrubber|position):/i);
});

test('ax view: the native time scrubber accepts keyboard control', async () => {
  await readFixture(MEDIA_PAGE, 'ax');
  const { driver } = await browser();
  const blocks = await snapshotFrameTree(fixture.page, 'ax', { driver });
  const scrubber = blocks.find((block) => block.item
    && block.item.role === 'slider' && /time scrubber|position/i.test(block.item.name));
  assert.ok(scrubber, 'the time scrubber is in the buffer');

  const core = new Core({ driver, page: fixture.page, source: 'ax', sources: ['ax'] });
  assert.equal(await core.focusControl(scrubber.item, fixture.page), true);
  const before = await fixture.page.evaluate(() => document.querySelector('audio').currentTime);
  await fixture.page.keyboard.press('ArrowRight');
  const after = await fixture.page.evaluate(() => document.querySelector('audio').currentTime);
  assert.notEqual(after, before, 'ArrowRight did not adjust elapsed time');
});

test('ax view: the native play control operates the player', async () => {
  await readFixture(MEDIA_PAGE, 'ax');
  const { driver } = await browser();
  const blocks = await snapshotFrameTree(fixture.page, 'ax', { driver });
  const play = blocks.find((block) => block.item
    && block.item.role === 'button' && block.item.name.toLowerCase() === 'play');
  assert.ok(play, 'the visible Play control is in the buffer');

  const core = new Core({ driver, page: fixture.page, source: 'ax', sources: ['ax'] });
  await core.activate(play.item, fixture.page);
  assert.equal(await fixture.page.evaluate(() => document.querySelector('audio').paused), false);
  await fixture.page.evaluate(() => document.querySelector('audio').pause());
});

if (ENGINE === 'chromium') {
  test('ax view: playback-speed menu items remain clickable controls', async () => {
    await readFixture(MEDIA_PAGE, 'ax');
    const { driver } = await browser();
    const core = new Core({ driver, page: fixture.page, source: 'ax', sources: ['ax'] });
    const blocks = async () => snapshotFrameTree(fixture.page, 'ax', { driver });
    const named = async (name) => (await blocks()).find(
      (block) => block.item && block.item.name.toLowerCase() === name);

    const more = await named('show more media controls');
    assert.ok(more, 'the overflow button is visible');
    await core.activate(more.item, fixture.page);
    const speed = await named('show playback speed menu');
    assert.ok(speed, 'the speed submenu is visible');
    await core.activate(speed.item, fixture.page);

    const rate = await named('1.5');
    assert.ok(rate, 'the speed is an interactive line, not plain text');
    assert.ok(['menuitemcheckbox', 'menuitemradio'].includes(rate.item.role));
    assert.equal((await core.realClick(rate.item, fixture.page)).ok, true);
    assert.equal(await fixture.page.evaluate(() => document.querySelector('audio').playbackRate), 1.5);
  });
}

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

// --- pictures the page paints and no text accounts for ----------------------

// The case this came from, reduced from https://celticchoir.ca/. Three of the
// five menu items open a dropdown, and the only thing distinguishing those
// three is a triangle painted from a stylesheet. PAGE view has to say so,
// because nothing about a background image reaches the accessibility tree and
// the reader is otherwise looking at five identical links.
const DECORATION_PAGE = `<!doctype html><meta charset="utf-8"><title>decoration</title>
<style>
  .parent a { background: url(/images/s5_menu_arrow.png) no-repeat right center; padding-right: 18px; }
  #tile { background-image: url(/images/hero_banner.jpg); width: 300px; height: 120px; }
  #grad { background-image: linear-gradient(#fff, #000); width: 40px; height: 40px; }
  #both { background-image: linear-gradient(#fff, #000), url(/images/star_filled.png); width: 40px; height: 40px; }
  #gen::after { content: url(/images/external_link.png); }
  #iconbtn .icon { background-image: url(/images/floppy_disk.png); width: 16px; height: 16px; display: inline-block; }
</style>
<ul>
  <li class="parent"><a href="javascript:;">About Us</a></li>
  <li class="parent"><a href="javascript:;">Concerts</a></li>
  <li><a href="/links">Links</a></li>
</ul>
<div id="tile"></div>
<div id="grad"></div>
<div id="both"></div>
<a id="gen" href="/spec">Specification</a>
<button id="iconbtn"><span class="icon"></span>Save</button>
<img src="/images/welsh_harpist.jpg" width="40" height="40">
<img src="/images/spacer.gif" alt="" width="40" height="40">
<img src="/images/crowd.jpg" alt="A festival crowd" width="40" height="40">
<svg aria-hidden="true" width="16" height="16"><path d="M0 0"></path></svg>`;

test('render view: a stylesheet triangle marks the menu items that open a dropdown', async () => {
  const text = await readFixture(DECORATION_PAGE, 'render');
  assert.match(text, /\{About Us\} \(image: s5 menu arrow\)/);
  assert.match(text, /\{Concerts\} \(image: s5 menu arrow\)/);
  // The item without a dropdown must stay bare, or the mark means nothing.
  assert.match(text, /\{Links\}$/m);
});

test('render view: an element that paints a picture and says nothing gets a line', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /^\(image: hero banner\)$/m);
});

test('render view: a gradient is colour rather than picture and is not reported', async () => {
  const text = await readFixture(DECORATION_PAGE, 'render');
  assert.ok(!text.includes('gradient'), 'background-image also carries gradients');
});

test('render view: the url layer of a gradient-and-url background is still reported', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /^\(image: star filled\)$/m);
});

test('render view: a picture in generated content is reported', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /\{Specification\} \(image: external link\)/);
});

// A control is emitted whole and its descendants never get a line of their
// own, so an icon painted onto a span inside a button has to travel up to the
// button's line.
test('render view: an icon inside a control is reported on the control', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /\[\*Save\] \(image: floppy disk\)/);
});

test('render view: an image whose alt attribute the page never wrote is named by its file', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /^\(image: welsh harpist\)$/m);
});

test('render view: alt="" is the page saying the picture carries nothing, and is obeyed', async () => {
  const text = await readFixture(DECORATION_PAGE, 'render');
  assert.ok(!text.includes('spacer'), 'an empty alt attribute is a declaration, not an omission');
});

test('render view: an image the page named is still read as the page named it', async () => {
  assert.match(await readFixture(DECORATION_PAGE, 'render'), /^\(image\) A festival crowd$/m);
});

test('render view: aria-hidden is the page saying the picture carries nothing, and is obeyed', async () => {
  const text = await readFixture(DECORATION_PAGE, 'render');
  assert.ok(!text.includes('graphic'), 'a decorative svg is already dropped as hidden');
});

// The accessibility tree has nothing to say about any of this, which is the
// reason PAGE view is where it goes. Holding the two views against each other
// is what keeps that claim honest.
test('ax view: a stylesheet triangle is invisible to the accessibility tree', async () => {
  const text = await readFixture(DECORATION_PAGE, 'ax');
  assert.match(text, /\{About Us\}/);
  assert.ok(!text.includes('s5 menu arrow'),
    'a background image has no role and no accessible name');
});

// --- a control the page gave no text --------------------------------------

// A link around an image is the ordinary way to make a picture clickable, and
// a link's own text is empty for every one of them. All four controls below
// were missing from PAGE view outright, which is worse than losing a name:
// the reader had no line to stand on and no way to press them.
const IMAGE_CONTROL_PAGE = `<!doctype html><meta charset="utf-8"><title>image controls</title>
<style>#chip { background-image: url(/images/paper_plane.png); width: 16px; height: 16px; display: block; }</style>
<a id="home" href="/"><img src="/images/ccc_logo.png" alt="ccc logo" width="40" height="40"></a>
<a id="prev" href="/prev"><img src="/images/prev.png" alt="Previous" width="16" height="16"></a>
<a id="plain" href="/photo"><img src="/images/welsh_harpist.jpg" width="40" height="40"></a>
<button id="send"><span id="chip"></span></button>`;

test('render view: a link around a named image is named by that image', async () => {
  const text = await readFixture(IMAGE_CONTROL_PAGE, 'render');
  assert.match(text, /\{ccc logo\}/);
  assert.match(text, /\{Previous\}/);
});

test('render view: a link around an unnamed image is named by the file', async () => {
  assert.match(await readFixture(IMAGE_CONTROL_PAGE, 'render'), /\{\(image: welsh harpist\)\}/);
});

test('render view: a button whose only content is a painted icon is still a button', async () => {
  assert.match(await readFixture(IMAGE_CONTROL_PAGE, 'render'), /\[\*\(image: paper plane\)\]/);
});

// The accessibility view already named three of these four from the same alt
// text, which is how the gap was found. Holding the two views against each
// other is what keeps PAGE view honest about being a second opinion.
test('ax view: a link around a named image was never missing its name', async () => {
  const text = await readFixture(IMAGE_CONTROL_PAGE, 'ax');
  assert.match(text, /\{ccc logo\}/);
  assert.match(text, /\{Previous\}/);
});
