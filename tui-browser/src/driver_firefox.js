'use strict';

const bidi = require('./bidi');
const { launchFirefox, defaultProfileDir } = require('./firefox');

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
//   the AX view    Playwright computes the accessibility tree with an
//                  injected script of its own. Our own implementation is the
//                  remaining piece, and until it lands this driver reports
//                  ax: false and the view is simply not offered. The other
//                  three views are pure injected JavaScript and work now.
//   child frames   descending into iframes needs an element-to-context
//                  mapping that BiDi expresses differently from CDP. Until
//                  then a frame reports no children and the walker stops at
//                  the top document.

const NAVIGATION_EVENTS = [
  'browsingContext.load',
  'browsingContext.domContentLoaded',
  'browsingContext.fragmentNavigated',
  'browsingContext.navigationStarted',
];

// BiDi delivers no event you have not asked for, channel callbacks included:
// without this subscription the page calls its binding, the call succeeds, and
// nothing ever arrives. Which is exactly as quiet as a binding that was never
// installed, and took a probe to tell apart.
const SUBSCRIBED_EVENTS = [...NAVIGATION_EVENTS, 'script.message'];

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
    return new FirefoxHandle(this.session, this.contextId, this.page, result.result.handle);
  }

  // Descending into frames is not wired up yet, and reporting none is the
  // honest answer: the walker then renders the top document and stops, rather
  // than claiming an embed is empty.
  async $$() {
    return [];
  }
}

class FirefoxHandle {
  constructor(session, contextId, page, handle) {
    this.session = session;
    this.contextId = contextId;
    this.page = page;
    this.handle = handle;
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

class FirefoxPage {
  constructor(session, contextId, browserContext) {
    this.session = session;
    this.contextId = contextId;
    this.browserContext = browserContext;
    this._mainFrame = new FirefoxFrame(session, contextId, this);
    this._navigationHandlers = [];
  }

  context() {
    return this.browserContext;
  }

  mainFrame() {
    return this._mainFrame;
  }

  frames() {
    return [this._mainFrame];
  }

  url() {
    return this._mainFrame.url();
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
    const result = await this.session.send('browsingContext.navigate', {
      context: this.contextId, url, wait,
    });
    this.setUrl(result.url || url);
    return null;
  }

  async waitForLoadState() {
    // Navigation already waits for the document, so there is nothing left to
    // wait for that we can express here.
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

async function openFirefox({ profile = null, connect = null, log = () => {} } = {}) {
  let child = null;
  let endpoint = connect;
  let cleared = null;

  if (!endpoint) {
    const started = await launchFirefox({ profileDir: profile || defaultProfileDir(), log });
    child = started.child;
    endpoint = started.endpoint;
    cleared = started.cleared;
  }

  const session = await bidi.connect(endpoint);
  await session.send('session.new', { capabilities: { alwaysMatch: {} } });

  const tree = await session.send('browsingContext.getTree', {});
  const top = tree.contexts[0];
  if (!top) throw new Error('Firefox exposed no browsing context');

  const browserContext = {
    _pages: [],
    pages() { return this._pages; },
    async newPage() { return this._pages[0]; },
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
      for (const openPage of this._pages) {
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
        callback({}, bidi.fromRemoteValue(params.data));
      });
    },
    async addInitScript(fn) {
      await session.send('script.addPreloadScript', {
        functionDeclaration: asFunctionDeclaration(fn),
      });
    },
  };

  const page = new FirefoxPage(session, top.context, browserContext);
  page.setUrl(top.url || 'about:blank');
  browserContext._pages.push(page);

  await session.send('session.subscribe', { events: SUBSCRIBED_EVENTS }).catch(() => {});
  for (const event of NAVIGATION_EVENTS) {
    session.on(event, (params) => {
      if (params.context !== top.context) return;
      if (params.url) page.setUrl(params.url);
      if (event === 'browsingContext.load' || event === 'browsingContext.fragmentNavigated') {
        page.emitNavigated();
      }
    });
  }

  const webdriverFlag = await readWebdriverFlag(page);
  log('firefox.ready', { cleared, webdriver: webdriverFlag });
  if (webdriverFlag !== false) {
    await session.send('browser.close', {}).catch(() => {});
    session.close();
    if (child) { try { child.kill(); } catch { /* already gone */ } }
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
    port: null,
    rejoined: !child,
    session,

    // Which views this engine can offer. The AX tree needs an implementation
    // of our own, which is the piece still outstanding.
    capabilities: { ax: false, frames: false },

    async targetIdFor() {
      // BiDi context ids are already stable per tab; one tab for now, so tab
      // claiming has nothing to disambiguate.
      return top.context;
    },

    async axSnapshot() {
      throw new Error('the AX view is not implemented for Firefox yet');
    },

    async elementByRole() {
      throw new Error('resolving by role is not implemented for Firefox yet');
    },

    async close() {
      await session.send('browser.close', {}).catch(() => {});
      session.close();
      if (child) { try { child.kill(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { openFirefox, FirefoxPage, FirefoxFrame, FirefoxHandle, toRemoteArgument };
