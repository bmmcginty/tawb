'use strict';

// The http contract the edbrowse server keeps, and the browser contract it
// depends on.
//
// No browser here. The stub below is the interesting half: it is the complete
// list of what this server asks of a page, written down as something that has
// to keep working rather than as prose that can quietly go out of date.
//
// Two of these matter more than the rest, and both exist because edbrowse
// behaves in ways a page cannot see. Anything that acts on the page answers a
// redirect back to the tab's own url, so the buffer never holds an address
// that would act a second time when the reader types rf. And every response
// says no-cache, because edbrowse caches, and rf would otherwise hand back
// the render before last.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { tempDir } = require('./tmpdir');

const state = tempDir('tweb-edb-routes-state-');
process.env.XDG_DATA_HOME = state;

const { startEdbServer } = require('../src/edb_server');

// --- what a page has to be able to do -------------------------------------

function stubPage(url, tokens) {
  const frame = {
    url: () => url,
    // Every extractor this server runs is a named function evaluated in the
    // page, so the stub can answer each by name. This list is the contract:
    // anything else the server starts evaluating will arrive here as an
    // unknown name and fail loudly rather than quietly returning nothing.
    evaluate: async (fn) => {
      switch (fn && fn.name) {
        case 'extractForEdbrowse':
          return { url, title: 'stub', tokens };
        case 'resolveDescriptor':
          // Found it, by following the path we recorded.
          return { how: 'path' };
        case 'applyFieldValues':
          return { applied: 1, missed: [] };
        case '':
        case undefined:
          return null;                       // an inline arrow; nothing wanted
        default:
          throw new Error(`the stub page was asked to run ${fn.name}, which it does not know about`);
      }
    },
    // Whatever resolveDescriptor left behind, ready to be clicked.
    evaluateHandle: async () => ({
      evaluate: async () => ({ ok: true, x: 1, y: 1, placed: 'center' }),
    }),
    $$: async () => [],
    childFrames: async () => [],
  };
  frame.page = () => page;
  const page = {
    url: () => url,
    gotos: [],
    title: async () => 'stub page',
    isClosed: () => false,
    mainFrame: () => frame,
    frames: () => [frame],
    evaluate: frame.evaluate,
    evaluateHandle: frame.evaluateHandle,
    goto: async (to) => { page.gotos.push(to); },
    // A form with nothing to press is submitted by typing Enter into the
    // field, through the browser's own keyboard.
    keyboard: { press: async () => {} },
    waitForLoadState: async () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    context: () => ({}),
  };
  return page;
}

function stubDriver(pages, auth = {}) {
  return {
    name: 'stub',
    alive: () => true,
    listTabs: () => pages,
    newTab: async () => { const p = stubPage('about:blank', []); pages.push(p); return p; },
    targetIdFor: async () => null,
    realClick: async () => {},
    close: async () => {},
    // The browser hands its password prompts over; the server decides what
    // becomes of them.
    attachAuth: async (handler) => { auth.answer = handler; return true; },
    armAuth: async (page) => { (auth.armed = auth.armed || []).push(page); return true; },
  };
}

