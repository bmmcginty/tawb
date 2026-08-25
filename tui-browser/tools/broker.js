'use strict';
// One BiDi session, many readers. A prototype.
//
// Firefox serves exactly one WebDriver session per browser instance and
// publishes no way to join the one it has: a second connection is told
// "Session already started", a second session.new is refused with "Maximum
// number of active sessions", the session id has no websocket path of its
// own, and the remote agent serves no http endpoints at all. Chromium's
// protocol is multi-client and needs none of this; Firefox's is not.
//
// But BiDi is JSON-RPC over one socket — commands carry an id, replies carry
// it back, events carry none — and that is multiplexable. This holds the one
// real session and serves as many local readers as ask for one, rewriting
// command ids so replies find their way home and fanning events out to
// whoever subscribed. A reader runs the ordinary Firefox driver, pointed here
// instead of at Firefox.
//
//   node tools/broker.js ws://127.0.0.1:PORT/session [listenPort] [--parse-all]
//
// Replies are routed by reading the id out of the head of the frame rather
// than parsing the message, because the message is frequently a 97KB
// accessibility tree and parsing every one of those costs about 7ms of a
// snapshot that takes 83ms. --parse-all is the comparison, not the intent.
//
// What it does not do yet, and what the design still has to answer:
//
//   * Nothing owns the broker's lifetime. It should start with the browser and
//     go when the last reader does, recorded in the endpoint record beside the
//     port and the Marionette port.
//   * A reader that dies mid-command leaves its route behind; routes are only
//     dropped when its socket closes.

const http = require('http');
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const upstreamUrl = process.argv[2];
const listenPort = Number(process.argv[3] || 0);
const PEEK = !process.argv.includes('--parse-all');

// --- the smallest WebSocket server that can carry this -----------------------

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
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, payload]);
}

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
      if (opcode === 0x9) { // ping
        try { this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); } catch { /* gone */ }
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

// --- the multiplexer ---------------------------------------------------------

const clients = new Set();

// A challenge goes to whoever was doing something most recently.
//
// Intercepts belong to the session rather than to a connection, so a password
// challenge raised anywhere in the browser is one every reader could be told
// about. Sending it to all of them would put the same prompt on several
// terminals and have them race to answer it. Sending it to whoever owns the
// tab sounds better and is not: a challenge can come from a subresource in a
// tab nobody has claimed, and then nobody would answer it at all — a request
// left paused for ever, which is the one outcome that must not happen.
//
// The reader who typed something most recently is the one at the keyboard, so
// that is the one asked. If nobody is subscribed to hear it, the broker
// cancels the challenge itself rather than leave it hanging: cancelling loads
// the 401's own body, and a page is always better than a tab that never
// finishes.
const AUTH_EVENT = 'network.authRequired';

function mostRecentlyActive(event) {
  let best = null;
  for (const client of clients) {
    if (!client.subscribed.has(event) && !client.subscribed.has(event.split('.')[0])) continue;
    if (!best || client.activeAt > best.activeAt) best = client;
  }
  return best;
}

function cancelChallenge(text) {
  const found = /"request"\s*:\s*"([^"]+)"/.exec(text);
  if (!found || !upstream) return;
  const id = nextUpstreamId++;
  upstream.send(JSON.stringify({
    id, method: 'network.continueWithAuth', params: { request: found[1], action: 'cancel' },
  }));
}
let upstream = null;
let upstreamReady = null;
let nextUpstreamId = 1000000; // clear of anything a client might use
const routes = new Map();     // upstream id -> { client, clientId }
let sessionResult = null;     // what session.new answered, replayed for later readers
const stats = { commands: 0, events: 0, bytesIn: 0 };

const idOf = (text) => {
  if (PEEK) {
    const head = text.length > 200 ? text.slice(0, 200) : text;
    const found = /"id"\s*:\s*(\d+)/.exec(head);
    if (found) return Number(found[1]);
    return null;
  }
  try { return JSON.parse(text).id ?? null; } catch { return null; }
};

