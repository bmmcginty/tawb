'use strict';

const bidi = require('./bidi');
const { launchFirefox, defaultProfileDir, releaseStrandedSession } = require('./firefox');
const { readEndpointRecord, writeEndpointRecord, portOfEndpoint } = require('./endpoint');
const { ensureBroker, clearBrokerRecord } = require('./broker');
const { processAlive, killProcessGroup } = require('./proc');
const { otherReadersOn } = require('./session');
const { forgetBrowser, markKept } = require('./registry');
const { extractAxItems } = require('./ax_own');
const { readDocument } = require('./frames');

// Firefox, driven over WebDriver BiDi.
//
// The objects below deliberately imitate the shape of the Playwright ones the
// rest of this program already talks to — url, goto, evaluate, frames,
// mainFrame — because that shape is the contract, and reimplementing it is far
// less work than teaching every view about two kinds of browser. Only the
// subset actually used is here; anything missing should throw rather than
// quietly return nothing, so a gap shows up as an error naming itself.
//
// What is not here yet, and is honest about it:
//
// Two things work differently here than on the Chromium path, and both are
// visible in this file:
//
//   the AX view    comes from our own implementation in ax_own.js, because
//                  Playwright is not here to compute it. Chromium keeps
//                  using Playwright's.
//   child frames   BiDi has no element-to-context link, so an iframe element
//                  is matched to its browsing context by position: the Nth
//                  frame element in a document belongs to the Nth child
//                  context of that document. Which is the same ordering
//                  assumption the AX path has always relied on to splice
//                  frames into the right place.

const NAVIGATION_EVENTS = [
  'browsingContext.load',
  'browsingContext.domContentLoaded',
  'browsingContext.fragmentNavigated',
  'browsingContext.navigationStarted',
];

// How long an action is given to start a navigation before we conclude it was
// not going to. A click that navigates says so within a round trip, so this is
// generous already, and it is paid in full by every button that only changes
// the page in place — at 400ms that was five times the cost of the same press
// on Chromium. Missing the window is no longer serious: the pulse notices a
// new document within a second and rebuilds regardless of what the reader is
// pressing, so the cost of guessing low is a slower update rather than a stale
// page.
const NAVIGATION_GRACE_MS = 150;

// BiDi delivers no event you have not asked for, channel callbacks included:
// without this subscription the page calls its binding, the call succeeds, and
// nothing ever arrives. Which is exactly as quiet as a binding that was never
// installed, and took a probe to tell apart.
const SUBSCRIBED_EVENTS = [
  ...NAVIGATION_EVENTS,
  'script.message',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
];

function toRemoteArgument(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  switch (typeof value) {
    case 'string': return { type: 'string', value };
    case 'boolean': return { type: 'boolean', value };
    case 'number': return { type: 'number', value };
    default: break;
  }
  if (value && typeof value === 'object' && typeof value.handle === 'string') {
    return { handle: value.handle };
  }
  if (Array.isArray(value)) return { type: 'array', value: value.map(toRemoteArgument) };
  if (value && typeof value === 'object') {
    return { type: 'object', value: Object.entries(value).map(([k, v]) => [k, toRemoteArgument(v)]) };
  }
  throw new Error(`cannot pass ${typeof value} to the page`);
}

// Playwright takes a function or a string; BiDi takes a function declaration.
function asFunctionDeclaration(fn) {
  if (typeof fn === 'function') return fn.toString();
  // A bare expression, which is what `evaluate('1 + 1')` means.
  return `() => { return (${fn}); }`;
}

class FirefoxFrame {
  constructor(session, contextId, page) {
    this.session = session;
    this.contextId = contextId;
    this.page = page;
    this._url = 'about:blank';
  }

  url() {
    return this._url;
  }

