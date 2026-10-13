'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const javascript = require('../src/bidi');
const { acceptWebSocket } = require('../src/broker');
const { bidiImplementations } = require('./crystal_impl');

async function withEndpoint(onMessage, run) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    let peer;
    peer = acceptWebSocket(request, socket, (text) => {
      onMessage(JSON.parse(text), peer);
    }, () => {});
    if (head.length) peer.consume(head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`ws://127.0.0.1:${port}/session`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const implementation of bidiImplementations(javascript)) {
  test(`${implementation.name}: BiDi commands route replies and preserve queued events`, async () => {
    const received = [];
    const actions = [
      { type: 'command', method: 'session.status', params: { detail: true } },
      { type: 'event', method: 'wanted.event' },
      { type: 'event', method: 'other.event' },
      { type: 'command', method: 'browsingContext.getTree', params: {} },
    ];
    const values = await withEndpoint((message, peer) => {
      received.push(message);
      if (message.id === 1) {
        peer.send(JSON.stringify({ method: 'other.event', params: { order: 1 } }));
        peer.send(JSON.stringify({ id: 1001, type: 'success', result: { ignored: true } }));
        peer.send(JSON.stringify({ method: 'wanted.event', params: { order: 2 } }));
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: { ready: true } }));
      } else {
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: { contexts: [] } }));
      }
    }, (url) => implementation.sessionScenario(url, actions));

    assert.deepEqual(received, [
      { id: 1, method: 'session.status', params: { detail: true } },
      { id: 2, method: 'browsingContext.getTree', params: {} },
    ]);
    assert.deepEqual(values, [
      { result: { ready: true } },
      { event: { order: 2 } },
      { event: { order: 1 } },
      { result: { contexts: [] } },
    ]);
  });

  test(`${implementation.name}: BiDi protocol errors reject the matching command`, async () => {
    const values = await withEndpoint((message, peer) => {
      peer.send(JSON.stringify({
        id: message.id,
        type: 'error',
        error: 'invalid argument',
        message: 'bad context',
      }));
    }, (url) => implementation.sessionScenario(url, [
      { type: 'command', method: 'browsingContext.navigate', params: { context: 'missing' } },
    ]));

    assert.deepEqual(values, [{ error: 'invalid argument: bad context' }]);
  });

  test(`${implementation.name}: an unanswered BiDi command times out without closing the session`, async () => {
    const values = await withEndpoint((message, peer) => {
      if (message.method === 'browsingContext.getTree') {
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: { contexts: [] } }));
      }
    }, (url) => implementation.sessionScenario(url, [
      { type: 'command', method: 'script.evaluate', timeoutMs: 50 },
      { type: 'command', method: 'browsingContext.getTree' },
    ]));

    assert.match(values[0].error, /script\.evaluate did not answer within 0\.05s/);
    assert.deepEqual(values[1], { result: { contexts: [] } });
  });
}
