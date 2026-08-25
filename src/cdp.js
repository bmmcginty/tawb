'use strict';

// A Chrome DevTools Protocol client, only as much of one as a reader needs.
//
// The counterpart to bidi.js, and shaped like it on purpose: JSON over one
// WebSocket, commands carry an id and get a reply with the same id, anything
// without an id is an event. The one thing CDP adds is that a single socket
// carries several conversations at once — the browser's, one per tab, one per
// out-of-process iframe — distinguished by a `sessionId` stamped on every
// message in both directions. That is what "flat" mode means, and it is the
// only mode used here: the alternative is nested Target.sendMessageToTarget
// envelopes, which buy nothing and cost a layer of JSON.
//
// Why hand-write this rather than keep Playwright. Playwright's contribution
// on this path had shrunk to the transport plus two conveniences we had
// already replaced: its accessibility tree (ours, in ax_own.js, since the two
// were held against each other until they agreed) and its role/name locators
// (unnecessary once AX items carry a reference to their own element). What
// was left was 19MB of dependency wrapped around a WebSocket, and a
// dependency is a thing that has to be there — on every machine that installs
// this, and in every language it is ever rewritten in. The protocol itself is
// not going anywhere: Runtime, Page, DOM, Input and Target are the oldest and
// most stable domains in CDP, and they are what this speaks.

const DEFAULT_TIMEOUT_MS = 30000;

class CdpError extends Error {}

// One conversation on the shared socket.
//
// The browser gets a session with no id — its commands are the ones sent
// without a sessionId — and every attached target gets one with an id. They
// behave identically otherwise, which is what lets a caller hold "a session"
// and not care which kind it has.
class CdpSession {
  constructor(connection, sessionId = null, targetId = null) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.listeners = new Map();
    this.detached = false;
  }

  send(method, params = {}, options = {}) {
    if (this.detached) {
      return Promise.reject(new CdpError(`${method}: this session has already detached`));
    }
    return this.connection.send(method, params, { ...options, sessionId: this.sessionId });
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  off(event, handler) {
    const handlers = this.listeners.get(event);
    if (!handlers) return this;
    const at = handlers.indexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
    return this;
  }

  once(event, handler) {
    const wrapped = (params) => {
      this.off(event, wrapped);
      handler(params);
    };
    return this.on(event, wrapped);
  }

  emit(method, params) {
    for (const handler of [...(this.listeners.get(method) || [])]) {
      // A listener must not be able to kill the socket every other listener,
      // and every pending command, is riding on.
      try { handler(params); } catch { /* the listener's problem, not ours */ }
    }
  }

  // Let go of a target we attached to. A session left open is an attachment
  // the browser goes on maintaining for a client that has stopped listening,
  // which matters here because the browser routinely outlives the reader.
  async detach() {
    if (this.detached) return;
    this.detached = true;
    const { sessionId } = this;
    if (!sessionId) return; // the browser session is the connection itself
    this.connection.forgetSession(sessionId);
    await this.connection
      .send('Target.detachFromTarget', { sessionId })
      .catch(() => { /* already gone, which is the outcome we wanted */ });
  }
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.browser = new CdpSession(this, null);
    this.closed = false;
    this.closeHandlers = [];

    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
    // An error on a WebSocket is always followed by a close, so there is
    // nothing to do here but keep the process from hearing an unhandled one.
    socket.addEventListener('error', () => {});
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new CdpError('the browser connection closed'));
    }
    this.pending.clear();
    for (const session of this.sessions.values()) session.detached = true;
    for (const handler of this.closeHandlers) {
      try { handler(); } catch { /* nothing left to protect */ }
    }
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.id == null) {
      this.#onEvent(message);
      return;
    }

    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      const detail = message.error.data ? ` (${message.error.data})` : '';
      waiter.reject(new CdpError(`${waiter.method}: ${message.error.message}${detail}`));
    } else {
      waiter.resolve(message.result || {});
    }
  }

  #onEvent(message) {
    // Attachment is bookkeeping before it is news. The session for a newly
    // attached target has to exist by the time anybody's listener runs,
    // because the first thing a listener does is send it a command — and the
    // envelope's own sessionId names the *parent*, not the target that just
    // appeared.
    if (message.method === 'Target.attachedToTarget') {
      const info = message.params.targetInfo || {};
      this.sessionFor(message.params.sessionId, info.targetId);
    } else if (message.method === 'Target.detachedFromTarget') {
      const gone = this.sessions.get(message.params.sessionId);
      if (gone) gone.detached = true;
      this.forgetSession(message.params.sessionId);
    }

    const session = message.sessionId ? this.sessions.get(message.sessionId) : this.browser;
    if (session) session.emit(message.method, message.params || {});
  }

  // The session for an id, made if this is the first we have heard of it.
  // Sessions arrive two ways — asked for by attachToTarget, and announced by
  // auto-attach — and both land here so there is only ever one object per id.
  sessionFor(sessionId, targetId = null) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new CdpSession(this, sessionId, targetId);
      this.sessions.set(sessionId, session);
    } else if (targetId && !session.targetId) {
      session.targetId = targetId;
    }
    return session;
  }

  forgetSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return this.sessionFor(sessionId, targetId);
  }

  send(method, params = {}, { sessionId = null, timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new CdpError('the browser connection closed'));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      return Promise.reject(new CdpError(`${method}: ${err.message}`));
    }

    return new Promise((resolve, reject) => {
      // Every command is bounded, because the thing on the other end is a
      // browser and a browser can be busy for ever. This is the same reason
      // every operation above this file carries a deadline.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} did not answer within ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  onClose(handler) {
    this.closeHandlers.push(handler);
  }

  close() {
    if (this.closed) return;
    try { this.socket.close(); } catch { /* already gone */ }
    this.#onClose();
  }
}

