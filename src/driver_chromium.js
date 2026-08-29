'use strict';

const { launchOwnBrowser, connectToBrowser, defaultProfileDir } = require('./browser');
const { extractAxItems } = require('./ax_own');
const { readDocument } = require('./frames');
const { otherReadersOn } = require('./session');
const { forgetBrowser, markKept } = require('./registry');
const { killProcessGroup } = require('./proc');
const { log } = require('./log');
const { readChromiumLibrary } = require('./library_chromium');
const { armNativeDialogs } = require('./native_prompt');

// What this browser calls itself on the accessibility bus. Only needed for a
// browser reached with --connect, where there is no process of ours to match
// it by.
const BROWSER_NAMES = ['Chromium', 'Chrome', 'Google Chrome', 'Chromium-browser'];

// Chromium, attached to over the DevTools protocol.
//
// This is the path that works and is not to be disturbed: it clears bot
// checks because the browser is an ordinary one that happens to be observed.
//
// The protocol is spoken directly — see cdp.js for the client and
// cdp_page.js for the page, frame and handle objects built on it. Playwright
// used to carry those, and by the end its contribution was the transport plus
// two conveniences that had both been replaced: its accessibility tree, and
// its role-and-name locators.
//
// The accessibility tree is ours, computed in the page by ax_own.js, the same
// as Firefox. It was Playwright's for as long as ours was unproven, and the
// two were held against each other on real pages until they agreed. Ours
// wins on two counts that are not matters of taste: its items carry a
// reference to the element they came from, so activating a line no longer
// means searching the page again for something with that role and that exact
// name — which is a round trip, and which silently finds the wrong control
// when a page repeats a name. And it reads aria-expanded as the three answers
// it has, where ariaSnapshot marks an open control and has no way to say that
// one is closed.

