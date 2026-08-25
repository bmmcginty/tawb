'use strict';

const { CdpError } = require('./cdp');

// Browser, context, page, frame and handle, built on the DevTools protocol.
//
// These deliberately imitate the shape of the Playwright objects the rest of
// this program already talks to — url, goto, evaluate, frames, mainFrame,
// $$, contentFrame, dispose — for the same reason driver_firefox.js does:
// that shape is the contract, and reimplementing it is far less work than
// teaching every view about a third kind of browser. Only the subset actually
// used is here; anything missing throws rather than quietly returning
// nothing, so a gap shows up as an error naming itself.
//
// Two things are worth knowing before reading further.
//
// **A frame is not always answered by the tab's session.** A cross-origin
// iframe in Chrome is a separate process and a separate target, with a
// session of its own. This is the one piece of Playwright's Chromium support
// that was genuinely load-bearing, and it is handled here by auto-attaching
// to those targets and letting each frame say which session answers for it.
// A same-process frame is answered by the tab's own session.
//
// **Coordinates are always the top-level viewport's.** DOM.getContentQuads
// reports in main-frame coordinates whichever session is asked, so a click on
// an element inside an out-of-process iframe is dispatched on the tab's
// session at the coordinates that came back, with no offset arithmetic. The
// one exception is clickInFrame, which is aiming at a point inside a
// document's own viewport by construction and dispatches on that document's
// session.

// How long to wait for a document's execution context to appear. A context is
// announced rather than asked for, so the first evaluate after a navigation
// can arrive a few milliseconds before the announcement does.
//
// This must stay well under frames.js's FRAME_BUDGET_MS. A frame that never
// answers is given that budget and no more, so a wait longer than the budget
// means every such frame costs the whole of it — which is how one page with
// six dead tracking iframes produced a twenty-second snapshot.
const CONTEXT_WAIT_MS = 2000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;

// Playwright takes a function or a string; CDP takes a function declaration.
function asFunctionDeclaration(fn) {
  if (typeof fn === 'function') return fn.toString();
  // A bare expression, which is what `evaluate('1 + 1')` means.
  return `() => { return (${fn}); }`;
}

// The page's own name for a value we are handing it. Everything passed from
// here is JSON — an index, a flag, a selector — so there is nothing cleverer
// to do, and a value CDP cannot carry should say so rather than arrive as
// undefined.
function toCallArgument(value) {
  if (value === undefined) return { value: undefined };
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { unserializableValue: String(value) };
  }
  return { value };
}

function throwOnException(result, what) {
  if (!result.exceptionDetails) return;
  const details = result.exceptionDetails;
  const text = (details.exception && (details.exception.description || details.exception.value))
    || details.text || `the page threw while ${what}`;
  throw new Error(String(text).split('\n')[0]);
}

// A JavaScript object living in the page, held by reference.
class CdpHandle {
  constructor(frame, objectId) {
    this.frame = frame;
    this.objectId = objectId;
    this.disposed = false;
  }

