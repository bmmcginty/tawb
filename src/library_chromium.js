'use strict';

const { orderEntries } = require('./library');

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
//   downloads   the page's Mojo handler — getDownloads() on the browser proxy
//               the <downloads-manager> element holds. That is the interface
//               the browser implements for this page; the page is only how we
//               reach it.
//   history     the query result that same machinery has already produced,
//               read off <history-list>. The history page keeps its handler in
//               a module of its own where nothing can reach it, so this is the
//               one of the three where we read the page's model rather than
//               calling the browser. It is still the browser's structured
//               answer — url, title, visit time — and not scraped text.
//
// A tab used for this is internal: it is created in the background, kept out
// of the tab list, never announced as a new tab, and closed when the answer is
// in hand.

const PAGES = {
  bookmarks: 'chrome://bookmarks/',
  history: 'chrome://history/',
  downloads: 'chrome://downloads/',
};

// The element each page builds itself around. A WebUI page's own elements are
// defined by a module it fetches after the document exists, so the document
// being there is not the page being there.
const ELEMENTS = {
  bookmarks: 'bookmarks-app',
  history: 'history-app',
  downloads: 'downloads-manager',
};

// How long to wait for a WebUI page to have its answer ready.
const READY_TIMEOUT_MS = 8000;
const POLL_MS = 100;

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

// The history page runs its query as it loads. Wait for the answer rather than
// for a fixed time: an empty history and a history that has not arrived yet
// look identical, and only one of them is worth reporting.
function readHistory(deadline) {
  const list = () => {
    const app = document.querySelector('history-app');
    const root = app && app.shadowRoot;
    return root ? root.querySelector('history-list') : null;
  };
  return new Promise((resolve) => {
    const tick = () => {
      const found = list();
      const data = found && found.historyData_;
      if (Array.isArray(data) && (data.length || Date.now() > deadline)) {
        resolve(data.map((entry) => ({
          title: String(entry.title || ''),
          url: String(entry.url || ''),
          when: Number(entry.time) || null,
        })));
        return;
      }
      if (Date.now() > deadline) { resolve([]); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Downloads come back through the page rather than from the call: getDownloads
// tells the browser to send them, and they arrive on the element. The states
// are the browser's own enum, and where it has written a line of its own about
// one — "Failed - Network error", a paused download's progress — that is
// preferred, because it is in the reader's language and ours is not.
function readDownloads(deadline) {
  const STATES = {
    0: 'in progress', 1: 'cancelled', 2: 'complete', 3: 'paused',
    4: 'dangerous', 5: 'interrupted', 6: 'insecure',
  };
  const manager = document.querySelector('downloads-manager');
  if (!manager || !manager.browserProxy_) return Promise.resolve([]);
  return Promise.resolve(manager.browserProxy_.handler.getDownloads([])).then(() => new Promise((resolve) => {
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

// ---------------------------------------------------------------------------

// Opens the page that owns `kind`, asks it, and closes it again.
async function readChromiumLibrary(context, kind, { timeout = READY_TIMEOUT_MS } = {}) {
  const url = PAGES[kind];
  if (!url) throw new Error(`Unknown list "${kind}".`);

  const page = await context.newInternalPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (name) => !!document.querySelector(name),
      ELEMENTS[kind],
      { timeout, polling: POLL_MS },
    );
    const entries = await page.evaluate(READERS[kind], Date.now() + timeout);
    return orderEntries(kind, entries);
  } finally {
    await context.closePage(page).catch(() => { /* the answer is already in hand */ });
  }
}

module.exports = { readChromiumLibrary, PAGES };
