'use strict';

// A WebDriver BiDi client, only as much of one as a reader needs.
//
// Firefox speaks this and nothing else — Mozilla removed CDP — and Playwright
// cannot attach to a Firefox you started yourself, only launch a patched
// build of its own. So this talks to the browser directly.
//
// The protocol is JSON over one WebSocket: commands carry an id and get a
// reply with the same id, and anything without an id is an event. That is the
// whole of it, which is why hand-rolling this is reasonable where hand-rolling
// CDP would not be.

const DEFAULT_TIMEOUT_MS = 30000;

class BidiError extends Error {}

class BidiSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new BidiError('the browser connection closed'));
      }
      this.pending.clear();
    });
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    // No id means an event: navigation, a log entry, a channel callback.
    if (message.id == null) {
      for (const handler of this.listeners.get(message.method) || []) {
        try { handler(message.params); } catch { /* a listener must not kill the socket */ }
      }
      return;
    }

    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.type === 'error') {
      waiter.reject(new BidiError(`${message.error}: ${message.message || ''}`.trim()));
    } else {
      waiter.resolve(message.result);
    }
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new BidiError('the browser connection closed'));
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BidiError(`${method} did not answer within ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  }

  close() {
    this.closed = true;
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

function connect(url, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* nothing to close */ }
      reject(new BidiError(`no BiDi endpoint answered at ${url} within ${timeout / 1000}s`));
    }, timeout);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(new BidiSession(socket)); });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new BidiError(`could not reach a BiDi endpoint at ${url}`));
    });
  });
}

// Turns BiDi's tagged values back into ordinary JavaScript. The protocol
// describes every result structurally — `{type: "string", value: "hi"}` —
// which is what lets it carry cycles and node references, and what makes it
// verbose to read.
function fromRemoteValue(value) {
  if (value == null) return null;
  switch (value.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string': case 'boolean': return value.value;
    case 'number':
      if (value.value === 'NaN') return NaN;
      if (value.value === 'Infinity') return Infinity;
      if (value.value === '-Infinity') return -Infinity;
      return value.value;
    case 'bigint': return BigInt(value.value);
    case 'array': case 'set':
      return (value.value || []).map(fromRemoteValue);
    case 'object': case 'map': {
      const out = {};
      for (const [key, item] of value.value || []) {
        out[typeof key === 'string' ? key : fromRemoteValue(key)] = fromRemoteValue(item);
      }
      return out;
    }
    default:
      // Nodes, windows, functions and anything else we cannot flatten. The
      // handle is what matters for those.
      return value.handle ? { handle: value.handle, sharedId: value.sharedId } : null;
  }
}

module.exports = { connect, BidiSession, BidiError, fromRemoteValue, DEFAULT_TIMEOUT_MS };
