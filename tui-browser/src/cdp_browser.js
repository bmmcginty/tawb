'use strict';

const cdp = require('./cdp');
const { CdpPage, asFunctionDeclaration } = require('./cdp_page');

// Getting from a debugging port to a list of tabs, and keeping that list
// right while the reader uses the browser.
//
// The browser is auto-attached to in flat mode, which means every target it
// has — and every one it opens from now on — arrives as a session on the one
// socket. Filtering those to `type: 'page'` is what "a tab" means here;
// workers, extension backgrounds and the browser's own DevTools windows are
// targets too and are left alone.
//
// Each tab is then auto-attached to in turn, which is how out-of-process
// iframes are reached: a cross-origin frame in Chrome is a target of its own,
// and without this it would be a document nothing could evaluate in. That is
// the piece of Playwright's Chromium support that actually mattered.

const NEW_TAB_TIMEOUT_MS = 10000;

async function enableSession(session) {
  // Order matters: the listeners are already on, and enabling replays the
  // state that existed before we were listening — every execution context,
  // every frame. Enabling first would lose that replay.
  await session.send('Page.enable').catch(() => {});
  await session.send('Runtime.enable').catch(() => {});
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
  // Cross-origin iframes below this document, each its own target. Nothing is
  // paused on start: a browser this program is reading must go on behaving
  // like a browser somebody is using.
  await session.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  }).catch(() => {});
}

// Wire one session into a page: its documents, its execution contexts, and
// the iframe targets hanging off it. Called for the tab's own session and
// again for every out-of-process iframe found under it.
async function wireSession(browserContext, page, session, { root }) {
  page.sessions.add(session);

  session.on('Runtime.executionContextCreated', ({ context }) => page.noteContext(session, context));
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    page.forgetContextById(session, executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => page.forgetContextsOf(session));

  session.on('Page.frameAttached', ({ frameId, parentFrameId }) => {
    page.ensureFrame(frameId, parentFrameId || null);
  });
  session.on('Page.frameNavigated', ({ frame }) => {
    const known = page.ensureFrame(frame.id, frame.parentId || null);
    known._url = frame.url || 'about:blank';
    // A new document has committed here, so every frame that hung below this
    // one belonged to the document being replaced. Chrome announces the new
    // document's children afterwards; it never announces that the old ones
    // have gone.
    page.dropChildrenOf(frame.id);
    page.emit('framenavigated', known);
  });
  session.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
    const known = page.ensureFrame(frameId);
    if (url) known._url = url;
    page.emit('framenavigated', known);
  });
  session.on('Page.frameDetached', ({ frameId, reason }) => {
    // A frame going cross-process is detached from the session it was on and
    // reattached to a target of its own. That is a change of address, not a
    // document going away, and forgetting it here would lose the frame in
    // the gap before the new target attaches.
    if (reason === 'swap') return;
    page.removeFrame(frameId);
  });

  if (root) {
    session.on('Page.lifecycleEvent', ({ frameId, name }) => {
      if (frameId !== page.mainFrameId) return;
      // A new document starts the count again; anything else it reaches is
      // something waitForLoadState can stop waiting for.
      if (name === 'init') page.reached.clear();
      else page.reached.add(name);
    });
  }

  session.on('Target.attachedToTarget', (params) => {
    const info = params.targetInfo || {};
    if (info.type !== 'iframe') return;
    const child = session.connection.sessionFor(params.sessionId, info.targetId);
    wireSession(browserContext, page, child, { root: false })
      .catch(() => { /* the frame went away while we were attaching to it */ });
  });

  // In flat mode a sub-target's detachment is announced to its parent. This
  // is the only word we get that a cross-origin iframe's process has gone,
  // and without it the document it was answering for stays in the frame list
  // for ever, unreadable.
  session.on('Target.detachedFromTarget', ({ sessionId }) => {
    for (const wired of page.sessions) {
      if (wired.sessionId === sessionId) {
        page.dropSession(wired);
        return;
      }
    }
  });

  await enableSession(session);

  // Anything the context is meant to install in every document. Applied per
  // session because an out-of-process iframe is a separate target and would
  // not otherwise get it.
  for (const source of browserContext.initScripts) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {});
  }

  const tree = await session.send('Page.getFrameTree').catch(() => null);
  if (!tree) return;

  const record = (node, ownedBy) => {
    const frame = page.ensureFrame(node.frame.id, node.frame.parentId || null);
    frame._url = node.frame.url || 'about:blank';
    if (ownedBy) frame._ownSession = ownedBy;
    for (const child of node.childFrames || []) record(child, null);
  };

  if (root) page.mainFrameId = tree.frameTree.frame.id;
  // Only the root of this target claims the session. Its own child documents
  // are same-process and answered by it, which walking up the parent chain
  // works out on its own.
  record(tree.frameTree, root ? null : session);

  if (root) await seedLoadState(page);
}

// What the document has already reached, asked once when the tab is attached
// to.
//
// Lifecycle events only report what happens from now on, and a tab is very
// often finished loading long before a reader arrives at it. Without this,
// waitForLoadState would wait out its whole timeout for a `load` that
// happened yesterday — and it is called on the same promise as every click,
// so that is not a slow path, it is every path.
//
// A document we cannot ask counts as arrived, because waiting for something
// we have no way of observing is worse than not waiting at all.
async function seedLoadState(page) {
  const ready = await page.mainFrame().evaluate(() => document.readyState).catch(() => null);
  if (ready === 'loading') return;
  page.reached.add('DOMContentLoaded');
  if (ready !== 'interactive') page.reached.add('load');
}

