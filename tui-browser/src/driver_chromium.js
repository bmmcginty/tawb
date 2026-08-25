'use strict';

const { launchOwnBrowser, connectToBrowser, defaultProfileDir } = require('./browser');
const { parseAriaSnapshot } = require('./aria');
const { extractAxItems } = require('./ax_own');
const { readDocument } = require('./frames');
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
  const sessionOwners = new Map();
  const sessionFor = async (frame) => {
    if (sessions.has(frame)) return sessions.get(frame);
    let session = null;
    let owner = null;
    try {
      // A cross-origin frame is its own target and answers for its own
      // document; anything else is answered by the page's session.
      session = await context.newCDPSession(frame);
      owner = frame;
    } catch {
      try {
        session = await context.newCDPSession(frame.page ? frame.page() : frame);
      } catch { session = null; }
    }
    sessions.set(frame, session);
    if (session) sessionOwners.set(session, owner);
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
  // Nothing is left behind. The pairs go into an array that lives only as a
  // protocol handle — never referenced from window, never hung off one of the
  // page's own elements — and are handed to the extractor as the receiver of
  // a single call. A mark on a page's objects is exactly what must not be
  // there in the one document where being noticed decides everything.
  const pierceShadowRoots = async (frame) => {
    const session = await sessionFor(frame);
    if (!session) return 0;
    // A session of the frame's own answers for that document and nothing
    // else, so there is nothing to filter. Only the fallback — the page's
    // session, which answers for every document in the process — needs to be
    // told which document we meant, and comparing urls there is a guess that
    // can go wrong on a url carrying a query string.
    const ownSession = sessionOwners.get(session) === frame;

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
        // Native audio/video controls live in user-agent shadow roots. They
        // are as real and visible as a page's closed-root controls; page
        // JavaScript simply has no route into them. CDP's pierced document
        // lists both kinds and lets the extractor walk them identically.
        if (['closed', 'user-agent'].includes(shadow.shadowRootType)
          && (ownSession || here === wanted)) {
          pairs.push({ host: node.nodeId, root: shadow.nodeId });
        }
        collect(shadow, here);
      }
      if (node.contentDocument) collect(node.contentDocument, node.contentDocument.documentURL);
      for (const child of node.children || []) collect(child, here);
    };
    collect(document, document.documentURL);
    if (!pairs.length) return 0;

    // An array belonging to nothing the page can name.
    let basket;
    try {
      basket = (await session.send('Runtime.evaluate', { expression: '[]' })).result.objectId;
    } catch {
      return null;
    }

    let registered = 0;
    for (const pair of pairs) {
      try {
        const host = await session.send('DOM.resolveNode', { nodeId: pair.host });
        const shadow = await session.send('DOM.resolveNode', { nodeId: pair.root });
        await session.send('Runtime.callFunctionOn', {
          objectId: basket,
          functionDeclaration: 'function (host, root) { this.push([host, root]); }',
          arguments: [{ objectId: host.object.objectId }, { objectId: shadow.object.objectId }],
        });
        registered += 1;
      } catch {
        // The node went away between listing it and resolving it.
      }
    }
    if (!registered) {
      await session.send('Runtime.releaseObject', { objectId: basket }).catch(() => {});
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

    // The accessibility tree, flattened into reading order. Ours, computed in
    // the page, in the same item shape the Playwright path produced — so
    // everything downstream (prose merging, separator folding, layout) is
    // untouched by which one computed it.
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
          objectId: pierced.basket,
          returnByValue: true,
          functionDeclaration: `function () { const run = ${pageFunction.toString()};`
            + ` return run(Object.assign({ pairs: this }, ${JSON.stringify(extra)})); }`,
        });
        return answer.result.value;
      } finally {
        await pierced.session.send('Runtime.releaseObject', { objectId: pierced.basket }).catch(() => {});
      }
    },

    async axItems(frame) {
      if (!ownAx) return parseAriaSnapshot(await frame.locator('body').ariaSnapshot());
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
      const at = { x: Math.round(x), y: Math.round(y) };
      // Moved to, then pressed, then released, with the button state each
      // event should carry. A bare press and release with no movement before
      // it and no buttons on the release is not what a mouse produces, and
      // the one place this is used — a challenge widget — is precisely where
      // something is watching how the click was made.
      await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, buttons: 0 });
      await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1,
      });
      await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1,
      });
    },

    // Whoever computed the tree resolves against it. Ours kept a reference,
    // so the item says which node it came from and there is nothing to
    // search for. Playwright's items carry none, so that path goes back
    // through role and name — and inherits the two ways that goes wrong: it
    // costs a round trip, and on a page that repeats a name it can resolve
    // to a different control than the one on the line.
    async axElementHandle(scope, item) {
      if (item.axIndex != null) {
        return scope.evaluateHandle((i) => (window[Symbol.for('tweb.ax')] || [])[i], item.axIndex);
      }
      return scope.getByRole(item.role, { name: item.name, exact: true }).first().elementHandle();
    },

    async close() {
      // Answer what the browser is still holding for us before letting go of
      // the connection it would be answered over.
      await cancelPendingAuth();
      // Detach what we attached. A session left open is an attachment the
      // browser goes on maintaining for a client that has gone.
      for (const session of sessions.values()) {
        if (session) await session.detach().catch(() => {});
      }
      sessions.clear();
      sessionOwners.clear();
      for (const session of authSessions.values()) {
        await session.detach().catch(() => {});
      }
      authSessions.clear();
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