  async evaluate(fn, arg) {
    const result = await this.session.send('script.callFunction', {
      functionDeclaration: asFunctionDeclaration(fn),
      arguments: arg === undefined ? [] : [toRemoteArgument(arg)],
      target: { context: this.contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (result.type === 'exception') {
      throw new Error(result.exceptionDetails?.text || 'the page threw while evaluating');
    }
    return bidi.fromRemoteValue(result.result);
  }

  async evaluateHandle(fn, arg) {
    const result = await this.session.send('script.callFunction', {
      functionDeclaration: asFunctionDeclaration(fn),
      arguments: arg === undefined ? [] : [toRemoteArgument(arg)],
      target: { context: this.contextId },
      awaitPromise: true,
      resultOwnership: 'root',
    });
    if (result.type === 'exception') {
      throw new Error(result.exceptionDetails?.text || 'the page threw while evaluating');
    }
    // The shared id, not just the handle: a pointer action names its target
    // by shared reference, and nothing else in BiDi will accept a handle for
    // it. They are two names for one node and both come back here.
    return new FirefoxHandle(
      this.session, this.contextId, this.page, result.result.handle, result.result.sharedId);
  }

  // Only ever called for frame elements, and what the caller needs from each
  // is its child document. BiDi will not map an element to a context, so what
  // comes back is a position: the Nth frame element in this document.
  async $$(selector) {
    const count = await this.evaluate(
      (sel) => document.querySelectorAll(sel).length, selector);
    const refs = [];
    for (let i = 0; i < count; i += 1) refs.push(new FirefoxFrameRef(this, i));
    return refs;
  }

  // The child documents of this one, in the order the browser reports them,
  // which is document order.
  async childFrames() {
    const tree = await this.session.send('browsingContext.getTree', {
      root: this.contextId, maxDepth: 1,
    }).catch(() => null);
    const children = tree?.contexts?.[0]?.children || [];
    return children.map((child) => {
      const frame = new FirefoxFrame(this.session, child.context, this.page);
      frame._url = child.url || 'about:blank';
      return frame;
    });
  }
}

// A frame element identified by where it sits rather than by a handle, since
// that is all BiDi offers. It answers contentFrame() and nothing else, which
// is all the frame walker asks of it.
class FirefoxFrameRef {
  constructor(parent, index) {
    this.parent = parent;
    this.index = index;
  }

  async contentFrame() {
    const children = await this.parent.childFrames();
    return children[this.index] || null;
  }

  async dispose() {
    // Nothing was held: the reference is a number.
  }
}

class FirefoxHandle {
  constructor(session, contextId, page, handle, sharedId = null) {
    this.session = session;
    this.contextId = contextId;
    this.page = page;
    this.handle = handle;
    this.sharedId = sharedId || null;
  }

  async evaluate(fn, arg) {
    const args = [{ handle: this.handle }];
    if (arg !== undefined) args.push(toRemoteArgument(arg));
    const result = await this.session.send('script.callFunction', {
      functionDeclaration: asFunctionDeclaration(fn),
      arguments: args,
      target: { context: this.contextId },
      awaitPromise: true,
      resultOwnership: 'none',
    });
    if (result.type === 'exception') {
      throw new Error(result.exceptionDetails?.text || 'the page threw while evaluating');
    }
    return bidi.fromRemoteValue(result.result);
  }

  async contentFrame() {
    return null; // see the note about child frames above
  }

  async dispose() {
    await this.session.send('script.disown', {
      handles: [this.handle],
      target: { context: this.contextId },
    }).catch(() => {});
  }
}

// Keys as WebDriver names them: printable characters are themselves, and
// everything else is a code point in a private-use block. This is the mapping
// Playwright's key names go through to reach the same place.
const WEBDRIVER_KEYS = {
  Enter: '\uE007',
  Backspace: '\uE003',
  Tab: '\uE004',
  Escape: '\uE00C',
  Delete: '\uE017',
  Shift: '\uE008',
  Control: '\uE009',
  Alt: '\uE00A',
  Meta: '\uE03D',
  Home: '\uE011',
  End: '\uE010',
  PageUp: '\uE00E',
  PageDown: '\uE00F',
  ArrowLeft: '\uE012',
  ArrowUp: '\uE013',
  ArrowRight: '\uE014',
  ArrowDown: '\uE015',
};

// Typing, through the browser's own input pipeline.
//
// This is the piece that cannot be faked from inside the page: a
// script-dispatched KeyboardEvent is untrusted and does not insert text, which
// is why a WebExtension could never do this and why the protocol is
// load-bearing rather than a convenience. input.performActions produces real
// key events, so autocomplete, IME and a field's own handlers all behave as
// they would under a human's fingers.
class FirefoxKeyboard {
  constructor(session, page) {
    this.session = session;
    this.page = page;
  }

  async #perform(actions) {
    await this.session.send('input.performActions', {
      context: this.page.contextId,
      actions: [{ type: 'key', id: 'tweb-keyboard', actions }],
    });
  }

  async #send(values) {
    const actions = [];
    for (const value of values) {
      actions.push({ type: 'keyDown', value });
      actions.push({ type: 'keyUp', value });
    }
    await this.#perform(actions);
  }

  // Spread rather than split: a character outside the basic plane is two code
  // units and one keystroke.
  async type(text) {
    await this.#send([...String(text)]);
  }

  async press(key) {
    const parts = String(key).split('+');
    const values = parts.map((part) => WEBDRIVER_KEYS[part] || part);
    if (values.some((value, index) => !WEBDRIVER_KEYS[parts[index]] && [...value].length !== 1)) {
      throw new Error(`the Firefox driver has no key named "${key}"`);
    }
    if (values.length === 1) {
      await this.#send(values);
      return;
    }

    const actions = values.map((value) => ({ type: 'keyDown', value }));
    actions.push({ type: 'keyUp', value: values.at(-1) });
    for (let i = values.length - 2; i >= 0; i -= 1) {
      actions.push({ type: 'keyUp', value: values[i] });
    }
    await this.#perform(actions);
  }
}

class FirefoxPage {
  constructor(session, contextId, browserContext) {
    this.session = session;
    this.contextId = contextId;
    this.browserContext = browserContext;
    this._mainFrame = new FirefoxFrame(session, contextId, this);
    this._navigationHandlers = [];
    this._seenFrames = [];
    this._loading = false;
    this._closed = false;
    this.keyboard = new FirefoxKeyboard(session, this);
  }

