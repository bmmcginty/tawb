'use strict';

const { launchOwnBrowser, connectToBrowser, defaultProfileDir } = require('./browser');
const { parseAriaSnapshot } = require('./aria');
const { extractAxItems } = require('./ax_own');
const { log } = require('./log');

// Chromium, attached to over the DevTools protocol.
//
// This is the path that works and is not to be disturbed: it clears bot
// checks because the browser is an ordinary one that happens to be observed.
//
// The accessibility tree is now ours, computed in the page by ax_own.js, the
// same as Firefox. It was Playwright's for as long as ours was unproven, and
// the two were held against each other on real pages until they agreed. Ours
// wins on two counts that are not matters of taste: its items carry a
// reference to the element they came from, so activating a line no longer
// means searching the page again for something with that role and that exact
// name — which is a round trip, and which silently finds the wrong control
// when a page repeats a name. And it reads aria-expanded as the three answers
// it has, where ariaSnapshot marks an open control and has no way to say that
// one is closed.
//
// Playwright's is kept reachable, as `--browser chromium-playwright`, because
// it is the oracle ours was measured against and there is no reason to lose
// that: `npm run compare -- --only chromium ...` against it is how a
// disagreement gets judged.

async function openChromium({
  connect = null, profile = null, keepBrowser = false, ax = 'own', log = () => {},
} = {}) {
  let browser;
  let context;
  let child = null;
  let owned = false;
  let port = null;
  let rejoined = false;

  if (connect) {
    const connected = await connectToBrowser(connect);
    ({ browser, context } = connected);
    port = connected.port;
    rejoined = true;
  } else {
    const started = await launchOwnBrowser({ profileDir: profile || defaultProfileDir(), log });
    ({ browser, context } = started);
    child = started.child;
    owned = !!started.owned;
    port = started.port;
    rejoined = !!started.rejoined;
  }

  const ownAx = ax !== 'playwright';

  // One DevTools session per frame, kept because opening one is a round trip
  // and this is asked for on every snapshot of a page that needs it.
  const sessions = new Map();
  const sessionFor = async (frame) => {
    if (sessions.has(frame)) return sessions.get(frame);
    let session = null;
    try {
      // A cross-origin frame is its own target and answers for its own
      // document; anything else is answered by the page's session.
      session = await context.newCDPSession(frame);
    } catch {
      try { session = await context.newCDPSession(frame.page ? frame.page() : frame); } catch { session = null; }
    }
    sessions.set(frame, session);
    return session;
  };

  // Find the closed shadow roots in a frame and hand each one to the page,
  // paired with the element hosting it.
  //
  // Page script cannot do this. A closed shadow root reports nothing through
  // node.shadowRoot — that is what closed means — so a walk built on the DOM
  // will never enter one however it is written. The protocol can see them,
  // and once the pair is in the page's own hands the ordinary walk carries on
  // into it, in the right place in reading order, registering the elements it
  // finds so they can be activated like anything else.
  //
  // What it leaves behind is one property on each host element, under a name
  // of ours. It cannot go stale in a way that matters: an element still has
  // the root it was given, and a new document has no such elements in it.
  const pierceClosedShadows = async (frame) => {
    const session = await sessionFor(frame);
    if (!session) return 0;

    let document;
    try {
      ({ root: document } = await session.send('DOM.getDocument', { depth: -1, pierce: true }));
    } catch {
      return 0;
    }

    // Only this frame's own roots. A session on the page answers for every
    // document in the process, and registering another frame's root into this
    // frame's map would be meaningless at best.
    const wanted = frame.url();
    const pairs = [];
    const collect = (node, docUrl) => {
      const here = node.nodeName === '#document' ? (node.documentURL || docUrl) : docUrl;
      for (const shadow of node.shadowRoots || []) {
        if (shadow.shadowRootType === 'closed' && here === wanted) {
          pairs.push({ host: node.nodeId, root: shadow.nodeId });
        }
        collect(shadow, here);
      }
      if (node.contentDocument) collect(node.contentDocument, node.contentDocument.documentURL);
      for (const child of node.children || []) collect(child, here);
    };
    collect(document, document.documentURL);
    if (!pairs.length) return 0;

    let registered = 0;
    for (const pair of pairs) {
      try {
        const host = await session.send('DOM.resolveNode', { nodeId: pair.host });
        const shadow = await session.send('DOM.resolveNode', { nodeId: pair.root });
        await session.send('Runtime.callFunctionOn', {
          objectId: host.object.objectId,
          functionDeclaration: 'function (root) { this.__twebShadowRoot = root; }',
          arguments: [{ objectId: shadow.object.objectId }],
        });
        registered += 1;
      } catch {
        // The node went away between listing it and resolving it.
      }
    }
    log('shadow.pierced', { roots: registered, url: String(wanted).slice(0, 100) });
    return registered;
  };

  return {
    name: ownAx ? 'chromium' : 'chromium-playwright',
    ax: ownAx ? 'own' : 'playwright',
    browser,
    context,
    child,
    owned,
    port,
    rejoined,

    // A tab's identity as the browser knows it — the only name for a tab that
    // means the same thing in another session's process.
    async targetIdFor(page) {
      try {
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        await session.detach().catch(() => {});
        return (targetInfo && targetInfo.targetId) || null;
      } catch {
        return null;
      }
    },

    // The accessibility tree, flattened into reading order. Ours, computed in
    // the page, in the same item shape the Playwright path produced — so
    // everything downstream (prose merging, separator folding, layout) is
    // untouched by which one computed it.
    async axItems(frame) {
      if (!ownAx) return parseAriaSnapshot(await frame.locator('body').ariaSnapshot());

      const items = await frame.evaluate(extractAxItems);
      if (items.length) return items;

      // A document that renders and says nothing is the signature of content
      // behind a closed shadow root, and it is the only case worth paying for
      // a piercing scan of the whole node tree. Measured: 4ms on a Turnstile
      // widget frame, but 146ms on a Wikipedia article and 329ms on Reddit —
      // neither of which has a single closed shadow root in it. Doing this
      // unconditionally would double the cost of every snapshot to serve a
      // handful of pages.
      if (!(await pierceClosedShadows(frame))) return items;
      return frame.evaluate(extractAxItems);
    },

    // Every tab the browser has, across all its windows. Order is creation
    // order rather than the order they sit in the tab strip, which is the
    // only ordering the protocol offers.
    listTabs() {
      return context.pages().filter((page) => !page.isClosed());
    },

    // A tab opening is how target="_blank" arrives, and the reader wants to
    // follow it the way a sighted user's browser already has.
    onNewTab(handler) {
      context.on('page', handler);
    },

    // Whether the browser is still there. A browser is the reader's to close,
    // and when they close it every page object in this process becomes a
    // handle to nothing — so whatever asks the browser for something has to
    // be able to ask this first, rather than finding out from a protocol
    // error that names no cause.
    alive() {
      try { return browser.isConnected(); } catch { return false; }
    },

    async newTab() {
      return context.newPage();
    },

    // A click the browser treats as a person's.
    //
    // Everything else here activates through the DOM's own default action,
    // which is right for reading: it needs no viewport and reaches controls
    // that are off-screen. What it cannot produce is user activation — the
    // browser knows nobody touched anything — so a page that gates on a real
    // gesture (audio, fullscreen, the clipboard, a popup) refuses.
    //
    // Playwright's click is real input over the DevTools protocol, dispatched
    // above content, so the events are trusted and carry activation. It also
    // brings the element into view and refuses to click one that something
    // else is covering, which is exactly the honesty wanted here: a click
    // that lands on a modal instead of the button is worse than no click.
    async realClick(scope, handle, { timeoutMs = 5000 } = {}) {
      await handle.click({ timeout: timeoutMs });
    },

    // A real click at a point inside a frame's own viewport, for a document
    // whose contents could not be read even after piercing. Dispatched on
    // that frame's own session, so the coordinates are its own.
    async clickInFrame(frame, x, y) {
      const session = await sessionFor(frame);
      if (!session) throw new Error('no session for that frame');
      const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
      await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
      await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    },

    // Whoever computed the tree resolves against it. Ours kept a reference,
    // so the item says which node it came from and there is nothing to
    // search for. Playwright's items carry none, so that path goes back
    // through role and name — and inherits the two ways that goes wrong: it
    // costs a round trip, and on a page that repeats a name it can resolve
    // to a different control than the one on the line.
    async axElementHandle(scope, item) {
      if (item.axIndex != null) {
        return scope.evaluateHandle((i) => (window.__twebAxNodes || [])[i], item.axIndex);
      }
      return scope.getByRole(item.role, { name: item.name, exact: true }).first().elementHandle();
    },

    async close() {
      await browser.close().catch(() => {});
      // Only tear down a browser we started; one the user was already running
      // is theirs to keep. --keep-browser leaves even ours running, so the
      // next session rejoins it in 50ms instead of cold-starting in four
      // seconds.
      if (child && !keepBrowser) {
        try { child.kill(); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { openChromium };
