'use strict';

// The http contract the edbrowse server keeps, differenced between the
// JavaScript original and the Crystal port.
//
// Both servers are given a browser written in the same payload and asked the
// same requests, in the same order, and what is compared is the whole of the
// answer — the status, where a redirect goes, the cache headers, the body —
// together with what the browser was asked to do while answering: which
// addresses it was sent to, what was pressed, what was typed into which field.
//
// Two of these matter more than the rest, and both exist because edbrowse
// behaves in ways a page cannot see. Anything that acts on the page answers a
// redirect back to the tab's own url, so the buffer never holds an address that
// would act a second time when the reader types rf. And every response says
// no-cache, because edbrowse caches, and rf would otherwise hand back the
// render before last.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('./tmpdir');

// The server writes where it is listening, for the entry-point plugin to find.
// Both implementations write it, so both are pointed somewhere throwaway.
const state = tempDir('tawb-edb-routes-');
process.env.XDG_DATA_HOME = state;
process.on('exit', () => removeTempDir(state));

const { edbImplementations } = require('./crystal_impl');

const implementations = edbImplementations(require('../src/edb_server'));
const skip = implementations.length < 2 ? 'the Crystal runtime is not enabled' : false;

const desc = (path, tag = 'a', name = '') => ({ tag, path, name });

const PAGE_TOKENS = [
  { kind: 'text', text: 'hello' },
  { kind: 'link', desc: desc('/a[0]', 'a', 'Next'), name: 'Next', navigational: true },
  { kind: 'form-open', desc: desc('/form[0]', 'form') },
  { kind: 'field', tag: 'input', type: 'text', desc: desc('/input[0]', 'input'), label: 'Q', value: '' },
  { kind: 'field', tag: 'input', type: 'submit', desc: desc('/input[1]', 'input'), label: 'Go', value: 'Go' },
  { kind: 'form-close' },
  { kind: 'frame', desc: desc('/iframe[0]', 'iframe', 'comments'), name: 'comments' },
];

const FRAME_TOKENS = [
  { kind: 'text', text: 'inside the frame' },
  { kind: 'link', desc: desc('/button[0]', 'button', 'Verify'), name: 'Verify', navigational: false },
];

function browser(overrides = {}) {
  return {
    tabs: [{
      url: 'https://example.com/one',
      title: 'stub',
      pageTitle: 'stub page',
      tokens: PAGE_TOKENS,
      frames: [{ url: 'https://example.com/frame', title: 'frame', tokens: FRAME_TOKENS }],
    }],
    ...overrides,
  };
}

// The port each server happens to get is its own, and it appears in every
// <base href>. Compared as it stands, every body would differ for a reason
// that is not about the contract.
function normalise(text) {
  return String(text).replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:PORT');
}

async function compare(what, spec) {
  const answers = [];
  for (const implementation of implementations) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await implementation.routesScenario(JSON.parse(JSON.stringify(spec)));
    answers.push({
      name: implementation.name,
      answers: outcome.answers.map((answer) => ({
        status: answer.status,
        location: answer.location,
        cache: answer.cache,
        type: answer.type,
        body: normalise(answer.body),
      })),
      browser: outcome.browser,
    });
  }
  const first = answers[0];
  for (const other of answers.slice(1)) {
    assert.deepEqual(other.answers, first.answers, `${other.name} answered ${what} differently`);
    assert.deepEqual(
      other.browser,
      first.browser,
      `${other.name} asked the browser something different while answering ${what}`,
    );
  }
  return first;
}

test('a request without the right token is not served', { skip }, async () => {
  const { answers } = await compare('an unauthorised request', {
    browser: browser(),
    requests: [
      { path: '/t/nottoken/tabs' },
      { path: '/' },
      { path: '/t/testtoken/nonsense' },
    ],
  });
  assert.equal(answers[0].status, 404);
  assert.equal(answers[1].status, 404);
  assert.equal(answers[2].status, 404);
});