  context() {
    return this.browserContext;
  }

  mainFrame() {
    return this._mainFrame;
  }

  frames() {
    // Whatever the last snapshot walked into, plus the main document. Frame
    // objects are created per snapshot here rather than tracked, so this is a
    // report of what was reached and not a live tree.
    return [this._mainFrame, ...this._seenFrames];
  }

  noteFrame(frame) {
    if (!this._seenFrames.includes(frame)) this._seenFrames.push(frame);
  }

  url() {
    return this._mainFrame.url();
  }

  isClosed() {
    return !!this._closed;
  }

  async title() {
    return this.evaluate(() => document.title).catch(() => '');
  }

  setUrl(url) {
    this._mainFrame._url = url;
  }

  // Timeouts are applied per command by the BiDi client, so these exist to
  // satisfy the shape rather than to do anything.
  setDefaultTimeout() {}

  setDefaultNavigationTimeout() {}

  on(event, handler) {
    if (event !== 'framenavigated') {
      throw new Error(`the Firefox driver does not report "${event}" yet`);
    }
    this._navigationHandlers.push(handler);
  }

  emitNavigated() {
    for (const handler of this._navigationHandlers) {
      try { handler(this._mainFrame); } catch { /* a handler must not break navigation */ }
    }
  }

  evaluate(fn, arg) {
    return this._mainFrame.evaluate(fn, arg);
  }

  evaluateHandle(fn, arg) {
    return this._mainFrame.evaluateHandle(fn, arg);
  }

  async goto(url, { waitUntil = 'complete' } = {}) {
    const wait = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    try {
      const result = await this.session.send('browsingContext.navigate', {
        context: this.contextId, url, wait,
      });
      this.setUrl(result.url || url);
    } finally {
      // navigate() waited for the document itself, so nothing is outstanding
      // whether it succeeded or threw.
      this._loading = false;
    }
    return null;
  }

  async stopLoading() {
    try {
      await this.session.send('browsingContext.stopLoading', {
        context: this.contextId,
      }, { timeout: 2000 });
    } finally {
      this._loading = false;
    }
  }

