'use strict';

const cdp = require('./cdp');
const { CdpPage, asFunctionDeclaration } = require('./cdp_page');

// Getting from a debugging port to a list of tabs, and keeping that list
// right while the reader uses the browser.
//
// The browser is auto-attached to in flat mode for page targets, which means
// every tab it has — and every one it opens from now on — arrives as a session
// on the one socket.
//
// Out-of-process iframes are discovered and explicitly attached instead of
// recursively auto-attached from their page. Chromium's recursive
// Target.setAutoAttach does more than its target filter says: it asks Blink to
// report every child worker before filtering the resulting targets. That
// changes worker startup in a way Cloudflare detects even when workers are
// excluded and never attached. Browser-level discovery has no renderer-side
// effect, and the explicit iframe session goes through the same wiring below.

const NEW_TAB_TIMEOUT_MS = 10000;

async function enableSession(session) {
  // Order matters: the listeners are already on, and enabling replays the
  // state that existed before we were listening — every execution context,
  // every frame. Enabling first would lose that replay.
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
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
    browserContext.attachDiscoveredFrames().catch(() => {});
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

  await enableSession(session);

  // Anything the context is meant to install in every document. Applied per
  // session because an out-of-process iframe is a separate target and would
  // not otherwise get it.
  for (const source of browserContext.initScripts) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {});
  }

  const tree = await session.send('Page.getFrameTree').catch(() => null);
  if (!tree) {
    await session.send('Runtime.runIfWaitingForDebugger');
    return;
  }

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
  // Discovery and Page.frameAttached are independent event streams. Whichever
  // one arrived second now has enough information to attach this frame. Do not
  // await here: an iframe's own attachment is still the promise recorded by
  // attachDiscoveredFrames, and waiting on that promise from inside itself
  // would deadlock.
  browserContext.attachDiscoveredFrames().catch(() => {});

  if (root) await seedLoadState(page);

  // Top-level pages still arrive paused from the browser's auto-attacher. An
  // explicitly attached iframe was never paused, so this is harmless there.
  await session.send('Runtime.runIfWaitingForDebugger');
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
    // A page target can have more than one CDP session. The auto-attached
    // session below owns the page; callers such as Fetch authentication may
    // attach an independent session to the same target. Playwright keys pages
    // by target id for exactly this reason: treating each session as a page
    // turns one tab into another "new page" every time a caller attaches.
    this.pagesByTarget = new Map();
    this.pagesBySession = new Map();
    this.initScripts = [];
    this.newPageHandlers = [];
    // Browser-level discovery reports OOPIF targets without touching the
    // renderer that created them. Target ids are frame ids, and parentFrameId
    // assigns each one to a page without guessing from its URL.
    this.discoveredFrames = new Map();
    this.frameAttachments = new Map();
    // Tabs this reader opened for itself — the WebUI page one of the browser's
    // own lists is read from. They are not the reader's tabs: they are not in
    // the tab list, they are not announced as having opened, and they are
    // closed as soon as the answer is in hand. See newInternalPage().
    this.internalTargets = new Set();
  }

  // Only tabs that have finished being wired up. A tab is announced by the
  // browser before its frame tree and execution contexts have been asked for,
  // and a page handed out in that moment answers wrongly about its own main
  // frame — which is a navigation to a frame id that is not there yet.
  pages() {
    return [...this.pagesByTarget.values()].filter(
      (page) => page.wired && !page.isClosed() && !this.internalTargets.has(page.targetId));
  }

  on(event, handler) {
    if (event !== 'page') throw new Error(`the Chromium driver does not report "${event}"`);
    this.newPageHandlers.push(handler);
    return this;
  }

  pageForTarget(targetId) {
    return this.pagesByTarget.get(targetId) || null;
  }

  pageForFrame(info) {
    for (const page of this.pagesByTarget.values()) {
      if (page.frameById(info.targetId)
        || (info.parentFrameId && page.frameById(info.parentFrameId))) return page;
    }
    return null;
  }

  discoverFrame(info) {
    if (!info || info.type !== 'iframe' || !info.targetId) return Promise.resolve();
    this.discoveredFrames.set(info.targetId, {
      ...(this.discoveredFrames.get(info.targetId) || {}), ...info,
    });
    return this.attachDiscoveredFrames();
  }

  forgetDiscoveredFrame(targetId) {
    this.discoveredFrames.delete(targetId);
  }

  // Attach every discovered OOPIF whose parent page is known. Discovery can
  // beat Page.frameAttached or vice versa, so both paths call this and an
  // unmatched target simply waits for the other event.
  async attachDiscoveredFrames() {
    const pending = [];
    for (const [targetId, info] of this.discoveredFrames) {
      const inFlight = this.frameAttachments.get(targetId);
      if (inFlight) {
        pending.push(inFlight);
        continue;
      }
      const page = this.pageForFrame(info);
      if (!page) continue;
      const known = page.frameById(targetId);
      if (known && known.ownTarget()) {
        this.discoveredFrames.delete(targetId);
        continue;
      }
      page.ensureFrame(targetId, info.parentFrameId || null);
      const attaching = this.connection.attach(targetId)
        .then((session) => wireSession(this, page, session, { root: false }))
        // A short-lived frame can disappear between discovery and attachment.
        // It contributed no document, so there is nothing stale to retain.
        .catch(() => {})
        .finally(() => {
          this.frameAttachments.delete(targetId);
          this.discoveredFrames.delete(targetId);
          // Attaching this frame may have supplied the parent of a nested one.
          this.attachDiscoveredFrames().catch(() => {});
        });
      this.frameAttachments.set(targetId, attaching);
      pending.push(attaching);
    }
    await Promise.all(pending);
  }

  dropFrameSession(sessionId) {
    for (const page of this.pagesByTarget.values()) {
      for (const session of page.sessions) {
        if (session.sessionId !== sessionId || session === page.session) continue;
        page.dropSession(session);
        return true;
      }
    }
    return false;
  }

  async adopt(sessionId, targetId) {
    const known = this.pagesByTarget.get(targetId);
    if (known) {
      await known.ready;
      return known;
    }
    const session = this.connection.sessionFor(sessionId, targetId);
    const page = new CdpPage(this, session, targetId);
    // Recorded before it is ready, so that a detach arriving mid-wiring finds
    // it, and so a second attachment to this target cannot make a second page.
    this.pagesByTarget.set(targetId, page);
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
    this.pagesByTarget.delete(page.targetId);
    page.markClosed();
    return page;
  }

  announce(page) {
    if (this.internalTargets.has(page.targetId)) return;
    for (const handler of [...this.newPageHandlers]) {
      try { handler(page); } catch { /* a handler must not break the session */ }
    }
  }

  async newPage() {
    return this.#createPage({});
  }

  // A tab of our own, for asking the browser something only one of its own
  // pages can answer.
  //
  // It is created in the background so the browser does not move to it, and
  // its target is marked before the tab is waited for — which is soon enough,
  // because a tab is announced only once it has been wired up, and wiring it
  // costs several round trips after the response that names it. So the reader
  // is never told a tab opened, and never finds one in the list that was not
  // theirs.
  async newInternalPage() {
    return this.#createPage({ background: true, internal: true });
  }

  async #createPage({ background = false, internal = false }) {
    const { targetId } = await this.connection.browser.send('Target.createTarget', {
      url: 'about:blank',
      ...(background ? { background: true } : {}),
    });
    if (internal) this.internalTargets.add(targetId);
    const deadline = Date.now() + NEW_TAB_TIMEOUT_MS;
    for (;;) {
      // Every tab, wired or not, because this one is brand new by
      // construction and waiting for it is exactly what we are here to do.
      const found = this.pagesByTarget.get(targetId);
      if (found) {
        await found.ready;
        return found;
      }
      if (Date.now() >= deadline) throw new cdp.CdpError('the new tab never attached');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async closePage(page) {
    this.internalTargets.delete(page.targetId);
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
    connection.onClose(() => {
      for (const page of this.browserContext.pagesByTarget.values()) page.markClosed();
      this.browserContext.pagesByTarget.clear();
      this.browserContext.pagesBySession.clear();
    });
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
    // Explicit iframe attachment raises this event on the browser session too.
    // discoverFrame owns that session and wires it after attachToTarget replies.
    if (info.type === 'iframe') return;
    if (info.type !== 'page') {
      connection.sessionFor(params.sessionId, info.targetId).detach().catch(() => {});
      return;
    }
    // Target.attachToTarget also raises this event. It is another conversation
    // with an existing tab, not another tab. Playwright's page map is keyed by
    // target id, so mirror that distinction before scheduling an announcement.
    if (context.pageForTarget(info.targetId)) return;
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

  root.on('Target.detachedFromTarget', (params) => {
    if (!context.forget(params.sessionId)) context.dropFrameSession(params.sessionId);
  });
  root.on('Target.targetCreated', ({ targetInfo }) => {
    context.discoverFrame(targetInfo).catch(() => {});
  });
  root.on('Target.targetInfoChanged', ({ targetInfo }) => {
    context.discoverFrame(targetInfo).catch(() => {});
  });
  root.on('Target.targetDestroyed', ({ targetId }) => context.forgetDiscoveredFrame(targetId));

  await root.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    // Page targets are the tabs. Asking for everything would attach workers
    // and browser UI that this driver immediately discards.
    filter: [{ type: 'page' }],
  });

  // Auto-attach reports the targets that already exist, but it does so as
  // events rather than in the reply, so the tabs the browser had are whatever
  // arrived while that command was in flight. Waiting for them here is what
  // makes pages() answer correctly on the first call.
  await Promise.all(attached);
  settled = true;

  // Unlike recursive auto-attachment, discovery creates no renderer-side
  // worker plumbing. Existing iframe targets are announced while this command
  // is in flight; new ones arrive through the listeners above.
  await root.send('Target.setDiscoverTargets', {
    discover: true, filter: [{ type: 'iframe' }],
  });
  await context.attachDiscoveredFrames();

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