class CdpBrowserContext {
  constructor(browser) {
    this.browser = browser;
    this.connection = browser.connection;
    this.pagesBySession = new Map();
    this.initScripts = [];
    this.newPageHandlers = [];
  }

  // Only tabs that have finished being wired up. A tab is announced by the
  // browser before its frame tree and execution contexts have been asked for,
  // and a page handed out in that moment answers wrongly about its own main
  // frame — which is a navigation to a frame id that is not there yet.
  pages() {
    return [...this.pagesBySession.values()].filter((page) => page.wired && !page.isClosed());
  }

  on(event, handler) {
    if (event !== 'page') throw new Error(`the Chromium driver does not report "${event}"`);
    this.newPageHandlers.push(handler);
    return this;
  }

  async adopt(sessionId, targetId) {
    const known = this.pagesBySession.get(sessionId);
    if (known) {
      await known.ready;
      return known;
    }
    const session = this.connection.sessionFor(sessionId, targetId);
    const page = new CdpPage(this, session, targetId);
    // Recorded before it is ready, so that a detach arriving mid-wiring finds
    // it, and so two attachments for one session cannot make two pages.
    this.pagesBySession.set(sessionId, page);
    page.ready = wireSession(this, page, session, { root: true })
      .then(() => { page.wired = true; });
    await page.ready;
    return page;
  }

  forget(sessionId) {
    const page = this.pagesBySession.get(sessionId);
    if (!page) return null;
    this.pagesBySession.delete(sessionId);
    page.markClosed();
    return page;
  }

  announce(page) {
    for (const handler of [...this.newPageHandlers]) {
      try { handler(page); } catch { /* a handler must not break the session */ }
    }
  }

  async newPage() {
    const { targetId } = await this.connection.browser.send('Target.createTarget', {
      url: 'about:blank',
    });
    const deadline = Date.now() + NEW_TAB_TIMEOUT_MS;
    for (;;) {
      // Every tab, wired or not, because this one is brand new by
      // construction and waiting for it is exactly what we are here to do.
      const found = [...this.pagesBySession.values()]
        .find((page) => page.targetId === targetId);
      if (found) {
        await found.ready;
        return found;
      }
      if (Date.now() >= deadline) throw new cdp.CdpError('the new tab never attached');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async closePage(page) {
    await this.connection.browser
      .send('Target.closeTarget', { targetId: page.targetId })
      .catch(() => { /* already gone, which is what was wanted */ });
    // The detach event marks it closed; do not wait for it, because a tab
    // that has already gone will never send one.
    page.markClosed();
  }

  // Run this in every document, from now on, in every tab. Used to arm the
  // mutation observer before a page's own scripts run.
  async addInitScript(fn) {
    const source = typeof fn === 'function' ? `(${asFunctionDeclaration(fn)})()` : String(fn);
    this.initScripts.push(source);
    for (const page of this.pages()) {
      for (const session of page.sessions) {
        await session.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {});
      }
    }
  }

  // A second, independent session on the same target, for a caller that wants
  // to enable a domain and later detach without disturbing the tab's own
  // session. A frame is only separately addressable when it is a target of
  // its own — a cross-origin iframe — which is the same rule Playwright has.
  async newCDPSession(target) {
    if (target instanceof CdpPage) return this.connection.attach(target.targetId);
    if (target && typeof target.ownTarget === 'function' && target.ownTarget()) {
      return this.connection.attach(target.session().targetId);
    }
    throw new Error('that frame is not a target of its own');
  }
}

class CdpBrowser {
  constructor(connection) {
    this.connection = connection;
    this.browserContext = new CdpBrowserContext(this);
  }

  contexts() {
    return [this.browserContext];
  }

  isConnected() {
    return !this.connection.closed;
  }

  // Letting go of the browser, not closing it. The browser belongs to the
  // person using it; whether it is torn down afterwards is a decision the
  // driver makes with the process id, not something that should fall out of
  // hanging up a socket.
  async close() {
    this.connection.close();
  }
}

async function attachToBrowser(connection) {
  const browser = new CdpBrowser(connection);
  const context = browser.browserContext;
  const root = connection.browser;

  const attached = [];
  // Whether the browser as we found it has been taken stock of. Until it has,
  // an attaching tab is one that was already open rather than one that just
  // opened, and only the latter is news anybody wants.
  let settled = false;

  root.on('Target.attachedToTarget', (params) => {
    const info = params.targetInfo || {};
    if (info.type !== 'page') return;
    const ready = context.adopt(params.sessionId, info.targetId)
      .then((page) => {
        // Only a tab that opened after we were watching is news. The ones
        // that were already there are the browser as we found it.
        if (settled) context.announce(page);
        return page;
      })
      .catch(() => null);
    attached.push(ready);
  });

  root.on('Target.detachedFromTarget', (params) => context.forget(params.sessionId));

  await root.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
  });

  // Auto-attach reports the targets that already exist, but it does so as
  // events rather than in the reply, so the tabs the browser had are whatever
  // arrived while that command was in flight. Waiting for them here is what
  // makes pages() answer correctly on the first call.
  await Promise.all(attached);
  settled = true;

  return browser;
}

async function connect(endpoint, options = {}) {
  const connection = await cdp.connect(endpoint, options);
  try {
    return await attachToBrowser(connection);
  } catch (err) {
    connection.close();
    throw err;
  }
}

module.exports = { connect, attachToBrowser, CdpBrowser, CdpBrowserContext };