  // Waits for a navigation that an action may have started.
  //
  // Doing nothing here was a real bug rather than a missing nicety: activation
  // calls this alongside the click, and returning at once meant the snapshot
  // that followed described the page being left rather than the one being
  // opened. Worse, that snapshot recorded the new URL as the one on screen, so
  // the navigation watcher saw nothing to do and the stale buffer stayed until
  // the reader refreshed by hand.
  //
  // Resolving immediately when nothing is loading is equally wrong, because
  // the click has not necessarily started the navigation yet. So we give a
  // navigation a short window to begin, and only then wait for it to finish.
  // A click that navigates nowhere costs that window and no more.
  async waitForLoadState(state = 'load', { timeout = 15000 } = {}) {
    const startedBy = Date.now() + NAVIGATION_GRACE_MS;
    while (!this._loading && Date.now() < startedBy) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!this._loading) return;

    const deadline = Date.now() + timeout;
    while (this._loading && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async waitForFunction(fn, arg, { timeout = 5000, polling = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate(fn, arg)) return true;
      if (Date.now() >= deadline) throw new Error('waitForFunction timed out');
      await new Promise((r) => setTimeout(r, polling));
    }
  }

  async close() {
    await this.session.send('browsingContext.close', { context: this.contextId }).catch(() => {});
  }
}

// Firefox serves one WebDriver session at a time, and a closed connection does
// not end it — Firefox only unregisters the connection. So a reader that died
// without saying session.end leaves the session standing, and every later
// reader is refused. It cannot be reattached to, ended from another
// connection, or waited out.
//
// Which of those two situations we are in is not something the browser can
// tell us — "Session already started" is all it says — so the reader that owns
// the session records its own process id, and we ask whether that process is
// still alive. A live owner is another reader, and is left alone. A dead owner
// stranded it, and Marionette can release it.
//
// With a broker in front, none of that is this reader's business: the broker
// holds the one session and hands every reader the same one, so a second
// reader is expected rather than refused. What can still happen is a broker
// that died without saying session.end, and the session it left behind is
// released the same way — on the refusal, which is the only moment we can
// tell.
async function startSession(session, { profileDir, marionettePort, log, brokered = false }) {
  const status = brokered ? null : await session.send('session.status', {}).catch(() => null);

  if (status && status.ready === false) {
    const record = readEndpointRecord(profileDir) || {};
    const owner = record.readerPid;

    if (owner && processAlive(owner)) {
      session.close();
      throw new Error(
        `Another reader (process ${owner}) is already using this Firefox, and Firefox `
        + 'allows one session at a time. Quit it, or use a different --profile.',
      );
    }

    if (!marionettePort) {
      session.close();
      throw new Error(
        'This Firefox has a session left over from a reader that died, and there is no '
        + 'Marionette port recorded to release it through. Quit Firefox and start again.',
      );
    }

    const released = await releaseStrandedSession(marionettePort);
    log('firefox.session.released', { owner: owner || null, marionettePort, released });
    if (!released) {
      session.close();
      throw new Error(
        'This Firefox has a session left over from a reader that died, and Marionette '
        + 'did not answer to release it. Quit Firefox and start again.',
      );
    }
  }

  const newSession = () => session.send('session.new', { capabilities: { alwaysMatch: {} } });
  try {
    await newSession();
  } catch (err) {
    const stranded = brokered && marionettePort
      && /Maximum number of active sessions/i.test(String(err.message || ''));
    if (!stranded) {
      session.close();
      throw err;
    }
    // A broker that went without ending its session. Nothing is reading
    // through it — it is gone — so releasing it takes nothing from anybody.
    const released = await releaseStrandedSession(marionettePort);
    log('firefox.session.released', { owner: null, marionettePort, released, brokered: true });
    if (!released) {
      session.close();
      throw err;
    }
    try {
      await newSession();
    } catch (again) {
      session.close();
      throw again;
    }
  }

  // Whoever holds the session says so, so the next reader can tell a live
  // owner from a dead one.
  writeEndpointRecord(profileDir, {
    ...(readEndpointRecord(profileDir) || {}),
    readerPid: process.pid,
  });
}

// Whether the automation announcement really is silenced, asked from inside a
// page rather than assumed from the clear having returned successfully. This
// is the check that keeps a broken patch from becoming a browser that fails
// bot checks without anybody noticing.
async function readWebdriverFlag(page) {
  try {
    return await page.evaluate(() => navigator.webdriver);
  } catch {
    return null;
  }
}

async function openFirefox({
  profile = null, connect = null, keepBrowser = false, broker = true, log = () => {},
} = {}) {
  let child = null;
  let endpoint = connect;
  let cleared = null;
  let marionettePort = null;

  if (!endpoint) {
    const started = await launchFirefox({
      profileDir: profile || defaultProfileDir(), keepBrowser, log,
    });
    child = started.child;
    endpoint = started.endpoint;
    cleared = started.cleared;
    marionettePort = started.marionettePort;
  } else {
    marionettePort = (readEndpointRecord(profile || defaultProfileDir()) || {}).marionettePort;
  }

  // The port the remote agent is serving on, which is how per-browser state
  // — tab claims — is keyed. Chromium's driver takes it from the debugging
  // port; here it is in the endpoint we connected to, whether we started this
  // Firefox or joined one that was already running. It stays the browser's own
  // port when a broker is in front, because what it names is the browser, and
  // every reader of that browser has to agree on the name.
  const port = portOfEndpoint(endpoint);

  // Firefox serves one session per browser, so a second reader cannot have one
  // of its own. The broker holds that session and lets every reader speak
  // through it; see src/broker.js. A caller that named an endpoint itself is
  // taken at its word and connected to directly.
  const profileDir = profile || defaultProfileDir();
  const brokered = broker && !connect;
  const browserEndpoint = endpoint;

  // A broker can go at any moment — it gives up shortly after its last reader
  // leaves, and the reader arriving in that moment finds a socket that closes
  // under it. That is not a failure to report to anybody; it is a reason to
  // start one of our own and try again.
  let session = null;
  for (let attempt = 0; ; attempt += 1) {
    endpoint = brokered
      ? await ensureBroker({ profileDir, endpoint: browserEndpoint, log })
      : browserEndpoint;
    try {
      session = await bidi.connect(endpoint);
      await startSession(session, { profileDir, marionettePort, log, brokered });
      break;
    } catch (err) {
      const vanished = brokered && attempt < 2
        && /connection closed|could not reach|no BiDi endpoint/i.test(String(err.message || ''));
      if (!vanished) throw err;
      log('firefox.broker.vanished', { attempt: attempt + 1 });
      try { if (session) session.close(); } catch { /* already gone */ }
      session = null;
      clearBrokerRecord(profileDir);
    }
  }

  const tree = await session.send('browsingContext.getTree', {});
  const top = tree.contexts[0];
  if (!top) throw new Error('Firefox exposed no browsing context');

  // Pages are kept by browsing-context id rather than rebuilt on demand,
  // because a page owns things that must not be thrown away and remade: its
  // navigation handlers, its keyboard, and whether it is mid-load.
  const pages = new Map();

  const pageFor = (contextId, url) => {
    let page = pages.get(contextId);
    if (!page) {
      page = new FirefoxPage(session, contextId, browserContext);
      pages.set(contextId, page);
    }
    if (url) page.setUrl(url);
    return page;
  };

  const browserContext = {
    pages() { return [...pages.values()]; },
    async newPage() {
      const created = await session.send('browsingContext.create', { type: 'tab' });
      return pageFor(created.context, 'about:blank');
    },
    async exposeBinding(name, callback) {
      const install = `(channel) => { window[${JSON.stringify(name)}] = channel; }`;
      const channelArg = { type: 'channel', value: { channel: name, ownership: 'none' } };

      // Future documents get it from the preload script, which is what keeps
      // the binding working across navigations.
      await session.send('script.addPreloadScript', {
        functionDeclaration: install,
        arguments: [channelArg],
      });

      // The document already open does not, and it is the one being read right
      // now. Without this the observer installs happily and then throws inside
      // the page the first time it tries to report anything — silently, since
      // nobody is listening to a page's exceptions.
      for (const openPage of this.pages()) {
        await session.send('script.callFunction', {
          functionDeclaration: install,
          arguments: [channelArg],
          target: { context: openPage.contextId },
          awaitPromise: false,
          resultOwnership: 'none',
        }).catch(() => {});
      }

      session.on('script.message', (params) => {
        if (params.channel !== name) return;
        // Which tab called, so a binding registered for the whole browser is
        // not delivered as though every tab were the one being read. A child
        // frame's realm names its own context and matches no page, and that
        // answer is left as null: the receiving side reads null as "cannot
        // say" and delivers it, which is right, because a child frame of the
        // read tab is the read tab.
        const context = params.source && params.source.context;
        const page = this.pages().find((open) => open.contextId === context) || null;
        callback({ page }, bidi.fromRemoteValue(params.data));
      });
    },
    async addInitScript(fn) {
      await session.send('script.addPreloadScript', {
        functionDeclaration: asFunctionDeclaration(fn),
      });
    },
  };

  const page = pageFor(top.context, top.url || 'about:blank');
  // Tabs the browser already had, from every window it has open.
  for (const other of tree.contexts.slice(1)) {
    if (!other.parent) pageFor(other.context, other.url);
  }

  const newTabHandlers = [];

  await session.send('session.subscribe', { events: SUBSCRIBED_EVENTS }).catch(() => {});

  for (const event of NAVIGATION_EVENTS) {
    session.on(event, (params) => {
      // Events arrive for every context, including frames, so they are routed
      // to the page they belong to rather than assumed to be for ours.
      const target = pages.get(params.context);
      if (!target) return;
      if (params.url) target.setUrl(params.url);
      if (event === 'browsingContext.navigationStarted') {
        target._loading = true;
      } else if (event === 'browsingContext.load') {
        target._loading = false;
        target.emitNavigated();
      } else if (event === 'browsingContext.fragmentNavigated') {
        target.emitNavigated();
      }
    });
  }

  session.on('browsingContext.contextCreated', (params) => {
    // A frame is a browsing context too; only a top-level one is a tab.
    if (params.parent) return;
    const opened = pageFor(params.context, params.url);
    for (const handler of newTabHandlers) {
      try { handler(opened); } catch { /* a handler must not break the session */ }
    }
  });

  session.on('browsingContext.contextDestroyed', (params) => {
    const closing = pages.get(params.context);
    if (closing) closing._closed = true;
    pages.delete(params.context);
  });

  // Set by attachAuth, and the only thing that decides whether a challenge is
  // answered here or left to the browser's own prompt.
  let answerAuth = null;
  // Challenges the browser is holding open while we decide. See
  // cancelPendingAuth: a question we leave unanswered is one nobody can
  // answer afterwards, because the prompt became ours when the intercept was
  // added.
  const pendingAuth = new Set();

  const cancelPendingAuth = async () => {
    const pending = [...pendingAuth];
    pendingAuth.clear();
    if (!pending.length) return;
    log('auth.cancelled', { requests: pending.length });
    await Promise.all(pending.map((request) => session.send('network.continueWithAuth', {
      request, action: 'cancel',
    }).catch(() => {})));
  };

  const webdriverFlag = await readWebdriverFlag(page);
  log('firefox.ready', { cleared, webdriver: webdriverFlag });
  if (webdriverFlag !== false) {
    session.close();
    if (child) killProcessGroup(child.pid);
    throw new Error(
      'Firefox is still announcing itself as automated (navigator.webdriver is '
      + `${webdriverFlag}). Refusing to read the web with a browser that will fail bot `
      + 'checks. This usually means Firefox moved the shared-data key the clear targets.',
    );
  }

  return {
    name: 'firefox',
    browser: null,
    context: browserContext,
    child,
    owned: !!child,
    port,
    rejoined: !child,
    session,

    // Which views this engine can offer.
    capabilities: { ax: true, frames: true },

    // Every tab, across every window: BiDi reports all top-level browsing
    // contexts, and a window is not a thing it distinguishes.
    listTabs() {
      return browserContext.pages();
    },

    onNewTab(handler) {
      newTabHandlers.push(handler);
    },

    // Whether the browser is still there. The socket is the whole of the
    // connection here, so its closing is the browser going away, and every
    // context id we hold names a tab that no longer exists.
    alive() {
      return !session.closed;
    },

    async newTab() {
      return browserContext.newPage();
    },

    // A tab's identity as the browser knows it. A BiDi browsing-context id is
    // already stable for the life of the tab and unique across the browser,
    // so it is its own answer — the same thing a CDP target id is on the other
    // engine, and it means the same thing in another session's process, which
    // is what tab claims are keyed by.
    async targetIdFor(page) {
      return (page && page.contextId) || top.context;
    },

    // Answering Firefox's password prompt ourselves.
    //
    // A 401 raises a prompt drawn by browser chrome, which the reader cannot
    // see and page script cannot reach. BiDi hands it over: an intercept on
    // the authRequired phase turns the challenge into an event, and
    // continueWithAuth answers it with a username and password rather than
    // an Authorization header — the engine performs the scheme, which is why
    // digest costs nothing here.
    //
    // Unlike Chromium's, this intercept is auth-only: no ordinary request is
    // paused, so nothing is paid on a page that is not asking for a password.
    // And unlike Chromium's it is one intercept for the browser, because
    // Firefox serves one BiDi session at a time and that session is this
    // reader's — there is no second reader to answer for.
    async attachAuth(handler) {
      if (answerAuth) { answerAuth = handler; return true; }
      answerAuth = handler;
      await session.send('session.subscribe', { events: ['network.authRequired'] }).catch(() => {});
      await session.send('network.addIntercept', { phases: ['authRequired'] });

      session.on('network.authRequired', async (params) => {
        const request = params.request || {};
        const challenge = ((params.response || {}).authChallenges || [])[0] || {};
        pendingAuth.add(request.request);
        let given = null;
        try {
          given = await answerAuth({
            // BiDi does not name the source; a proxy says so with its status.
            source: (params.response || {}).status === 407 ? 'proxy' : 'server',
            realm: challenge.realm,
            scheme: challenge.scheme,
            url: request.url || '',
            // Which tab asked. A front end that cannot answer on the spot has
            // to put its question somewhere, and the tab that raised the
            // challenge is where the reader is.
          }, request.request, pages.get(params.context) || null);
        } catch {
          given = null;
        }
        // Gone from the set means it was cancelled on our way out, and the
        // request is no longer ours to answer.
        if (!pendingAuth.delete(request.request)) return;
        await session.send('network.continueWithAuth', given
          ? {
            request: request.request,
            action: 'provideCredentials',
            credentials: { type: 'password', username: given.username, password: given.password || '' },
          }
          // Cancelling is not failing: the 401's own body then loads, which
          // is often a page saying what the realm is.
          : { request: request.request, action: 'cancel' }).catch(() => {});
      });
      return true;
    },

    // Nothing to arm: the intercept above is the browser's, and every tab in
    // it is already covered.
    async armAuth() {
      return !!answerAuth;
    },

    // Our own tree, computed in the page. The items come back in the same
    // shape the Playwright path produces, so everything downstream — prose
    // merging, separator folding, layout — is shared.
    // See the note on the Chromium driver's method of the same name. Here the
    // privileged half was installed at startup and left a function in the
    // page, so the extractor asks for the pairs itself, inside the same call
    // that uses them.
    async pierceAndRun(frame, pageFunction, extra = {}) {
      const available = await frame.evaluate(
        () => {
          const pierce = window[Symbol.for('tweb.pierce')];
          return typeof pierce === 'function' ? (pierce() || []).length : 0;
        },
      ).catch(() => 0);
      if (!available) return null;
      log('shadow.pierced', { roots: available, url: String(frame.url()).slice(0, 100) });
      return frame.evaluate(pageFunction, { pierce: true, ...extra });
    },

    async axItems(frame) {
      return readDocument(
        frame, extractAxItems, this, (items) => !items || !items.length,
        (scope) => scope.evaluate(() => !!document.querySelector('video[controls],audio[controls]')),
      );
    },

    async activateNativeControl(scope, item) {
      const target = scope && scope.contextId ? scope : page;
      return target.evaluate((token) => {
        const press = window[Symbol.for('tweb.nativeControl')];
        return typeof press === 'function' && press(token.media, token.index);
      }, item.nativeControl);
    },

    async focusNativeControl(scope, item) {
      const target = scope && scope.contextId ? scope : page;
      return target.evaluate((token) => {
        const focus = window[Symbol.for('tweb.focusNativeControl')];
        return typeof focus === 'function' && focus(token.media, token.index);
      }, item.nativeControl);
    },

    // A click the browser treats as a person's.
    //
    // Everything else here activates through the DOM's own default action,
    // which is right for reading: it needs no viewport and reaches controls
    // that are off-screen. What it cannot produce is user activation — the
    // browser knows perfectly well that nobody touched anything — so a page
    // that gates on a real gesture (audio, fullscreen, the clipboard, a
    // popup) refuses, and there is nothing the page side can do about it.
    //
    // input.performActions is the same road the keyboard already takes: the
    // browser's own input pipeline, above content, so the events are trusted
    // and carry activation. The target is named by shared reference rather
    // than by coordinates we worked out, so the browser computes the
    // element's own centre point and hits what we meant.
    async realClick(scope, handle) {
      if (!handle || !handle.sharedId) {
        throw new Error('this line carries no element reference to click');
      }
      const context = scope && scope.contextId ? scope.contextId : page.contextId;
      const target = { type: 'element', element: { sharedId: handle.sharedId } };
      try {
        await session.send('input.performActions', {
          context,
          actions: [{
            type: 'pointer',
            id: 'tweb-mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: 0, y: 0, origin: target },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
      } finally {
        // A pointer left pressed belongs to nobody once this returns, and the
        // next action would inherit it.
        await session.send('input.releaseActions', { context }).catch(() => {});
      }
    },

    // A real click at a point inside a frame's own viewport, for a document
    // whose contents we cannot see.
    //
    // Firefox cannot enter a closed shadow root at all: page script gets null
    // from node.shadowRoot by definition, BiDi has no equivalent of Chrome's
    // piercing document scan, and Marionette — which could, through the
    // privileged openOrClosedShadowRoot — cannot be used while the reader is
    // running. It refuses a second session with "Maximum number of active
    // sessions", and merely connecting to it deletes the session that is
    // already there, which is exactly how releaseStrandedSession recovers a
    // dead reader's slot. Asking it would take the page out from under the
    // person using it.
    //
    // Hit testing does not care about shadow boundaries, though, so a real
    // pointer action aimed into the frame reaches what is drawn there
    // whoever can see it. Measured against Cloudflare's challenge: the
    // widget's own document receives "body:trusted" — retargeted to the
    // shadow host, which is the proof it went inside.
    async clickInFrame(frame, x, y) {
      const context = frame && frame.contextId ? frame.contextId : page.contextId;
      try {
        await session.send('input.performActions', {
          context,
          actions: [{
            type: 'pointer',
            id: 'tweb-mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              { type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pointerUp', button: 0 },
            ],
          }],
        });
      } finally {
        await session.send('input.releaseActions', { context }).catch(() => {});
      }
    },

    // Ours kept a reference, so there is no need to search by role and name:
    // the item says which node it came from.
    async axElementHandle(scope, item) {
      if (item.axIndex == null) {
        throw new Error('this line carries no element reference to activate');
      }
      return scope.evaluateHandle(
        (i) => (window[Symbol.for('tweb.ax')] || [])[i], item.axIndex);
    },

    async close() {
      // Answer what the browser is still holding for us first: the prompt has
      // been ours since the intercept was added, so a challenge left paused
      // is a tab loading for ever in a browser that outlives us, with no
      // dialog to answer because we took it away. Cancelling loads the 401's
      // own body, exactly as escaping the prompt does.
      await cancelPendingAuth();
      // End the session but leave the browser: Firefox serves one BiDi session
      // at a time and does not release it just because the socket went away,
      // so a session left hanging locks out the next reader entirely.
      await session.send('session.end', {}).catch(() => {});
      const dir = profile || defaultProfileDir();
      const record = readEndpointRecord(dir);
      if (record && record.readerPid === process.pid) {
        writeEndpointRecord(dir, { ...record, readerPid: null });
      }
      // Only a browser we started is ours to shut down, and browser.close is
      // "quit Firefox" — sending it after rejoining would take down a browser
      // somebody else is reading. Disconnecting is all a rejoining session
      // may do.
      session.close();
      // Ours to close only while nobody else is reading it — starting the
      // browser makes this reader its first user, not its owner.
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

module.exports = {
  openFirefox, FirefoxPage, FirefoxFrame, FirefoxHandle, FirefoxKeyboard,
  toRemoteArgument, WEBDRIVER_KEYS,
};