  #session() {
    return this.frame.session();
  }

  // The handle is the function's first argument, as Playwright has it, not
  // its `this`. Callers are written `(el, arg) => ...` and stay that way.
  async evaluate(fn, arg) {
    const args = arg === undefined ? [] : [toCallArgument(arg)];
    const result = await this.#session().send('Runtime.callFunctionOn', {
      objectId: this.objectId,
      functionDeclaration: `function (...rest) { return (${asFunctionDeclaration(fn)})(this, ...rest); }`,
      arguments: args,
      returnByValue: true,
      awaitPromise: true,
    });
    throwOnException(result, 'evaluating against an element');
    return result.result.value;
  }

  async evaluateHandle(fn, arg) {
    const args = arg === undefined ? [] : [toCallArgument(arg)];
    const result = await this.#session().send('Runtime.callFunctionOn', {
      objectId: this.objectId,
      functionDeclaration: `function (...rest) { return (${asFunctionDeclaration(fn)})(this, ...rest); }`,
      arguments: args,
      awaitPromise: true,
    });
    throwOnException(result, 'evaluating against an element');
    return new CdpHandle(this.frame, result.result.objectId);
  }

  // The document inside this element, when this element is a frame. The
  // protocol answers directly, which is the one place Chrome is kinder than
  // BiDi — Firefox has to match the Nth frame element to the Nth child
  // context by position.
  async contentFrame() {
    const described = await this.#session()
      .send('DOM.describeNode', { objectId: this.objectId })
      .catch(() => null);
    const frameId = described && described.node && described.node.frameId;
    if (!frameId) return null;
    return this.frame.pageObject.frameById(frameId) || null;
  }

  // Where the element is on screen, in the top-level viewport's coordinates,
  // having first been brought there. Null when it has no box to click.
  async clickPoint() {
    const session = this.#session();
    await session.send('DOM.scrollIntoViewIfNeeded', { objectId: this.objectId })
      .catch(() => { /* an element with no box; getContentQuads says so next */ });
    const got = await session.send('DOM.getContentQuads', { objectId: this.objectId })
      .catch(() => null);
    const quads = (got && got.quads) || [];
    for (const quad of quads) {
      // A quad is eight numbers: four corners, clockwise from the top left.
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      if (width < 1 || height < 1) continue;
      return {
        x: Math.round(xs.reduce((a, b) => a + b, 0) / 4),
        y: Math.round(ys.reduce((a, b) => a + b, 0) / 4),
      };
    }
    return null;
  }

  // A click the browser accounts a person's: real input dispatched above
  // content, so the events are trusted and carry user activation.
  async click() {
    const at = await this.clickPoint();
    if (!at) throw new Error('that element has no box on screen to click');
    await this.frame.pageObject.clickAt(at.x, at.y);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.#session()
      .send('Runtime.releaseObject', { objectId: this.objectId })
      .catch(() => { /* the page went away and took it with it */ });
  }
}

class CdpFrame {
  constructor(pageObject, frameId, parentId = null) {
    this.pageObject = pageObject;
    this.frameId = frameId;
    this.parentId = parentId;
    this._url = 'about:blank';
    // Set when this frame is the root of a target of its own — a cross-origin
    // iframe. Everything below it inherits the answer by walking up.
    this._ownSession = null;
  }

  url() {
    return this._url;
  }

  // Playwright spells this as a method, and frames.js relies on the
  // difference: `frame.page.noteFrame` is how it tells an engine that
  // rebuilds frame objects per snapshot from one that keeps a live tree.
  // Ours is a live tree, so this must stay a method.
  page() {
    return this.pageObject;
  }

  // Whether this document had a process of its own and that process has gone.
  //
  // Final, and worth asking before waiting for anything: a target that has
  // detached will never announce another execution context, so waiting for
  // one is waiting for something that cannot happen.
  ownTargetGone() {
    return !!(this._ownSession && this._ownSession.detached);
  }

  // The session that answers for this document.
  session() {
    let frame = this;
    while (frame) {
      if (frame._ownSession && !frame._ownSession.detached) return frame._ownSession;
      frame = frame.parentId ? this.pageObject.frameById(frame.parentId) : null;
    }
    return this.pageObject.session;
  }

  // Whether that session belongs to this document alone. A session of a
  // frame's own answers for that document and nothing else; the tab's session
  // answers for every same-process document in it, which is why anything
  // reading a pierced node tree has to know which it is holding.
  ownTarget() {
    return !!(this._ownSession && !this._ownSession.detached);
  }

