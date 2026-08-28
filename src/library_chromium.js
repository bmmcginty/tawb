'use strict';

const { orderEntries, MAX_ENTRIES } = require('./library');

// Chromium's bookmarks, history and downloads, asked for the way the browser's
// own pages ask.
//
// Neither CDP nor anything else in the protocol answers for these: the
// DevTools protocol describes documents, and a browser's record of where you
// have been is not a document. What does answer is the browser's own UI —
// chrome://bookmarks, chrome://history, chrome://downloads — and those are
// ordinary tabs that CDP can attach to and run script in. So a tab is opened
// on the page that owns each list, the page's own API is called, and the tab
// is closed again.
//
// The three are not equally well served, and it is worth being precise about
// which is which:
//
//   bookmarks   chrome.bookmarks.getTree(), the real extension API. That WebUI
//               is granted it, so this is the same call an extension makes and
//               the same one the page itself uses. Folder titles arrive
//               already in the browser's own words.
//   history     queryHistory() on the Mojo handler, reached through the
//               BrowserProxy the history page's own module exports. It answers
//               with the results, takes the number wanted, and says whether
//               there are more.
//   downloads   getDownloads() on the same kind of handler, from the downloads
//               page's module. This one answers into the page rather than to
//               the caller, and only with what has changed since it last
//               spoke — so the list is read off the element that has been
//               accumulating it, which by then is every download there is.
//
// In each case the interface is the browser's, implemented in C++ for its own
// UI; the page is how we reach it, and its module is where the binding to that
// interface is published.
//
// A tab used for this is internal: it is created in the background, kept out
// of the tab list, never announced as a new tab, and closed when the answer is
// in hand.

const PAGES = {
  bookmarks: 'chrome://bookmarks/',
  history: 'chrome://history/',
  downloads: 'chrome://downloads/',
};

// How long to wait for a WebUI page to have its answer ready.
const READY_TIMEOUT_MS = 8000;
const POLL_MS = 100;

// What has to be there before a page can be asked. A WebUI page's own script is
// a module it fetches after the document exists, so the document being there is
// not the page being there. Only the downloads list waits on an element, since
// it is the element that accumulates the answer.
const READY = {
  bookmarks: () => !!(window.chrome && chrome.bookmarks),
  history: () => !!document.querySelector('history-app'),
  downloads: () => !!document.querySelector('downloads-manager'),
};

// ---------------------------------------------------------------------------
// What runs in the WebUI page
// ---------------------------------------------------------------------------

// Bookmarks are a tree; a reader wants a list, with the folder each one is
// filed in, because "Toolbar/News" is most of what tells two identically
// titled links apart.
function readBookmarks() {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      const out = [];
      const walk = (node, trail) => {
        if (!node) return;
        if (node.url) {
          out.push({
            title: String(node.title || ''),
            url: String(node.url),
            folder: trail.join('/'),
            when: Number(node.dateAdded) || null,
          });
          return;
        }
        // The unnamed root above the browser's own folders contributes no name.
        const here = node.title ? [...trail, String(node.title)] : trail;
        for (const child of node.children || []) walk(child, here);
      };
      for (const root of tree || []) walk(root, []);
      resolve(out);
    });
  });
}

// The history page publishes its browser proxy, so this is the query itself
// rather than the answer to somebody else's: it takes the number of entries
// wanted and hands them back.
function readHistory(max) {
  return import('chrome://history/history.js').then(({ BrowserProxyImpl }) => {
    const handler = BrowserProxyImpl.getInstance().handler;
    return handler.queryHistory('', max);
  }).then((answer) => {
    const results = (answer && answer.results && answer.results.value) || [];
    return results.map((entry) => ({
      title: String(entry.title || ''),
      url: String(entry.url || ''),
      when: Number(entry.time) || null,
    }));
  });
}

// Downloads answer into the page rather than to the caller, and only with what
// has changed since the handler last spoke — asking a second time reports an
// empty insert, because the page already has them. So the call is made through
// the page's own proxy and the answer is read off the element that has been
// accumulating it since the page loaded.
//
// The states are the browser's own enum, and where it has written a line of its
// own about one — "Failed - Network error", a paused download's progress —
// that is preferred, because it is in the reader's language and ours is not.
function readDownloads(deadline) {
  const STATES = {
    0: 'in progress', 1: 'cancelled', 2: 'complete', 3: 'paused',
    4: 'dangerous', 5: 'interrupted', 6: 'insecure',
  };
  const manager = document.querySelector('downloads-manager');
  if (!manager) return Promise.resolve([]);
  return import('chrome://downloads/downloads.js')
    .then(({ browserProxyFactory }) => browserProxyFactory.getInstance().handler.getDownloads([]))
    .then(() => new Promise((resolve) => {
    const tick = () => {
      const items = manager.items_;
      if (Array.isArray(items) && (items.length || Date.now() > deadline)) {
        resolve(items.map((item) => ({
          title: String(item.fileName || ''),
          file: String(item.filePath || ''),
          url: String(item.url || ''),
          state: String(item.progressStatusText || item.lastReasonText
            || STATES[Number(item.state)] || 'unknown'),
          bytes: Number(item.total) || 0,
          totalBytes: Number(item.total) || 0,
          // Seconds here, where every other date in this browser is
          // milliseconds.
          when: item.started ? Number(item.started) * 1000 : null,
        })));
        return;
      }
      if (Date.now() > deadline) { resolve([]); return; }
      setTimeout(tick, 100);
    };
    tick();
  }));
}

const READERS = { bookmarks: readBookmarks, history: readHistory, downloads: readDownloads };

// The one thing each reader has to be told, since a function sent into a page
// is sent with a single argument: how many entries are wanted, or how long to
// wait for them.
const ARGUMENTS = {
  bookmarks: () => null,
  history: ({ max }) => max,
  downloads: ({ timeout }) => Date.now() + timeout,
};

// ---------------------------------------------------------------------------

// Opens the page that owns `kind`, asks it, and closes it again.
async function readChromiumLibrary(context, kind, { timeout = READY_TIMEOUT_MS, max = MAX_ENTRIES } = {}) {
  const url = PAGES[kind];
  if (!url) throw new Error(`Unknown list "${kind}".`);

  const page = await context.newInternalPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(READY[kind], undefined, { timeout, polling: POLL_MS });
    const entries = await page.evaluate(READERS[kind], ARGUMENTS[kind]({ timeout, max }));
    return orderEntries(kind, entries);
  } finally {
    await context.closePage(page).catch(() => { /* the answer is already in hand */ });
  }
}

module.exports = { readChromiumLibrary, PAGES };
