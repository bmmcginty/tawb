'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bidi = require('../src/bidi');
const { FirefoxPage, FirefoxFrame } = require('../src/driver_firefox');
const { extractAxItems } = require('../src/ax_own');
const { acceptWebSocket } = require('../src/broker');
const { firefoxPageImplementations } = require('./crystal_impl');
const { bidiCallFunctionTrace } = require('./parity/protocol-trace-v1');

// parity-id: asset.extract-ax-items

async function withEndpoint(onMessage, run) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    let peer;
    peer = acceptWebSocket(request, socket, (text) => onMessage(JSON.parse(text), peer), () => {});
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

function remoteItems(role, name, { childFrame = false } = {}) {
  const value = [{
    type: 'object',
    value: [
      ['role', { type: 'string', value: role }],
      ['name', { type: 'string', value: name }],
    ],
  }];
  if (childFrame) {
    value.push({
      type: 'object',
      value: [
        ['role', { type: 'string', value: 'iframe' }],
        ['name', { type: 'string', value: 'Child frame' }],
        ['frameIndex', { type: 'number', value: 0 }],
      ],
    });
  }
  return { type: 'success', result: { type: 'array', value } };
}

for (const implementation of firefoxPageImplementations({
  bidi, FirefoxPage, FirefoxFrame, extractAxItems,
})) {
  test(`${implementation.name}: Firefox page session navigates and extracts every frame`, async () => {
    const received = [];
    const top = {
      context: 'top-context',
      url: 'https://example.test/final',
      children: [{ context: 'child-context', url: 'https://frame.test/', children: [] }],
    };
    const value = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      switch (message.method) {
        case 'session.new':
          result = { sessionId: 'session-1', capabilities: { browserName: 'firefox' } };
          break;
        case 'browsingContext.getTree':
          result = message.params.root
            ? { contexts: [top] }
            : { contexts: [{ context: 'top-context', url: 'about:blank', children: [] }] };
          break;
        case 'browsingContext.navigate':
          result = { navigation: 'navigation-1', url: 'https://example.test/final' };
          break;
        case 'script.callFunction': {
          assert.equal(message.params.awaitPromise, true);
          assert.equal(message.params.resultOwnership, 'none');
          if (message.params.functionDeclaration.includes('video[controls]')) {
            result = {
              type: 'success',
              result: {
                type: 'boolean',
                value: message.params.target.context === 'top-context',
              },
            };
          } else {
            assert.match(message.params.functionDeclaration, /extractAxItems/);
            const asksForLayout = message.params.functionDeclaration.includes('{layout:true}')
              || JSON.stringify(message.params.arguments).includes('"layout"')
                && JSON.stringify(message.params.arguments).includes('true');
            assert.equal(asksForLayout, true);
            const context = message.params.target.context;
            result = remoteItems(
              context === 'top-context' ? 'document' : 'paragraph',
              context === 'top-context' ? 'Main' : 'Child',
              { childFrame: context === 'top-context' },
            );
          }
          break;
        }
        case 'browsingContext.create':
          result = { context: 'created-context' };
          break;
        default:
          result = {};
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.pageScenario(url, {
      events: ['browsingContext.domContentLoaded'],
      target: 'https://example.test/start',
      layout: true,
    }));

    assert.deepEqual(received.map(({ id, method }) => ({ id, method })), [
      { id: 1, method: 'session.new' },
      { id: 2, method: 'session.subscribe' },
      { id: 3, method: 'browsingContext.getTree' },
      { id: 4, method: 'browsingContext.navigate' },
      { id: 5, method: 'browsingContext.getTree' },
      { id: 6, method: 'script.callFunction' },
      { id: 7, method: 'script.callFunction' },
      { id: 8, method: 'script.callFunction' },
      { id: 9, method: 'script.callFunction' },
      { id: 10, method: 'script.callFunction' },
      { id: 11, method: 'browsingContext.create' },
      { id: 12, method: 'browsingContext.close' },
      { id: 13, method: 'session.end' },
    ]);
    assert.deepEqual(received[0].params, { capabilities: { alwaysMatch: {} } });
    assert.deepEqual(received[1].params, { events: ['browsingContext.domContentLoaded'] });
    assert.deepEqual(received[3].params, {
      context: 'top-context', url: 'https://example.test/start', wait: 'interactive',
    });
    assert.deepEqual(received[10].params, { type: 'tab', background: true });
    assert.deepEqual(received[11].params, { context: 'created-context' });

    // Keep a canonical wire observation of the extractor seam. This catches a
    // caller that still selects the right asset but sends it to the wrong
    // frame or drops an option before BiDi sees it.
    const scriptTrace = received
      .filter(({ method }) => method === 'script.callFunction')
      .map(bidiCallFunctionTrace);
    const invocationShape = scriptTrace.map((entry) => ({
      source: entry.source.includes('extractAxItems') ? 'extract_ax_items.js' : 'media-probe',
      target: entry.target,
      arguments: entry.arguments,
    }));
    const options = (layout, pierce = false) => [{ type: 'object', value: [
      ['layout', { type: 'boolean', value: layout }],
      ['visual', { type: 'boolean', value: false }],
      ...(pierce ? [['pierce', { type: 'boolean', value: true }]] : []),
    ] }];
    assert.deepEqual(invocationShape, [
      { source: 'extract_ax_items.js', target: { context: 'top-context' }, arguments: options(true) },
      { source: 'media-probe', target: { context: 'top-context' }, arguments: [] },
      { source: 'extract_ax_items.js', target: { context: 'top-context' }, arguments: options(true, true) },
      { source: 'extract_ax_items.js', target: { context: 'child-context' }, arguments: options(true) },
      { source: 'media-probe', target: { context: 'child-context' }, arguments: [] },
    ]);
    assert.deepEqual(value, {
      session: { sessionId: 'session-1', capabilities: { browserName: 'firefox' } },
      url: 'https://example.test/final',
      tree: {
        frame: { id: 'top-context', url: 'https://example.test/final' },
        childFrames: [{ frame: { id: 'child-context', url: 'https://frame.test/' } }],
      },
      documents: {
        'top-context': [
          { role: 'document', name: 'Main' },
          { role: 'iframe', name: 'Child frame', frameIndex: 0 },
        ],
        'child-context': [{ role: 'paragraph', name: 'Child' }],
      },
      created: 'created-context',
    });
  });
}