  async #call(params, what) {
    const context = await this.pageObject.contextFor(this.frameId);
    try {
      return await context.session.send('Runtime.callFunctionOn', {
        ...params, executionContextId: context.id,
      });
    } catch (err) {
      // The document was replaced between looking the context up and using
      // it, which on a page that reloads under the reader is ordinary rather
      // than exceptional. Ask again for the context now current.
      if (!/Cannot find context|Execution context was destroyed/i.test(String(err.message))) throw err;
      this.pageObject.forgetContext(this.frameId, context.id);
      const fresh = await this.pageObject.contextFor(this.frameId);
      return fresh.session.send('Runtime.callFunctionOn', {
        ...params, executionContextId: fresh.id,
      });
    }
  }

  async evaluate(fn, arg) {
    const result = await this.#call({
      functionDeclaration: asFunctionDeclaration(fn),
      arguments: arg === undefined ? [] : [toCallArgument(arg)],
      returnByValue: true,
      awaitPromise: true,
    }, 'evaluating');
    throwOnException(result, 'evaluating');
    return result.result.value;
  }

  async evaluateHandle(fn, arg) {
    const result = await this.#call({
      functionDeclaration: asFunctionDeclaration(fn),
      arguments: arg === undefined ? [] : [toCallArgument(arg)],
      awaitPromise: true,
    }, 'evaluating');
    throwOnException(result, 'evaluating');
    return new CdpHandle(this, result.result.objectId);
  }

  // Only ever called for frame elements, and what the caller needs from each
  // is its child document.
  async $$(selector) {
    const list = await this.evaluateHandle(
      (sel) => Array.from(document.querySelectorAll(sel)), selector);
    try {
      const { result } = await this.session().send('Runtime.getProperties', {
        objectId: list.objectId, ownProperties: true,
      });
      const handles = [];
      for (const property of result) {
        if (!/^\d+$/.test(property.name)) continue;
        const objectId = property.value && property.value.objectId;
        if (objectId) handles.push(new CdpHandle(this, objectId));
      }
      return handles;
    } finally {
      await list.dispose();
    }
  }

  // The child documents of this one, in the order the browser reports them,
  // which is document order.
  childFrames() {
    return this.pageObject.childFramesOf(this.frameId);
  }
}

// Keys as CDP wants them: a virtual key code, a physical code, and the text
// the key inserts. Only the keys this program actually presses are here, and
// an unknown one says so rather than being sent as something else.
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};

const MODIFIERS = {
  Alt: { bit: 1, key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Control: { bit: 2, key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Meta: { bit: 4, key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  Shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
};

// The physical key a printable character sits on, for the pages that read
// event.code. Beyond the ASCII keyboard there is no honest answer and an
// empty string is what Playwright reports too.
function codeForCharacter(character) {
  if (character >= 'a' && character <= 'z') return `Key${character.toUpperCase()}`;
  if (character >= 'A' && character <= 'Z') return `Key${character}`;
  if (character >= '0' && character <= '9') return `Digit${character}`;
  if (character === ' ') return 'Space';
  return '';
}

// Typing, through the browser's own input pipeline.
//
// This is the piece that cannot be faked from inside the page: a
// script-dispatched KeyboardEvent is untrusted and inserts no text, which is
// why a WebExtension could never do this and why the protocol is load-bearing
// rather than a convenience.
class CdpKeyboard {
  constructor(pageObject) {
    this.pageObject = pageObject;
  }

  #send(params) {
    return this.pageObject.session.send('Input.dispatchKeyEvent', params);
  }

  async type(text) {
    // Spread rather than split: a character outside the basic plane is two
    // code units and one keystroke.
    for (const character of String(text)) {
      const common = {
        key: character,
        code: codeForCharacter(character),
        windowsVirtualKeyCode: character.toUpperCase().charCodeAt(0) || 0,
      };
      // text on the keyDown is what makes the browser insert the character
      // and raise keypress and input alongside it.
      await this.#send({
        ...common, type: 'keyDown', text: character, unmodifiedText: character,
      });
      await this.#send({ ...common, type: 'keyUp' });
    }
  }

  async press(key) {
    const parts = String(key).split('+');
    const target = parts.pop();
    const held = parts.map((name) => {
      const modifier = MODIFIERS[name];
      if (!modifier) throw new Error(`the Chromium driver has no modifier named "${name}"`);
      return modifier;
    });

    const definition = KEYS[target]
      || (MODIFIERS[target] && { ...MODIFIERS[target] })
      || ([...target].length === 1
        ? { key: target, code: codeForCharacter(target), keyCode: target.toUpperCase().charCodeAt(0), text: target }
        : null);
    if (!definition) throw new Error(`the Chromium driver has no key named "${key}"`);

    let modifiers = 0;
    for (const modifier of held) {
      modifiers |= modifier.bit;
      await this.#send({
        type: 'keyDown',
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        modifiers,
      });
    }

    // A modified key inserts nothing — Control+Backspace is a command, not a
    // character — which is what the browser expects to see as well.
    const text = modifiers & ~MODIFIERS.Shift.bit ? undefined : definition.text;
    const base = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      modifiers,
    };
    await this.#send({
      ...base, type: 'keyDown', ...(text ? { text, unmodifiedText: text } : {}),
    });
    await this.#send({ ...base, type: 'keyUp' });

    for (const modifier of [...held].reverse()) {
      modifiers &= ~modifier.bit;
      await this.#send({
        type: 'keyUp',
        key: modifier.key,
        code: modifier.code,
        windowsVirtualKeyCode: modifier.keyCode,
        modifiers,
      });
    }
  }
}

