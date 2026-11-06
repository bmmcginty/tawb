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

const {
  CONSTRUCTS, CONSTRUCT_PAGE, MARKERS, INERT_OVERLAY_PAGE, HIDDEN_OVERLAY_PAGE,
  PSEUDO_PAGE, LABELLEDBY_PAGE, NESTED_CONTROLS_PAGE, POINTER_SLIDER_PAGE,
  TWO_LABELS_PAGE, MEDIA_PAGE, MODAL_PAGE, DECORATION_PAGE, IMAGE_CONTROL_PAGE,
} = require('./views_scenarios');

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

// Which markers each case owns. A marker suffixed with x is scaffolding for a
// neighbouring case and is not asserted on here.

for (const view of VIEWS) {
  test(`${view} view: a live frame keeps the inert page behind it out of reach`, async () => {
    const text = await readFixture(INERT_OVERLAY_PAGE, view);
    assert.ok(!text.includes('M33'), 'the inert page behind the frame was read');
    assert.ok(!text.includes('M34'), 'a control behind the frame was offered');
    assert.match(text, /<frame: Sign in>/);
    assert.match(text, /M35 inside the frame/);
    assert.match(text, /\[\*M36 close\]/);
  });
}

for (const view of VIEWS) {
  test(`${view} view: an aria-hidden overlay does not hold an accessible lock`, async () => {
    const text = await readFixture(HIDDEN_OVERLAY_PAGE, view);
    assert.ok(!text.includes('M37'), 'a prompt the page hid from assistive technology was read');
    assert.match(text, /M38 behind the hidden prompt/,
      'an inert page was left unreadable behind an inaccessible overlay');
  });
}

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