async function get(base, path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function post(base, path, fields) {
  const res = await fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function withServer(tokens, run) {
  const pages = [stubPage('https://example.com/one', tokens)];
  const auth = {};
  const server = await startEdbServer({ driver: stubDriver(pages, auth), port: 0, token: 'testtoken' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run({
      base, pages, server, auth,
    });
  } finally {
    await server.close?.();
  }
}

const SOME_TOKENS = [
  { kind: 'text', text: 'hello' },
  { kind: 'link', desc: { tag: 'a', path: '/a[0]', name: 'Next' }, name: 'Next', navigational: true },
];

// --- the contract ---------------------------------------------------------

test('a request without the right token is not served', async () => {
  await withServer(SOME_TOKENS, async ({ base }) => {
    const wrong = await get(base, '/t/nottoken/tabs');
    assert.equal(wrong.status, 404);
    const none = await get(base, '/');
    assert.equal(none.status, 404);
  });
});

test('the tab list names every open tab', async () => {
  await withServer(SOME_TOKENS, async ({ base }) => {
    const res = await get(base, '/t/testtoken/tabs');
    assert.equal(res.status, 200);
    // Named by title where it has one, since that is what a reader recognises.
    assert.match(res.body, /stub page/);
    assert.match(res.body, /<a href="1\/">/);
  });
});

test('a tab renders as the page it holds, without being listed first', async () => {
  // The address this program prints when it starts goes straight to a tab.
  await withServer(SOME_TOKENS, async ({ base }) => {
    const res = await get(base, '/t/testtoken/1/');
    assert.equal(res.status, 200);
    assert.match(res.body, /hello/);
    assert.match(res.body, /<a href="e1">Next<\/a>/);
  });
});

test('every response forbids caching', async () => {
  // edbrowse caches, and rf would otherwise hand back the render before last.
  await withServer(SOME_TOKENS, async ({ base }) => {
    for (const path of ['/t/testtoken/tabs', '/t/testtoken/1/']) {
      const res = await get(base, path);
      assert.match(String(res.headers.get('cache-control')), /no-cache|no-store/);
    }
  });
});

test('acting on the page answers a redirect, never a page', async () => {
  // So the buffer never holds an address that would act a second time when
  // the reader types rf.
  await withServer(SOME_TOKENS, async ({ base }) => {
    // Ids exist because a render handed them out, so render first — which is
    // what edbrowse does before it can follow anything.
    await get(base, '/t/testtoken/1/');
    const res = await get(base, '/t/testtoken/1/e1');
    assert.equal(res.status, 302);
    assert.match(String(res.headers.get('location')), /\/t\/testtoken\/1\//);
  });
});

test('every page offers back, and back answers a redirect to the tab', async () => {
  // A link rather than a second submit button: edbrowse numbers fields
  // within a line, and the address bar's i* must stay i*.
  await withServer(SOME_TOKENS, async ({ base }) => {
    const page = await get(base, '/t/testtoken/1/');
    assert.match(page.body, /<a href="back">Back<\/a>/);
    const view = await get(base, '/t/testtoken/1/ax');
    assert.match(view.body, /<a href="back">Back<\/a>/);

    const res = await get(base, '/t/testtoken/1/back');
    assert.equal(res.status, 302);
    assert.match(String(res.headers.get('location')), /\/t\/testtoken\/1\/$/);
  });
});

test('the address bar holds the address of the page being read', async () => {
  // edbrowse's own fu names the loopback address this server answers on, so
  // this field is the only place the reader can see where they are.
  await withServer(SOME_TOKENS, async ({ base }) => {
    const page = await get(base, '/t/testtoken/1/');
    assert.match(page.body, /<input name="url" value="https:\/\/example\.com\/one">/);
    const view = await get(base, '/t/testtoken/1/render');
    assert.match(view.body, /<input name="url" value="https:\/\/example\.com\/one">/);
  });
});

test('an address typed on a page stays in that tab', async () => {
  // Opening a new tab for every address is what put back out of step with
  // submit: one acted where the reader was, the other did not.
  await withServer(SOME_TOKENS, async ({ base, pages }) => {
    const page = await get(base, '/t/testtoken/1/');
    assert.match(page.body, /<form action="open" method="post">/);

    const before = pages.length;
    const res = await get(base, '/t/testtoken/1/open?url=example.org');
    assert.equal(res.status, 302);
    assert.match(String(res.headers.get('location')), /\/t\/testtoken\/1\/$/);
    assert.equal(pages.length, before, 'it should not have opened another tab');
  });
});

test('an address with no tab to stay in opens one', async () => {
  // The plugin's way in, and the pages tweb writes itself.
  await withServer(SOME_TOKENS, async ({ base, pages }) => {
    const before = pages.length;
    const res = await get(base, '/t/testtoken/open?url=example.org');
    assert.equal(res.status, 302);
    assert.equal(pages.length, before + 1);
  });
});

// A page holding one frame, so the walk has somewhere to go. `$$` answers
// with a handle whose contentFrame is the child, which is how frames are
// found in document order; childFrames is what the browser itself reports,
// and is how a frame inside a closed shadow root would be found.
function stubPageWithFrame(url, tokens, childUrl, childTokens) {
  const page = stubPage(url, tokens);
  const child = stubPage(childUrl, childTokens).mainFrame();
  const main = page.mainFrame();
  main.$$ = async () => [{
    contentFrame: async () => child,
    dispose: async () => {},
  }];
  main.childFrames = async () => [child];
  child.$$ = async () => [];
  child.childFrames = async () => [];
  return page;
}

test("a frame's contents are read into the page, where the frame sits", async () => {
  // Until this, a frame was a line to follow. A bot check, an embedded
  // player and a comment thread are all frames, and none are optional.
  const tokens = [
    { kind: 'text', text: 'above' },
    { kind: 'frame', desc: { tag: 'iframe', path: '/iframe[0]', name: 'challenge' }, name: 'challenge' },
    { kind: 'text', text: 'below' },
  ];
  const inside = [
    { kind: 'field', desc: { tag: 'input', path: '/input[0]', name: 'cf' },
      tag: 'input', type: 'checkbox', label: 'Verify you are human', checked: false },
  ];
  const pages = [stubPageWithFrame('https://example.com/one', tokens, 'https://challenge.example/', inside)];
  const server = await startEdbServer({ driver: stubDriver(pages), port: 0, token: 'testtoken' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const res = await get(base, '/t/testtoken/1/');
    assert.equal(res.status, 200);
    assert.match(res.body, /Verify you are human/);
    // In reading order: the frame's line, then what is inside it, then the
    // rest of the page.
    const frameLine = res.body.indexOf('[frame: challenge]');
    const checkbox = res.body.indexOf('Verify you are human');
    const below = res.body.indexOf('below');
    assert.ok(frameLine > -1 && frameLine < checkbox, 'the frame line comes first');
    assert.ok(checkbox < below, 'the frame reads before the rest of the page');
    // The link to the frame on its own page survives, for the frames the
    // walk does not reach.
    assert.match(res.body, /<a href="f\d+">\[frame: challenge\]<\/a>/);

    // And the checkbox is recorded as living in the frame, not in the page
    // around it: submitting it is accepted rather than refused as an id
    // whose path names nothing in the tab's own document.
    const action = /<form action="(submit\/e\d+)" method="post">/.exec(res.body);
    assert.ok(action, 'the frame field should have a form of its own');
    const posted = await fetch(`${base}/t/testtoken/1/${action[1]}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'enter=Enter',
    });
    assert.equal(posted.status, 302, await posted.text());
  } finally {
    await server.close?.();
  }
});

test('a tab that is not there says so, and offers a way on', async () => {
  await withServer(SOME_TOKENS, async ({ base }) => {
    const res = await get(base, '/t/testtoken/99/');
    assert.equal(res.status, 200);
    assert.match(res.body, /not open any more|gone/i);
    assert.match(res.body, /\/t\/testtoken\/tabs/);
  });
});

test('an id from an older render is refused rather than guessed at', async () => {
  await withServer(SOME_TOKENS, async ({ base }) => {
    await get(base, '/t/testtoken/1/');
    const res = await get(base, '/t/testtoken/1/e9999');
    assert.match(res.body, /older version|stale|rf/i);
  });
});

// --- passwords -------------------------------------------------------------

const CHALLENGE = {
  source: 'Server', origin: 'https://example.com', realm: 'Staff area', scheme: 'basic',
  url: 'https://example.com/one',
};

test('a challenge nobody can answer becomes a form in the tab that raised it', async () => {
  await withServer(SOME_TOKENS, async ({ base, pages, auth }) => {
    // The reader is waiting on the response to the request that raised this,
    // so it is cancelled rather than held open — which loads the server's own
    // 401 body — and the tab remembers what was asked.
    assert.equal(await auth.answer(CHALLENGE, 'req-1', pages[0]), null);

    const form = await get(base, '/t/testtoken/1/');
    assert.equal(form.status, 200);
    assert.match(form.body, /example\.com/);
    assert.match(form.body, /Staff area/);
    assert.match(form.body, /<form method="post" action="1\/auth">/);
    assert.match(form.body, /<input type="password" name="password">/);
    assert.doesNotMatch(form.body, /hello/, 'the page stood behind the question');

    // The password reaches the server in a body, never in an address: the
    // buffer's own filename would otherwise hold it.
    const answered = await post(base, '/t/testtoken/1/auth', { user: 'reader', password: 'opensesame' });
    assert.equal(answered.status, 302);
    assert.equal(answered.headers.get('location'), '/t/testtoken/1/');
    assert.deepEqual(pages[0].gotos, ['https://example.com/one'], 'the page was fetched again');

    // And the next challenge for that realm is answered without anybody
    // being asked anything.
    assert.deepEqual(
      await auth.answer(CHALLENGE, 'req-2', pages[0]),
      { username: 'reader', password: 'opensesame' },
    );
    const page = await get(base, '/t/testtoken/1/');
    assert.match(page.body, /hello/);
  });
});

test('the page the server sent instead can be read without answering', async () => {
  await withServer(SOME_TOKENS, async ({ base, pages, auth }) => {
    await auth.answer(CHALLENGE, 'req-1', pages[0]);
    const shown = await get(base, '/t/testtoken/1/?show=1');
    assert.match(shown.body, /hello/);
    // Asked once, and then out of the way.
    const again = await get(base, '/t/testtoken/1/');
    assert.match(again.body, /hello/);
  });
});

test('a tab is armed for passwords as it is served', async () => {
  await withServer(SOME_TOKENS, async ({ base, pages, auth }) => {
    await get(base, '/t/testtoken/1/');
    assert.ok((auth.armed || []).includes(pages[0]));
  });
});