const LIFECYCLE = {
  load: 'load',
  domcontentloaded: 'DOMContentLoaded',
  networkidle: 'networkIdle',
};

class CdpPage {
  constructor(browserContext, session, targetId) {
    this.browserContext = browserContext;
    this.session = session;
    this.targetId = targetId;
    this.keyboard = new CdpKeyboard(this);

    this.frames_ = new Map();
    this.contexts = new Map();
    this.mainFrameId = null;
    this.reached = new Set();
    this._closed = false;
    // Set by the context once the frame tree and execution contexts are
    // known; until then this page cannot answer for its own main frame.
    this.wired = false;
    this.ready = Promise.resolve();
    this.handlers = new Map();
    this.navigationTimeout = DEFAULT_NAVIGATION_TIMEOUT_MS;
    this.defaultTimeout = DEFAULT_NAVIGATION_TIMEOUT_MS;
    // Sessions wired for this tab: its own plus one per out-of-process
    // iframe, so they can all be let go of together.
    this.sessions = new Set();
  }

  // ---------------------------------------------------------------------
  // Frames

  frameById(frameId) {
    return this.frames_.get(frameId) || null;
  }

  ensureFrame(frameId, parentId = null) {
    let frame = this.frames_.get(frameId);
    if (!frame) {
      frame = new CdpFrame(this, frameId, parentId);
      this.frames_.set(frameId, frame);
    } else if (parentId && !frame.parentId) {
      frame.parentId = parentId;
    }
    return frame;
  }

  removeFrame(frameId) {
    this.dropChildrenOf(frameId);
    this.frames_.delete(frameId);
    this.contexts.delete(frameId);
  }

  // Everything below this document belonged to the document it just
  // replaced. Without this a page keeps every frame it has ever had: after
  // one navigation on a school district's site the map held eleven frames
  // from the page before, each in a process that had gone, and each cost a
  // snapshot the full frame budget before giving up.
  dropChildrenOf(frameId) {
    for (const frame of [...this.frames_.values()]) {
      if (frame.parentId === frameId) this.removeFrame(frame.frameId);
    }
  }

  // A target of ours has gone. Whatever it was answering for goes with it,
  // rather than lingering as a document nothing can ever run in.
  dropSession(session) {
    this.sessions.delete(session);
    this.forgetContextsOf(session);
    for (const frame of [...this.frames_.values()]) {
      if (frame._ownSession === session) this.removeFrame(frame.frameId);
    }
  }

  mainFrame() {
    return this.ensureFrame(this.mainFrameId || 'main');
  }

  frames() {
    const main = this.mainFrame();
    return [main, ...[...this.frames_.values()].filter((frame) => frame !== main)];
  }

  childFramesOf(frameId) {
    return [...this.frames_.values()].filter((frame) => frame.parentId === frameId);
  }