test('the tab list names every open tab, and every answer forbids caching', { skip }, async () => {
  const { answers } = await compare('the tab list', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/tabs' },
      { path: '/t/testtoken/' },
      { path: '/t/testtoken/1/' },
    ],
  });
  // Named by title where it has one, since that is what a reader recognises.
  assert.match(answers[0].body, /stub page/);
  assert.match(answers[0].body, /<a href="1\/">/);
  // The bare token is the tab list too: the plugin can land a reader here.
  assert.equal(answers[1].status, 200);
  for (const answer of answers) {
    assert.match(String(answer.cache), /no-cache|no-store/);
  }
});

test('a tab renders as the page it holds, without being listed first', { skip }, async () => {
  // The address this program prints when it starts goes straight to a tab.
  const { answers, browser: asked } = await compare('a tab', {
    browser: browser(),
    requests: [{ path: '/t/testtoken/1/' }],
  });
  assert.equal(answers[0].status, 200);
  assert.match(answers[0].body, /hello/);
  assert.match(answers[0].body, /<a href="e2">Next<\/a>/);
  // The frame's contents are spliced in where the frame sits, rather than
  // being a line that has to be followed before anything in it can be read.
  assert.match(answers[0].body, /inside the frame/);
  // The frame's own control is an ordinary link here: pressing properly is
  // for a control the page is hiding, and for the frame's own page, where
  // there is no form of the reader's to submit from.
  assert.match(answers[0].body, /<a href="e6">Verify<\/a>/);
  // The password intercept is armed as the tab is handed out, which is per tab
  // on Chromium and does nothing the second time.
  assert.equal(asked[0].armed, true);
});

test('acting on the page answers a redirect, never a page', { skip }, async () => {
  // So the buffer never holds an address that would act a second time when
  // the reader types rf.
  const { answers, browser: asked } = await compare('a link being followed', {
    browser: browser(),
    requests: [
      // Ids exist because a render handed them out, so render first — which is
      // what edbrowse does before it can follow anything.
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/e2' },
    ],
  });
  assert.equal(answers[1].status, 302);
  assert.match(String(answers[1].location), /\/t\/testtoken\/1\//);
  assert.equal(asked[0].document.activated.length, 1);
  // Following a link runs the element's own default action; the real click is
  // for the things that have to be a person.
  assert.equal(asked[0].document.activated[0].real, false);
});

test('a control inside a frame is pressed in that frame', { skip }, async () => {
  const { answers, browser: asked } = await compare('a control inside a frame', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/' },
      // The frame's own control, pressed as a person presses one.
      { path: '/t/testtoken/1/e6/click' },
    ],
  });
  assert.equal(answers[1].status, 302);
  // Acting on the tab's own page would either miss or, worse, hit whatever
  // happens to sit at the same path there — so the press landed in the frame.
  assert.equal(asked[0].document.activated.length, 0);
  assert.equal(asked[0].document.frames[0].activated.length, 1);
  assert.equal(asked[0].document.frames[0].activated[0].real, true);
  // Back to where it was pressed, since pressing it took the page nowhere.
  assert.match(String(answers[1].location), /f\d+$/);
});

test('every page offers back, and back answers a redirect to the tab', { skip }, async () => {
  const { answers, browser: asked } = await compare('back', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/ax' },
      { path: '/t/testtoken/1/back' },
    ],
  });
  assert.match(answers[0].body, /<a href="back">Back<\/a>/);
  assert.match(answers[1].body, /<a href="back">Back<\/a>/);
  assert.equal(answers[2].status, 302);
  assert.match(String(answers[2].location), /\/t\/testtoken\/1\/$/);
  assert.equal(asked[0].backs, 1);
});

