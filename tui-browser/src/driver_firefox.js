'use strict';

const bidi = require('./bidi');
const { launchFirefox, defaultProfileDir } = require('./firefox');
const { extractAxItems } = require('./ax_own');

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

// Keys as WebDriver names them: printable characters are themselves, and
// everything else is a code point in a private-use block. This is the mapping
// Playwright's key names go through to reach the same place.
const WEBDRIVER_KEYS = {
  Enter: '\uE007',
  Backspace: '\uE003',
  Tab: '\uE004',
  Escape: '\uE00C',
  Delete: '\uE017',
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

  async #send(values) {
    const actions = [];
    for (const value of values) {
      actions.push({ type: 'keyDown', value });
      actions.push({ type: 'keyUp', value });
    }
    await this.session.send('input.performActions', {
      context: this.page.contextId,
      actions: [{ type: 'key', id: 'tweb-keyboard', actions }],
    });
  }

  // Spread rather than split: a character outside the basic plane is two code
  // units and one keystroke.
  async type(text) {
    await this.#send([...String(text)]);
  }

  async press(key) {
    const value = WEBDRIVER_KEYS[key];
    if (!value && String(key).length !== 1) {
      throw new Error(`the Firefox driver has no key named "${key}"`);
    }
    await this.#send([value || key]);
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

async function openFirefox({
  profile = null, connect = null, keepBrowser = false, log = () => {},
} = {}) {
  let child = null;
  let endpoint = connect;
  let cleared = null;

  if (!endpoint) {
    const started = await launchFirefox({
      profileDir: profile || defaultProfileDir(), keepBrowser, log,
    });
    child = started.child;
    endpoint = started.endpoint;
    cleared = started.cleared;
  }

  const session = await bidi.connect(endpoint);
  try {
    await session.send('session.new', { capabilities: { alwaysMatch: {} } });
  } catch (err) {
    session.close();
    // Firefox serves one BiDi session at a time, so a second reader cannot
    // share a Firefox the way two can share a Chromium through separate tabs.
    if (/session/i.test(err.message) && /maximum|already/i.test(err.message)) {
      throw new Error(
        'Another session is already reading this Firefox, and Firefox allows only '
        + 'one at a time. Quit the other reader, or use a different --profile.',
      );
    }
    throw err;
  }

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

    // Which views this engine can offer.
    capabilities: { ax: true, frames: true },

    async targetIdFor() {
      // BiDi context ids are already stable per tab; one tab for now, so tab
      // claiming has nothing to disambiguate.
      return top.context;
    },

    // Our own tree, computed in the page. The items come back in the same
    // shape the Playwright path produces, so everything downstream — prose
    // merging, separator folding, layout — is shared.
    async axItems(frame) {
      return frame.evaluate(extractAxItems);
    },

    // Ours kept a reference, so there is no need to search by role and name:
    // the item says which node it came from.
    async axElementHandle(scope, item) {
      if (item.axIndex == null) {
        throw new Error('this line carries no element reference to activate');
      }
      return scope.evaluateHandle(
        (i) => (window.__twebAxNodes || [])[i], item.axIndex);
    },

    async close() {
      // End the session but leave the browser: Firefox serves one BiDi session
      // at a time and does not release it just because the socket went away,
      // so a session left hanging locks out the next reader entirely.
      await session.send('session.end', {}).catch(() => {});
      // Only a browser we started is ours to shut down, and browser.close is
      // "quit Firefox" — sending it after rejoining would take down a browser
      // somebody else is reading. Disconnecting is all a rejoining session
      // may do.
      session.close();
      if (child && !keepBrowser) {
        try { child.kill(); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = {
  openFirefox, FirefoxPage, FirefoxFrame, FirefoxHandle, FirefoxKeyboard,
  toRemoteArgument, WEBDRIVER_KEYS,
};
