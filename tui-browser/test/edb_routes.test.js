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
    title: async () => 'stub page',
    isClosed: () => false,
    mainFrame: () => frame,
    frames: () => [frame],
    evaluate: frame.evaluate,
    evaluateHandle: frame.evaluateHandle,
    goto: async () => {},
    waitForLoadState: async () => {},
    close: async () => {},
    setDefaultTimeout: () => {},
    setDefaultNavigationTimeout: () => {},
    context: () => ({}),
  };
  return page;
}

function stubDriver(pages) {
  return {
    name: 'stub',
    alive: () => true,
    listTabs: () => pages,
    newTab: async () => { const p = stubPage('about:blank', []); pages.push(p); return p; },
    targetIdFor: async () => null,
    realClick: async () => {},
    close: async () => {},
  };
}

async function get(base, path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

async function withServer(tokens, run) {
  const pages = [stubPage('https://example.com/one', tokens)];
  const server = await startEdbServer({ driver: stubDriver(pages), port: 0, token: 'testtoken' });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await run({ base, pages, server });
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