test('the four line lists are reachable, each under its own heading', { skip }, async () => {
  // What those lists hold is differenced where the lists are built, in
  // `crystal_views.test.js`. What matters here is that edbrowse can reach all
  // four, which is how the accessibility tree stays reachable from edbrowse —
  // and that is the view that is right when a page's markup is wrong.
  const { answers } = await compare('the four views', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/ax' },
      { path: '/t/testtoken/1/render' },
      { path: '/t/testtoken/1/inspect' },
      { path: '/t/testtoken/1/source' },
    ],
  });
  assert.match(answers[0].body, /<h1>Accessibility tree<\/h1>/);
  assert.match(answers[1].body, /<h1>Visible text<\/h1>/);
  assert.match(answers[2].body, /<h1>Accessibility with markup<\/h1>/);
  assert.match(answers[3].body, /<h1>Markup<\/h1>/);
  for (const answer of answers) {
    // Preformatted, so edbrowse leaves them alone.
    assert.match(answer.body, /<pre>/);
    assert.match(answer.body, /<a href="\.\/">the page<\/a>/);
  }
});

test('an address typed on a tab\'s page goes to that tab', { skip }, async () => {
  // Opening a new tab for every address is what put Back out of step with
  // submit: the reader would fill a form, be answered in the tab they were
  // reading, then type an address and be somewhere else entirely.
  const { answers, browser: asked } = await compare('an address typed on a tab', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/open', method: 'POST', body: { url: 'example.com', go: 'Go' } },
    ],
  });
  assert.equal(answers[0].status, 302);
  assert.match(String(answers[0].location), /\/t\/testtoken\/1\/$/);
  assert.deepEqual(asked[0].gotos, ['https://example.com']);
  assert.equal(asked.length, 1, 'a second tab was opened for an address typed on the first');
});

test('an address typed on a page of our own opens a tab of its own', { skip }, async () => {
  const { answers, browser: asked } = await compare('an address with no tab to stay in', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/open', method: 'POST', body: { url: 'example.com', go: 'Go' } },
    ],
  });
  assert.equal(answers[0].status, 302);
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1].gotos, ['https://example.com']);
});

test('something that is not an address is offered rather than searched for', { skip }, async () => {
  const { answers } = await compare('words that are not an address', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/open', method: 'POST', body: { url: 'two words here', go: 'Go' } },
      { path: '/t/testtoken/open', method: 'POST', body: { url: '', go: 'Go' } },
    ],
  });
  // A page is a place a reader can leave and come back to, and a redirect they
  // did not ask for is one they cannot undo.
  assert.equal(answers[0].status, 200);
  assert.match(answers[0].body, /is not a url/);
  assert.match(answers[0].body, /search the web for it/);
  assert.equal(answers[1].status, 400);
});

test('a submit fills the live fields in, then presses as a person would', { skip }, async () => {
  const { answers, browser: asked } = await compare('a form being submitted', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/' },
      {
        path: '/t/testtoken/1/submit/e3',
        method: 'POST',
        body: { e4: 'cats', e5: 'Go' },
      },
    ],
  });
  assert.equal(answers[1].status, 302);
  // The reader filled the form in edbrowse, so the values live there, not in
  // the page: they are put into the live elements first, so the site's own
  // input and change handlers run exactly as they would have.
  assert.deepEqual(asked[0].document.applied, [
    { path: '/input[0]', tag: 'input', value: 'cats' },
  ]);
  // And only then is the button pressed — as a person presses it, because a
  // submit is exactly where sites ask whether a person is present.
  assert.equal(asked[0].document.activated.length, 1);
  assert.equal(asked[0].document.activated[0].real, true);
});