  // ---------------------------------------------------------------------
  // Execution contexts
  //
  // A document's context is announced rather than asked for, so it is
  // recorded as it arrives and looked up when something needs to run. Only
  // the default world is kept: an isolated world would not see the page's own
  // globals, and everything this program evaluates is about the page's own
  // state.

  noteContext(session, context) {
    const auxiliary = context.auxData || {};
    if (!auxiliary.isDefault || !auxiliary.frameId) return;
    this.ensureFrame(auxiliary.frameId);
    this.contexts.set(auxiliary.frameId, { id: context.id, session });
  }

  forgetContext(frameId, contextId) {
    const known = this.contexts.get(frameId);
    if (known && known.id === contextId) this.contexts.delete(frameId);
  }

  // An execution context id is a counter within one session, not a name that
  // means anything on its own. Two sessions on the same tab — the tab's and a
  // cross-origin iframe's — hand out the same small numbers, so a destroyed
  // context must be matched on the session that destroyed it as well as on
  // the number. Matching on the number alone quietly deleted the main
  // document's context whenever an ad iframe's process happened to be using
  // the same one, and everything in that tab then waited out its timeout.
  forgetContextById(session, contextId) {
    for (const [frameId, known] of this.contexts) {
      if (known.session === session && known.id === contextId) this.contexts.delete(frameId);
    }
  }

  forgetContextsOf(session) {
    for (const [frameId, known] of this.contexts) {
      if (known.session === session) this.contexts.delete(frameId);
    }
  }

