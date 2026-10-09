'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const bidi = require('../src/bidi');
const { FirefoxPage, verifyWebdriverFlag } = require('../src/driver_firefox');
const { askFirefoxLibrary } = require('../src/firefox_library');
const { acceptWebSocket } = require('../src/broker');
const { firefoxAutomationImplementations } = require('./crystal_impl');

function packet(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`${payload.length}:`), payload]);
}

async function parentAgent(requests) {
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      const colon = input.indexOf(0x3a);
      if (colon < 0) return;
      const size = Number(input.subarray(0, colon));
      if (input.length < colon + 1 + size) return;
      requests.push(JSON.parse(input.subarray(colon + 1, colon + 1 + size)));
      socket.end(packet({
        result: {
          before: { 'RemoteAgent:Active': true },
          after: { 'RemoteAgent:Active': false },
        },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function bidiEndpoint(commands) {
  const sockets = new Set();
  const server = http.createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    let peer;
    peer = acceptWebSocket(request, socket, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      let result = {};
      if (message.method === 'session.new') {
        result = { sessionId: 'verified-session', capabilities: { browserName: 'firefox' } };
      } else if (message.method === 'browsingContext.create') {
        result = { context: 'probe-context' };
      } else if (message.method === 'script.callFunction') {
        result = {
          type: 'success',
          result: {
            type: 'object',
            value: [
              ['readyState', { type: 'string', value: 'complete' }],
              ['webdriver', { type: 'boolean', value: false }],
            ],
          },
        };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, () => {});
    if (head.length) peer.consume(head);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    sockets,
    url: `ws://127.0.0.1:${server.address().port}/session`,
  };
}

for (const implementation of firefoxAutomationImplementations({
  bidi, FirefoxPage, askFirefoxLibrary, verifyWebdriverFlag,
})) {
  test(`${implementation.name}: Firefox session clears and verifies webdriver before use`, async () => {
    const requests = [];
    const commands = [];
    const agent = await parentAgent(requests);
    const endpoint = await bidiEndpoint(commands);
    try {
      const result = await implementation.verifiedSession(
        endpoint.url, agent.address().port,
      );
      assert.deepEqual(result, {
        session: {
          sessionId: 'verified-session', capabilities: { browserName: 'firefox' },
        },
        cleared: {
          before: { 'RemoteAgent:Active': true },
          after: { 'RemoteAgent:Active': false },
        },
        webdriver: false,
      });
    } finally {
      for (const socket of endpoint.sockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => endpoint.server.close(resolve)),
        new Promise((resolve) => agent.close(resolve)),
      ]);
    }

    assert.deepEqual(requests, [{ kind: 'clearAutomation' }]);
    assert.deepEqual(commands.map(({ id, method }) => ({ id, method })), [
      { id: 1, method: 'session.new' },
      { id: 2, method: 'browsingContext.create' },
      { id: 3, method: 'script.callFunction' },
      { id: 4, method: 'browsingContext.close' },
      { id: 5, method: 'session.end' },
    ]);
    assert.deepEqual(commands[1].params, { type: 'tab', background: true });
    assert.equal(commands[2].params.target.context, 'probe-context');
    assert.match(commands[2].params.functionDeclaration, /navigator\.webdriver/);
    assert.deepEqual(commands[3].params, { context: 'probe-context' });
  });
}
