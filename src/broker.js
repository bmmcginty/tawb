'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { waitForEndpoint, endpointReady, freePort } = require('./endpoint');
const { processAlive } = require('./proc');
const { log } = require('./log');

// One Firefox, more than one reader.
//
// Chromium's protocol takes as many clients as ask; every session opens its
// own connection to one browser and they coexist, kept off each other's tabs
// by the claims in session.js. Firefox does not: it serves exactly one
// WebDriver session per browser instance and publishes no way to join the one
// it has. A second connection is told "Session already started", a second
// session.new is refused with "Maximum number of active sessions", and the
// session's own websocket path is registered only for sessions created
// through the http flow, which a BiDi client does not use.
//
// But BiDi is JSON-RPC over one socket — a command carries an id, its reply
// carries the same id back, an event carries none — and that is multiplexable.
// This holds the one real session and serves as many local readers as ask for
// one, rewriting ids so replies find their way home. A reader runs the
// ordinary Firefox driver, pointed here rather than at Firefox, and nothing
// above the driver knows the difference.
//
// It reads as little of what it carries as it can. A snapshot comes back as a
// 97KB accessibility tree, and parsing every one of those to find its id costs
// about 7ms of a snapshot that takes 83ms; reading the id out of the head of
// the frame and forwarding the rest untouched costs nothing measurable.
// tools/brokerbench.js is that measurement.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BROKER_FILE = 'tawb-broker.json';

// How long the browser is held after the last reader leaves. Long enough to
// cover a reader restarting, short enough that a forgotten browser is not
// being held open by a process nobody can see.
const IDLE_EXIT_MS = 5000;
// And if the reader that started us never arrives at all.
const STARTUP_GRACE_MS = 30000;

// A challenge goes to whoever was doing something most recently.
//
// Intercepts belong to the session rather than to a connection, so a password
// challenge raised anywhere in the browser is one every reader could be told
// about. Telling all of them puts the same prompt on several terminals and
// has them race to answer it. Telling whoever claimed the tab sounds better
// and is not: a challenge can come from a subresource of a tab nobody has
// claimed, and then nobody answers at all — a request paused for ever, which
// is the one outcome that must not happen, because the browser's own dialog
// is gone the moment the interception is armed.
//
// The reader who typed something most recently is the one at the keyboard, so
// that is the one asked. With nobody listening the broker cancels the
// challenge itself: cancelling loads the 401's own body, and a page always
// beats a tab that never finishes.
const AUTH_EVENT = 'network.authRequired';

// --- the little of WebSocket this needs -------------------------------------

function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81; // FIN, text
  return Buffer.concat([head, payload]);
}

// A framed connection to one reader. Text frames in, text frames out; a ping
// answered, a close obeyed, and continuation frames joined, because a message
// here is routinely larger than anything one frame carries.
class Peer {
  constructor(socket, onText, onClose) {
    this.socket = socket;
    this.onText = onText;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    });
    socket.on('close', onClose);
    socket.on('error', onClose);
  }

  send(text) {
    try { this.socket.write(frame(text)); } catch { /* gone */ }
  }

  drain() {
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2)); at = 10;
      }
      let mask = null;
      if (masked) {
        if (b.length < at + 4) return;
        mask = b.subarray(at, at + 4); at += 4;
      }
      if (b.length < at + len) return;
      let payload = b.subarray(at, at + len);
      this.buffer = b.subarray(at + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      }
      if (opcode === 0x8) { try { this.socket.end(); } catch { /* gone */ } return; }
      if (opcode === 0x9) {
        try {
          this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        } catch { /* gone */ }
        continue;
      }
      if (opcode === 0x0 || opcode === 0x1) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.onText(text);
        }
      }
    }
  }
}

// Answers a WebSocket handshake and wraps what is left in a Peer. Exported
// because a test needs a browser to point the broker at, and the smallest
// honest one is a socket that speaks the same frames.
function acceptWebSocket(req, socket, onText, onClose) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  return new Peer(socket, onText, onClose);
}