test('a form with nothing to press is answered by typing Enter', { skip }, async () => {
  const { answers, browser: asked } = await compare('a loose field', {
    browser: browser({
      tabs: [{
        url: 'https://example.com/search',
        tokens: [
          {
            kind: 'field', tag: 'input', type: 'text',
            desc: desc('/input[0]', 'input'), label: 'Search', value: '',
          },
        ],
      }],
    }),
    requests: [
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/submit/e1', method: 'POST', body: { e1: 'cats', enter: 'Enter' } },
    ],
  });
  assert.equal(answers[1].status, 302);
  assert.deepEqual(asked[0].document.applied, [
    { path: '/input[0]', tag: 'input', value: 'cats' },
  ]);
  // Nothing to press: the page submits in script and expects Enter, which is
  // what a person would do in a search box.
  assert.equal(asked[0].document.activated.length, 0);
  assert.equal(asked[0].document.entered.length, 1);
});

test('a press the browser refuses is explained, not hidden', { skip }, async () => {
  const { answers } = await compare('a refused press', {
    browser: browser({
      tabs: [{
        url: 'https://example.com/challenge',
        activateRefuses: true,
        tokens: [{
          kind: 'link', desc: desc('/div[0]', 'div', 'Verify'), name: 'Verify',
          navigational: false, pierced: true,
        }],
      }],
    }),
    requests: [
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/e1/click' },
    ],
  });
  assert.equal(answers[1].status, 200);
  assert.match(answers[1].body, /a real click cannot reach it/);
  assert.match(answers[1].body, /back to the page/);
});

test('an id from an older render is called stale rather than acted on', { skip }, async () => {
  const { answers } = await compare('a stale id', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/e999' },
      { path: '/t/testtoken/1/f999' },
      { path: '/t/testtoken/1/submit/e999', method: 'POST', body: { e1: 'x' } },
    ],
  });
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.match(answer.body, /older version of this page|Type rf/);
  }
});

test('a tab that is not open offers the page it held', { skip }, async () => {
  const { answers } = await compare('a tab that is gone', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/9/' },
      { path: '/t/testtoken/nine/' },
    ],
  });
  assert.equal(answers[0].status, 200);
  assert.match(answers[0].body, /not open any more/);
  assert.match(answers[0].body, /the tabs/);
  assert.equal(answers[1].status, 404);
});

test('closing a tab answers the tab list', { skip }, async () => {
  const { answers, browser: asked } = await compare('closing a tab', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/close' },
    ],
  });
  assert.equal(answers[1].status, 302);
  assert.match(String(answers[1].location), /\/t\/testtoken\/tabs$/);
  assert.equal(asked[0].closed, true);
});

test('a frame can be read as a page of its own', { skip }, async () => {
  const { answers } = await compare('a frame on its own page', {
    browser: browser(),
    requests: [
      { path: '/t/testtoken/1/' },
      { path: '/t/testtoken/1/f1' },
    ],
  });
  assert.equal(answers[1].status, 200);
  assert.match(answers[1].body, /inside the frame/);
  // Everything on this page belongs to that frame, so every control is pressed
  // rather than followed.
  assert.match(answers[1].body, /\/click">Verify<\/a>/);
});

test('a document that cannot be read does not take the page with it', { skip }, async () => {
  const { answers } = await compare('an unreadable frame', {
    browser: browser({
      tabs: [{
        url: 'https://example.com/one',
        tokens: PAGE_TOKENS,
        frames: [{ url: 'https://example.com/frame', unread: true, tokens: [] }],
      }],
    }),
    requests: [{ path: '/t/testtoken/1/' }],
  });
  assert.equal(answers[0].status, 200);
  assert.match(answers[0].body, /hello/);
  // The line naming the frame is still in the buffer; the reader can follow it.
  assert.match(answers[0].body, /\[frame: comments\]/);
});

test('a browser that has closed is said to have closed', { skip }, async () => {
  const { answers } = await compare('a browser that went away', {
    browser: browser({ alive: false }),
    requests: [{ path: '/t/testtoken/tabs' }],
  });
  assert.equal(answers[0].status, 500);
  // The sentence a person would say, not "Target page, context or browser has
  // been closed".
  assert.match(answers[0].body, /the browser/);
});