  async contextFor(frameId) {
    const deadline = Date.now() + CONTEXT_WAIT_MS;
    for (;;) {
      const known = this.contexts.get(frameId);
      if (known && !known.session.detached) return known;
      // Recorded against a session that has gone. It will not answer, and
      // keeping it would hide a replacement if one arrives.
      if (known) this.contexts.delete(frameId);

      // The three ways this can never succeed, asked before waiting rather
      // than discovered by waiting.
      if (this._closed) throw new CdpError('that tab has closed');
      const frame = this.frames_.get(frameId);
      if (!frame) throw new CdpError('that document is no longer in the page');
      if (frame.ownTargetGone()) throw new CdpError('that document\'s process has gone');

      if (Date.now() >= deadline) {
        throw new CdpError('that document never announced a context to run in');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // ---------------------------------------------------------------------
  // The Playwright-shaped surface

  context() {
    return this.browserContext;
  }

  url() {
    return this.mainFrame().url();
  }

  isClosed() {
    return this._closed;
  }

  setUrl(url) {
    this.mainFrame()._url = url;
  }

  async title() {
    return this.evaluate(() => document.title).catch(() => '');
  }

  evaluate(fn, arg) {
    return this.mainFrame().evaluate(fn, arg);
  }

  evaluateHandle(fn, arg) {
    return this.mainFrame().evaluateHandle(fn, arg);
  }

  setDefaultTimeout(ms) {
    this.defaultTimeout = ms;
  }

  setDefaultNavigationTimeout(ms) {
    this.navigationTimeout = ms;
  }

  on(event, handler) {
    if (!['framenavigated', 'close'].includes(event)) {
      throw new Error(`the Chromium driver does not report "${event}"`);
    }
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  once(event, handler) {
    const wrapped = (...args) => {
      const list = this.handlers.get(event) || [];
      const at = list.indexOf(wrapped);
      if (at >= 0) list.splice(at, 1);
      handler(...args);
    };
    return this.on(event, wrapped);
  }

  emit(event, ...args) {
    for (const handler of [...(this.handlers.get(event) || [])]) {
      try { handler(...args); } catch { /* a handler must not break navigation */ }
    }
  }

  async goto(url, { waitUntil = 'load', timeout = this.navigationTimeout } = {}) {
    const wanted = LIFECYCLE[waitUntil] || 'load';
    const settled = this.#awaitLifecycle(wanted, timeout);
    let result;
    try {
      result = await this.session.send('Page.navigate', {
        url, ...(this.mainFrameId ? { frameId: this.mainFrameId } : {}),
      });
    } catch (err) {
      settled.cancel();
      throw err;
    }
    if (result.errorText && result.errorText !== 'net::ERR_ABORTED') {
      settled.cancel();
      throw new Error(`${url} could not be loaded: ${result.errorText}`);
    }
    // No loader means the document did not change — a fragment link — and
    // there is no lifecycle to wait for.
    if (!result.loaderId) {
      settled.cancel();
      return null;
    }
    await settled.promise;
    return null;
  }

  async goBack({ waitUntil = 'load', timeout = this.navigationTimeout } = {}) {
    const history = await this.session.send('Page.getNavigationHistory');
    const previous = history.entries[history.currentIndex - 1];
    if (!previous) return null;
    const settled = this.#awaitLifecycle(LIFECYCLE[waitUntil] || 'load', timeout);
    try {
      await this.session.send('Page.navigateToHistoryEntry', { entryId: previous.id });
    } catch (err) {
      settled.cancel();
      throw err;
    }
    await settled.promise;
    return null;
  }

  // Playwright's semantics, deliberately: a page that has already reached the
  // state resolves at once. Callers race this against the action that might
  // navigate, so making it wait for a navigation that never starts would put
  // that wait on the price of every click.
  async waitForLoadState(state = 'load', { timeout = this.navigationTimeout } = {}) {
    const wanted = LIFECYCLE[state] || 'load';
    if (this.reached.has(wanted)) return;
    await this.#awaitLifecycle(wanted, timeout).promise.catch(() => {});
  }

  // A promise for the tab's document reaching `name`, armed before whatever
  // is going to cause it. `cancel` is for the caller who then discovers there
  // will be no navigation after all: it settles the promise and takes the
  // listener and the timer back off, so nothing is left counting down.
  #awaitLifecycle(name, timeout) {
    let stop = () => {};
    let cancel = () => {};
    const promise = new Promise((resolve, reject) => {
      cancel = () => stop(resolve);
      const onEvent = (params) => {
        // Only the tab's own document. A frame reaching DOMContentLoaded says
        // nothing about whether the page has.
        if (params.frameId === this.mainFrameId && params.name === name) stop(resolve);
      };
      const timer = setTimeout(() => stop(() => {
        reject(new CdpError(`the page did not reach ${name} within ${timeout / 1000}s`));
      }), timeout);
      stop = (settle) => {
        stop = () => {};
        clearTimeout(timer);
        this.session.off('Page.lifecycleEvent', onEvent);
        settle();
      };
      this.session.on('Page.lifecycleEvent', onEvent);
    });
    return { promise, cancel };
  }

  async waitForFunction(fn, arg, { timeout = this.defaultTimeout, polling = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await this.evaluate(fn, arg).catch(() => false)) return true;
      if (Date.now() >= deadline) throw new CdpError('waitForFunction timed out');
      await new Promise((resolve) => setTimeout(resolve, polling));
    }
  }

  // A real click at a point in the top-level viewport. Moved to, then
  // pressed, then released, with the button state each event should carry: a
  // bare press and release with no movement before it is not what a mouse
  // produces, and the places this matters are precisely where something is
  // watching how the click was made.
  async clickAt(x, y, session = this.session) {
    const at = { x: Math.round(x), y: Math.round(y) };
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, buttons: 0 });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1,
    });
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  async close() {
    if (this._closed) return;
    await this.browserContext.closePage(this);
  }

  // Called by the context when the target really has gone.
  markClosed() {
    if (this._closed) return;
    this._closed = true;
    this.contexts.clear();
    this.emit('close', this);
  }
}

module.exports = {
  CdpPage, CdpFrame, CdpHandle, CdpKeyboard,
  asFunctionDeclaration, codeForCharacter, toCallArgument,
  KEYS, MODIFIERS, LIFECYCLE, CONTEXT_WAIT_MS,
};