async function openChromium({
  connect = null, profile = null, keepBrowser = false, log = () => {},
} = {}) {
  let browser;
  let context;
  let child = null;
  let owned = false;
  let port = null;
  let rejoined = false;
  // Where this browser describes its own windows, if it describes them at
  // all. Everything native — an extension's consent dialog, and whatever else
  // is drawn outside a document — is read through this. See atspi.js.
  let a11y = null;

  if (connect) {
    const connected = await connectToBrowser(connect, { log });
    ({ browser, context } = connected);
    port = connected.port;
    rejoined = true;
    a11y = connected.a11y;
  } else {
    const started = await launchOwnBrowser({ profileDir: profile || defaultProfileDir(), log });
    ({ browser, context } = started);
    child = started.child;
    owned = !!started.owned;
    port = started.port;
    rejoined = !!started.rejoined;
    a11y = started.a11y;
  }

  // The session that answers for a document. A cross-origin frame is its own
  // target and has one of its own; anything else is answered by the tab's.
  // The frame itself knows which, because the attachment that created the
  // session recorded it there.
  const sessionFor = (frame) => frame.session();

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
  // Nothing is left behind. The pairs go into an array that lives only as a
  // protocol handle — never referenced from window, never hung off one of the
  // page's own elements — and are handed to the extractor as the receiver of
  // a single call. A mark on a page's objects is exactly what must not be
  // there in the one document where being noticed decides everything.
  const pierceShadowRoots = async (frame) => {
    const session = sessionFor(frame);
    if (!session) return 0;
    // A session of the frame's own answers for that document and nothing
    // else, so there is nothing to filter. Only the shared case — the tab's
    // session, which answers for every same-process document in it — needs to
    // be told which document we meant, and comparing urls there is a guess
    // that can go wrong on a url carrying a query string.
    const ownSession = typeof frame.ownTarget === 'function' && frame.ownTarget();

    let document;
    try {
      ({ root: document } = await session.send('DOM.getDocument', { depth: -1, pierce: true }));
    } catch {
      return 0;
    }

    // Only this frame's own roots. A session on the tab answers for every
    // document in the process, and registering another frame's root into this
    // frame's map would be meaningless at best.
    const wanted = frame.url();
    const pairs = [];
    const collect = (node, docUrl) => {
      const here = node.nodeName === '#document' ? (node.documentURL || docUrl) : docUrl;
      for (const shadow of node.shadowRoots || []) {
        // Native audio/video controls live in user-agent shadow roots. They
        // are as real and visible as a page's closed-root controls; page
        // JavaScript simply has no route into them. CDP's pierced document
        // lists both kinds and lets the extractor walk them identically.
        if (['closed', 'user-agent'].includes(shadow.shadowRootType)
          && (ownSession || here === wanted)) {
          pairs.push({ host: node.nodeId, root: shadow.nodeId, kind: shadow.shadowRootType });
        }
        collect(shadow, here);
      }
      if (node.contentDocument) collect(node.contentDocument, node.contentDocument.documentURL);
      for (const child of node.children || []) collect(child, here);
    };
    collect(document, document.documentURL);
    if (!pairs.length) return 0;

    // An array belonging to nothing the page can name, made in the frame's
    // own world so the nodes about to go into it are from the same one.
    let basket;
    try {
      basket = await frame.evaluateHandle(() => []);
    } catch {
      return null;
    }

    let registered = 0;
    for (const pair of pairs) {
      try {
        const host = await session.send('DOM.resolveNode', { nodeId: pair.host });
        const shadow = await session.send('DOM.resolveNode', { nodeId: pair.root });
        await session.send('Runtime.callFunctionOn', {
          objectId: basket.objectId,
          functionDeclaration: 'function (host, root, kind) { this.push([host, root, null, kind]); }',
          arguments: [
            { objectId: host.object.objectId },
            { objectId: shadow.object.objectId },
            { value: pair.kind },
          ],
        });
        registered += 1;
      } catch {
        // The node went away between listing it and resolving it.
      }
    }
    if (!registered) {
      await basket.dispose();
      return null;
    }
    log('shadow.pierced', { roots: registered, url: String(wanted).slice(0, 100) });
    return { session, basket };
  };

  // Answering the browser's password prompt ourselves.
  //
  // A 401 raises a dialog drawn by browser chrome, which the reader cannot
  // see and page script cannot reach. Fetch hands it over instead: the
  // challenge arrives as an event, and continueWithAuth answers it with a
  // username and a password — not with an Authorization header. The engine
  // performs the scheme, which is why digest costs nothing here.
  //
  // Chromium has no auth-only interception. Asking for authRequired events
  // pauses matching requests too, and a pattern list that matches nothing
  // gets neither the events nor the dialog — the load fails with
  // ERR_INVALID_AUTH_CREDENTIALS instead, which is the worst of both. So the
  // pattern is everything and every paused request is continued straight
  // away. Measured on a page of 101 requests: 250ms bare, 300ms armed.
  //
  // Per tab rather than per browser, because a browser may be shared with
  // another reader, and a password prompt belongs to whoever is reading the
  // tab that raised it.
  const authSessions = new Map();
  // Challenges the browser is holding open while we decide. A paused request
  // is a question, and the browser waits on the answer for as long as we are
  // there to give one — see cancelPendingAuth for what happens when we are
  // not.
  const pendingAuth = new Map();
  let answerAuth = null;

  // Every challenge still waiting on an answer, cancelled.
  //
  // The prompt is ours the moment the interception is armed: the browser
  // stops drawing its own dialog and holds the request instead. So a session
  // that leaves without answering leaves a question nobody can ever answer —
  // a tab loading for ever in a browser the reader goes on using, with no
  // dialog to answer because we took it. Cancelling loads the 401's own body,
  // which is what escaping the prompt does: a page, and a tab that has
  // finished.
  //
  // It matters before we detach as well as after. Detaching a session with
  // requests paused on it is itself a wait — measured at twenty seconds and
  // still going, long past the grace a signalled shutdown allows.
  const cancelPendingAuth = async () => {
    const pending = [...pendingAuth.entries()];
    pendingAuth.clear();
    if (!pending.length) return;
    log('auth.cancelled', { requests: pending.length });
    await Promise.all(pending.map(([requestId, session]) => session.send('Fetch.continueWithAuth', {
      requestId,
      authChallengeResponse: { response: 'CancelAuth' },
    }).catch(() => {})));
  };

  const armAuth = async (page) => {
    if (!answerAuth || authSessions.has(page)) return false;
    let session;
    try {
      session = await context.newCDPSession(page);
    } catch {
      return false;
    }
    authSessions.set(page, session);

    session.on('Fetch.requestPaused', (event) => {
      session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
    });

    session.on('Fetch.authRequired', async (event) => {
      const challenge = event.authChallenge || {};
      pendingAuth.set(event.requestId, session);
      let given = null;
      try {
        given = await answerAuth({
          source: challenge.source,
          origin: challenge.origin,
          realm: challenge.realm,
          scheme: challenge.scheme,
          url: (event.request && event.request.url) || '',
        // The interception id is a counter within this target, so it names
        // the request only alongside the target it belongs to.
        }, `${event.frameId || 'page'}:${event.requestId}`, page);
      } catch {
        given = null;
      }
      // Gone from the map means it was cancelled on our way out, and the
      // request is no longer ours to answer.
      if (!pendingAuth.delete(event.requestId)) return;
      await session.send('Fetch.continueWithAuth', {
        requestId: event.requestId,
        authChallengeResponse: given
          ? { response: 'ProvideCredentials', username: given.username, password: given.password || '' }
          // Cancelling is not failing: the 401's own body then loads, which
          // is often a page saying what the realm is.
          : { response: 'CancelAuth' },
      }).catch(() => {});
    });

    try {
      await session.send('Fetch.enable', {
        handleAuthRequests: true,
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
    } catch {
      authSessions.delete(page);
      return false;
    }

    page.once('close', () => {
      authSessions.delete(page);
      for (const [requestId, owner] of pendingAuth) {
        if (owner === session) pendingAuth.delete(requestId);
      }
      session.detach().catch(() => {});
    });
    log('auth.armed', { url: String(page.url()).slice(0, 80) });
    return true;
  };

  // Dialogs the browser draws for itself: an extension asking for consent,
  // and anything else that is a window rather than a document. Neither
  // protocol has them; the browser's own accessibility interface does. See
  // native_prompt.js for the shape and atspi.js for how it is read.
  //
  // This is deliberately not armed unless somebody asks for it, and it is
  // silent about being unavailable: a browser started by somebody else, or a
  // machine with no bus, simply has no native dialogs to offer, and a reader
  // who never adds an extension never notices.
  let nativeWatch = null;
  const armNative = (handler) => armNativeDialogs({
    bus: a11y, pid: child ? child.pid : null, names: BROWSER_NAMES, onDialog: handler, log,
  });

  // The browser's own bookmarks, history and downloads. Not in the protocol —
  // CDP describes documents, and a record of where you have been is not one —
  // so they are asked of the pages the browser answers them on. See
  // library_chromium.js.
  const readLibrary = (kind) => readChromiumLibrary(context, kind);

  return {
    name: 'chromium',
    ax: 'own',
    browser,
    context,
    child,
    owned,
    port,
    rejoined,
    readLibrary,

    // Answer this browser's own dialogs on the terminal. `handler` is given
    // what the dialog says and the buttons it offers; answering presses one
    // of them. Null means this browser has none to offer.
    async watchNativeDialogs(handler) {
      nativeWatch = await armNative(handler).catch(() => null);
      return nativeWatch;
    },

    // A tab's identity as the browser knows it — the only name for a tab that
    // means the same thing in another session's process. It is the target id
    // the tab was attached by, so this costs nothing to answer.
    async targetIdFor(page) {
      return (page && page.targetId) || null;
    },

    // Answer this browser's password prompts with `handler`, which is given a
    // challenge, the request it belongs to and the tab it was raised in, and
    // returns credentials, or null to cancel. Nothing is armed by this: a rejoined browser holds
    // tabs another reader is reading, and their passwords are not ours to
    // ask for. Tabs are armed as they are taken — see armAuth.
    //
    // A challenge from a cross-origin iframe is not covered either: site
    // isolation makes that frame its own target with its own network, and
    // this is armed on the tab's. Such a challenge behaves as it did before
    // any of this existed — the browser puts up a dialog nobody can see.
    async attachAuth(handler) {
      answerAuth = handler;
      return true;
    },

    // One tab, armed because it is now this reader's. Called from adoptTab,
    // which is the one place that decides a tab belongs to this session.
    async armAuth(page) {
      return armAuth(page).catch(() => false);
    },

    // Run a page-side extractor again, with the closed shadow roots supplied.
    //
    // Any walk of a document hits the same wall, not just the accessibility
    // one: page script cannot enter a closed shadow root however it is
    // written. So this is the capability rather than a feature of one
    // extractor — whatever wants to read a document can ask for it, and the
    // reader and the edbrowse server both do.
    //
    // Answers null when there was nothing to pierce, so the caller can keep
    // whatever it already had.
    async pierceAndRun(frame, pageFunction, extra = {}) {
      const pierced = await pierceShadowRoots(frame);
      if (!pierced) return null;

      // Called with the pairs as the receiver, so they are an argument to one
      // call rather than a property of anything the page owns.
      try {
        const answer = await pierced.session.send('Runtime.callFunctionOn', {
          objectId: pierced.basket.objectId,
          returnByValue: true,
          functionDeclaration: `function () { const run = ${pageFunction.toString()};`
            + ` return run(Object.assign({ pairs: this }, ${JSON.stringify(extra)})); }`,
        });
        return answer.result.value;
      } finally {
        await pierced.basket.dispose();
      }
    },

    // The accessibility tree, flattened into reading order. Ours, computed in
    // the page, in the same item shape everything downstream expects — prose
    // merging, separator folding and layout are untouched by which engine
    // produced it.
    async axItems(frame) {
      return readDocument(
        frame, extractAxItems, this, (items) => !items || !items.length,
        (scope) => scope.evaluate(() => !!document.querySelector('video[controls],audio[controls]')),
      );
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
    // So this is real input dispatched above content, at the element's own
    // centre: the events are trusted and carry activation. Where that centre
    // is comes from the protocol rather than from page script, and it is
    // already in the top-level viewport's coordinates whichever session
    // answered — which is what lets a control inside a cross-origin iframe be
    // clicked without any offset arithmetic.
    //
    // Whether the point is actually reachable was settled before we got here,
    // by prepareRealClick in the page: a click that lands on a cookie banner
    // instead of the button is worse than no click, and the reader cannot see
    // that the banner is there.
    async realClick(scope, handle) {
      await handle.click();
    },

    // A real click at a point inside a frame's own viewport, for a document
    // whose contents could not be read even after piercing. Dispatched on
    // that frame's own session, so the coordinates are its own.
    async clickInFrame(frame, x, y) {
      const session = sessionFor(frame);
      if (!session) throw new Error('no session for that frame');
      await frame.page().clickAt(x, y, session);
    },

    // Ours kept a reference, so the item says which node it came from and
    // there is nothing to search for.
    async axElementHandle(scope, item) {
      if (item.axIndex == null) {
        throw new Error('that line carries no element reference');
      }
      return scope.evaluateHandle((i) => (window[Symbol.for('tweb.ax')] || [])[i], item.axIndex);
    },

    async close() {
      // Answer what the browser is still holding for us before letting go of
      // the connection it would be answered over.
      await cancelPendingAuth();
      // Detach what we attached. A session left open is an attachment the
      // browser goes on maintaining for a client that has gone.
      for (const session of authSessions.values()) {
        await session.detach().catch(() => {});
      }
      authSessions.clear();
      if (nativeWatch) nativeWatch.stop();
      await browser.close().catch(() => {});
      // The accessibility bus, and the session bus under it if this session
      // started one. A name claimed here is released here, so a desktop that
      // later starts a real accessibility bus finds it free.
      if (a11y) await a11y.close().catch(() => {});
      // Only tear down a browser we started; one the user was already running
      // is theirs to keep. --keep-browser leaves even ours running, so the
      // next session rejoins it in 50ms instead of cold-starting in four
      // seconds. Nor is it ours to close while another reader is still in it,
      // however it got there — starting the browser makes us its first user,
      // not its owner.
      if (child && !keepBrowser && !otherReadersOn(port)) {
        killProcessGroup(child.pid);
        forgetBrowser(port);
      } else if (child && keepBrowser) {
        // Left running on purpose, so not something a later sweep should
        // mistake for a browser somebody crashed out of.
        markKept(port);
      }
    },
  };
}

module.exports = { openChromium };