function fromUpstream(text) {
  stats.bytesIn += text.length;
  const id = idOf(text);
  if (id != null) {
    const route = routes.get(id);
    if (!route) return;
    routes.delete(id);
    // The client's own id goes back on the message, in place of ours.
    route.client.peer.send(text.replace(/"id"\s*:\s*\d+/, `"id":${route.clientId}`));
    return;
  }
  stats.events += 1;
  // An event: everyone who asked for that module gets it.
  let method = null;
  const found = /"method"\s*:\s*"([^"]+)"/.exec(text.slice(0, 200));
  if (found) [, method] = found;
  const module = method ? method.split('.')[0] : null;

  // Except a password challenge, which goes to one reader only — see above.
  if (method === AUTH_EVENT) {
    const asking = mostRecentlyActive(AUTH_EVENT);
    if (asking) asking.peer.send(text);
    else cancelChallenge(text);
    return;
  }
  for (const client of clients) {
    if (!method || client.subscribed.has(method) || client.subscribed.has(module)) {
      client.peer.send(text);
    }
  }
}

async function connectUpstream() {
  if (upstreamReady) return upstreamReady;
  upstreamReady = new Promise((resolve, reject) => {
    const socket = new WebSocket(upstreamUrl);
    socket.addEventListener('open', () => { upstream = socket; resolve(socket); });
    socket.addEventListener('error', () => reject(new Error('no upstream')));
    socket.addEventListener('message', (event) => fromUpstream(String(event.data)));
    socket.addEventListener('close', () => {
      for (const client of clients) { try { client.peer.socket.end(); } catch { /* gone */ } }
    });
  });
  return upstreamReady;
}

async function fromClient(client, text) {
  stats.commands += 1;
  // Anything a reader sends is that reader being at the keyboard.
  client.activeAt = Date.now();
  let message;
  try { message = JSON.parse(text); } catch { return; }
  const { id, method, params } = message;

  // Answered here, not upstream: every reader believes it may have a session.
  if (method === 'session.status') {
    client.peer.send(JSON.stringify({ type: 'success', id, result: { ready: true, message: '' } }));
    return;
  }
  if (method === 'session.new') {
    if (sessionResult) {
      client.peer.send(JSON.stringify({ type: 'success', id, result: sessionResult }));
      return;
    }
  }
  if (method === 'session.end') {
    // One reader leaving is not the browser closing. Only the last one out
    // ends the session everybody is sharing.
    if (clients.size > 1) {
      client.peer.send(JSON.stringify({ type: 'success', id, result: {} }));
      return;
    }
  }
  if (method === 'session.subscribe') {
    for (const event of (params && params.events) || []) client.subscribed.add(event);
  }

  const ours = nextUpstreamId++;
  routes.set(ours, { client, clientId: id });
  const rewritten = text.replace(/"id"\s*:\s*\d+/, `"id":${ours}`);
  const socket = await connectUpstream();
  if (method === 'session.new' && !sessionResult) {
    // Remember what it answered, so the next reader gets the same yes.
    const capture = (event) => {
      const data = String(event.data);
      if (idOf(data) !== ours) return;
      socket.removeEventListener('message', capture);
      try { sessionResult = JSON.parse(data).result; } catch { /* not fatal */ }
    };
    socket.addEventListener('message', capture);
  }
  socket.send(rewritten);
}

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const client = { subscribed: new Set(), peer: null, activeAt: Date.now() };
  client.peer = new Peer(socket, (text) => fromClient(client, text), () => {
    clients.delete(client);
    for (const [ours, route] of routes) if (route.client === client) routes.delete(ours);
  });
  clients.add(client);
});

server.listen(listenPort, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ ready: true, port, peek: PEEK }));
});

process.on('SIGTERM', () => {
  console.log(JSON.stringify({ stats }));
  process.exit(0);
});