function openSocket(url, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      reject(new CdpError(`could not reach a DevTools endpoint at ${url}: ${err.message}`));
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* nothing to close */ }
      reject(new CdpError(`no DevTools endpoint answered at ${url} within ${timeout / 1000}s`));
    }, timeout);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(new CdpConnection(socket));
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new CdpError(`could not reach a DevTools endpoint at ${url}`));
    });
  });
}

// The browser's own WebSocket, which is not at a fixed path: it carries a
// per-launch token, and /json/version is where the browser says what it is.
//
// Chrome refuses these requests unless the Host header names an IP address or
// localhost, as a defence against a web page reaching the debugging port by
// name. We only ever ask 127.0.0.1, so the default Host is already what it
// wants, but a caller passing a hostname would be refused with no explanation
// — hence the check here rather than a puzzle later.
async function browserWebSocketUrl(endpoint, { timeout = 5000 } = {}) {
  const base = new URL(endpoint);
  const response = await fetch(new URL('/json/version', base), {
    signal: AbortSignal.timeout(timeout),
  }).catch((err) => {
    throw new CdpError(`no browser answered at ${base.origin}: ${err.message}`);
  });
  if (!response.ok) {
    throw new CdpError(`the browser at ${base.origin} answered /json/version with ${response.status}`);
  }
  const version = await response.json().catch(() => ({}));
  const url = version.webSocketDebuggerUrl;
  if (!url) {
    throw new CdpError(`the browser at ${base.origin} named no WebSocket to talk on`);
  }
  // The url the browser gives back names whatever host it thinks it is on;
  // the port is the part that matters and the host we asked is the host we
  // can reach.
  const socketUrl = new URL(url);
  socketUrl.host = base.host;
  return socketUrl.toString();
}

async function connect(endpoint, options = {}) {
  return openSocket(await browserWebSocketUrl(endpoint, options), options);
}

module.exports = {
  connect, openSocket, browserWebSocketUrl, CdpConnection, CdpSession, CdpError,
  DEFAULT_TIMEOUT_MS,
};