// --- the multiplexer ---------------------------------------------------------

// Starts a broker in this process. `onIdle` is called when the last reader
// leaves, or when the first never arrives; the command-line entry point below
// uses it to exit.
function startBroker({
  upstream: upstreamUrl, port = 0, onIdle = null,
  idleMs = IDLE_EXIT_MS, graceMs = STARTUP_GRACE_MS,
} = {}) {
  const clients = new Set();
  let upstream = null;
  let upstreamReady = null;
  let nextUpstreamId = 1000000; // clear of anything a reader is likely to use
  const routes = new Map();     // our id -> the reader waiting for that reply
  let sessionResult = null;     // what session.new answered, replayed for later readers
  let everHadClient = false;
  let idleTimer = null;
  let closed = false;

  // Why the broker is being given up decides whether it may change its mind.
  // Nobody reading is a reason that a reader arriving undoes; the browser
  // having gone is not.
  const idle = () => {
    if (closed || !onIdle) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!clients.size) onIdle({ reason: 'idle' }); }, idleMs);
  };
  const graceTimer = onIdle ? setTimeout(() => {
    if (!everHadClient && !clients.size) onIdle({ reason: 'idle' });
  }, graceMs) : null;
  if (graceTimer && graceTimer.unref) graceTimer.unref();

  // Only the head of a frame is read, so that a reply carrying an entire
  // accessibility tree is forwarded rather than parsed.
  const idOf = (text) => {
    const found = /"id"\s*:\s*(\d+)/.exec(text.length > 200 ? text.slice(0, 200) : text);
    return found ? Number(found[1]) : null;
  };

  const mostRecentlyActive = (event) => {
    let best = null;
    for (const client of clients) {
      if (!client.subscribed.has(event) && !client.subscribed.has(event.split('.')[0])) continue;
      if (!best || client.activeAt > best.activeAt) best = client;
    }
    return best;
  };

  const cancelChallenge = (text) => {
    const found = /"request"\s*:\s*"([^"]+)"/.exec(text);
    if (!found || !upstream) return;
    log('broker.auth.cancelled', {});
    upstream.send(JSON.stringify({
      id: nextUpstreamId++,
      method: 'network.continueWithAuth',
      params: { request: found[1], action: 'cancel' },
    }));
  };

  const fromUpstream = (text) => {
    const id = idOf(text);
    if (id != null) {
      const route = routes.get(id);
      if (!route) return;
      routes.delete(id);
      // The reader's own id goes back on the message, in place of ours.
      route.client.peer.send(text.replace(/"id"\s*:\s*\d+/, `"id":${route.clientId}`));
      return;
    }

    const found = /"method"\s*:\s*"([^"]+)"/.exec(text.slice(0, 200));
    const method = found ? found[1] : null;

    if (method === AUTH_EVENT) {
      const asking = mostRecentlyActive(AUTH_EVENT);
      if (asking) asking.peer.send(text);
      else cancelChallenge(text);
      return;
    }

    const module = method ? method.split('.')[0] : null;
    for (const client of clients) {
      if (!method || client.subscribed.has(method) || client.subscribed.has(module)) {
        client.peer.send(text);
      }
    }
  };

  const connectUpstream = () => {
    if (upstreamReady) return upstreamReady;
    upstreamReady = new Promise((resolve, reject) => {
      const socket = new WebSocket(upstreamUrl);
      socket.addEventListener('open', () => { upstream = socket; resolve(socket); });
      socket.addEventListener('error', () => reject(new Error(`no browser at ${upstreamUrl}`)));
      socket.addEventListener('message', (event) => fromUpstream(String(event.data)));
      socket.addEventListener('close', () => {
        // The browser has gone. Nothing here can be served without it.
        log('broker.browser.gone', {});
        for (const client of clients) { try { client.peer.socket.end(); } catch { /* gone */ } }
        if (onIdle) onIdle({ reason: 'browser-gone' });
      });
    });
    return upstreamReady;
  };

  const fromClient = async (client, text) => {
    // Anything a reader sends is that reader being at the keyboard.
    client.activeAt = Date.now();

    let message;
    try { message = JSON.parse(text); } catch { return; }
    const { id, method, params } = message;

    // Answered here rather than upstream: every reader may have a session, so
    // every reader is told the browser is ready to give it one.
    if (method === 'session.status') {
      client.peer.send(JSON.stringify({ type: 'success', id, result: { ready: true, message: '' } }));
      return;
    }
    if (method === 'session.new' && sessionResult) {
      client.peer.send(JSON.stringify({ type: 'success', id, result: sessionResult }));
      return;
    }
    // One reader leaving is not the browser closing: session.end from any
    // connection deletes the session for everybody sharing it.
    if (method === 'session.end') {
      if (clients.size > 1) {
        client.peer.send(JSON.stringify({ type: 'success', id, result: {} }));
        return;
      }
      // The last reader out really does end it, so the yes we have been
      // replaying stops being true. A reader arriving in the seconds before we
      // give up must be given a new session, not the id of the one that has
      // just gone — which the browser would answer with "invalid session id"
      // for everything it was asked afterwards.
      sessionResult = null;
    }
    if (method === 'session.subscribe') {
      for (const event of (params && params.events) || []) client.subscribed.add(event);
    }

    const ours = nextUpstreamId++;
    routes.set(ours, { client, clientId: id });
    let socket;
    try {
      socket = await connectUpstream();
    } catch {
      routes.delete(ours);
      client.peer.send(JSON.stringify({
        type: 'error', id, error: 'unknown error', message: 'the browser is not there',
      }));
      return;
    }
    if (method === 'session.new' && !sessionResult) {
      // Remember what it answers, so the next reader gets the same yes.
      const capture = (event) => {
        const data = String(event.data);
        if (idOf(data) !== ours) return;
        socket.removeEventListener('message', capture);
        try { sessionResult = JSON.parse(data).result; } catch { /* not fatal */ }
      };
      socket.addEventListener('message', capture);
    }
    socket.send(text.replace(/"id"\s*:\s*\d+/, `"id":${ours}`));
  };

  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });

  server.on('upgrade', (req, socket) => {
    const client = { subscribed: new Set(), peer: null, activeAt: Date.now() };
    client.peer = acceptWebSocket(req, socket, (text) => { fromClient(client, text); }, () => {
      if (!clients.delete(client)) return;
      for (const [ours, route] of routes) if (route.client === client) routes.delete(ours);
      log('broker.reader.left', { readers: clients.size });
      if (!clients.size) idle();
    });
    clients.add(client);
    everHadClient = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    log('broker.reader.joined', { readers: clients.size });
  });

  const listening = new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

  return {
    listening,
    get clients() { return clients.size; },
    // Ends the shared session on the way out, so the next broker is not met by
    // a session Firefox is still holding for a client that has gone.
    async close({ endSession = true } = {}) {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (endSession && upstream) {
        try {
          upstream.send(JSON.stringify({ id: nextUpstreamId++, method: 'session.end', params: {} }));
        } catch { /* the browser is already gone */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (upstream) { try { upstream.close(); } catch { /* gone */ } }
      for (const client of clients) { try { client.peer.socket.end(); } catch { /* gone */ } }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- finding one, or starting one --------------------------------------------

// The broker is recorded beside the browser it serves, because that is what it
// belongs to: one per browser, found by any reader that joins that browser.

function brokerRecordPath(profileDir) {
  return path.join(profileDir, BROKER_FILE);
}

function readBrokerRecord(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(brokerRecordPath(profileDir), 'utf8'));
  } catch {
    return null;
  }
}

function clearBrokerRecord(profileDir) {
  try { fs.unlinkSync(brokerRecordPath(profileDir)); } catch { /* already gone */ }
}

// Written with wx, so that two readers starting at the same moment cannot both
// decide they are the one to start the browser's broker.
function claimBroker(profileDir, record) {
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(brokerRecordPath(profileDir), JSON.stringify(record), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

const brokerUrl = (port) => `ws://127.0.0.1:${port}/session`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// The broker for this browser: the one already running, or one started here.
async function ensureBroker({ profileDir, endpoint, log: logIt = () => {} }) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = readBrokerRecord(profileDir);
    if (record && record.upstream === endpoint && processAlive(record.pid)) {
      // It may still be opening its port; it was recorded before it answered.
      if (await waitForEndpoint(record.port, Date.now() + 10000)) {
        logIt('broker.joined', { port: record.port, pid: record.pid });
        return brokerUrl(record.port);
      }
    }
    if (record && !(processAlive(record.pid) && await endpointReady(record.port))) {
      clearBrokerRecord(profileDir);
    }

    const port = await freePort();
    if (!claimBroker(profileDir, { pid: process.pid, port, upstream: endpoint, at: Date.now() })) {
      await pause(150); // somebody else is starting it; wait and join theirs
      continue;
    }

    const child = spawn(process.execPath, [__filename, endpoint, String(port), profileDir], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    if (await waitForEndpoint(port, Date.now() + 15000)) {
      writeBrokerRecordFor(profileDir, { pid: child.pid, port, upstream: endpoint, at: Date.now() });
      logIt('broker.started', { port, pid: child.pid });
      return brokerUrl(port);
    }
    clearBrokerRecord(profileDir);
    throw new Error('the broker did not open its port');
  }
  throw new Error('could not reach a broker for this browser');
}

function writeBrokerRecordFor(profileDir, record) {
  try {
    fs.writeFileSync(brokerRecordPath(profileDir), JSON.stringify(record));
  } catch { /* a lost record costs a second broker, not a crash */ }
}

// --- as a program ------------------------------------------------------------

if (require.main === module) {
  const [upstream, port, profileDir] = process.argv.slice(2);
  const broker = startBroker({
    upstream,
    port: Number(port || 0),
    onIdle: async ({ reason = 'idle' } = {}) => {
      // The record goes first. A reader that arrives from here on starts a
      // broker of its own rather than joining one that is leaving — and the
      // gap between deciding to go and having gone is exactly when a reader
      // would otherwise connect to a socket about to close under it.
      if (profileDir) {
        const record = readBrokerRecord(profileDir);
        if (record && record.port === Number(port)) clearBrokerRecord(profileDir);
      }

      // The reprieve below is for having no readers, which a reader arriving
      // undoes. It is not for having no browser: a broker whose browser has
      // gone can serve nobody, and staying to be found again would hand the
      // next reader a broker that answers nothing — their session.new would
      // wait out its whole timeout against a socket that is never coming
      // back. That one leaves at once and lets the next reader start a
      // broker with a browser behind it.
      if (reason === 'idle') {
        await new Promise((r) => setTimeout(r, 250));
        if (broker.clients > 0) {
          // Somebody came in through that gap. Stay, and be findable again.
          if (profileDir) {
            writeBrokerRecordFor(profileDir, {
              pid: process.pid, port: Number(port), upstream, at: Date.now(),
            });
          }
          log('broker.idle.cancelled', { readers: broker.clients });
          return;
        }
      }

      log('broker.idle', { reason });
      await broker.close();
      process.exit(0);
    },
  });
  broker.listening.then((opened) => {
    log('broker.listening', { port: opened, upstream });
    // The prototype's readiness line, kept for tools/brokerbench.js.
    if (!process.stdout.isTTY) process.stdout.write(`${JSON.stringify({ ready: true, port: opened })}\n`);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, async () => { await broker.close(); process.exit(0); });
  }
}

module.exports = {
  startBroker, ensureBroker, readBrokerRecord, clearBrokerRecord, brokerRecordPath, brokerUrl,
  acceptWebSocket, IDLE_EXIT_MS,
};
