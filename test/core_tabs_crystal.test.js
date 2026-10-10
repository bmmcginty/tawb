'use strict';

// The core's tab policy, differenced at its process boundary. JavaScript uses
// small page doubles; Crystal drives the real native Firefox page/session
// layer against a scripted BiDi endpoint, so tab identity is tested all the
// way down to browsing-context ids.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { tempDir, removeTempDir } = require('./tmpdir');
const { acceptWebSocket } = require('../src/broker');
const state = tempDir('tweb-core-tabs-state-');
process.env.XDG_DATA_HOME = state;
const core = require('../src/core');
const session = require('../src/session');
const { coreTabImplementations } = require('./crystal_impl');

const pages = [
  { id: 'top-a', url: 'https://a.test/', title: '  First\n tab  ', foreground: true },
  { id: 'top-b', url: 'https://b.test/', title: 'Second', foreground: false },
  { id: 'top-c', url: 'https://c.test/no-title', title: '', foreground: false },
];

const script = [
  { op: 'tabs' },
  { op: 'adopt', id: 'top-b' },
  { op: 'claimed_self' },
  { op: 'where' },
  { op: 'next', direction: 1 },
  { op: 'next', direction: -1 },
  { op: 'after', id: 'top-c' },
  { op: 'label', id: 'top-a' },
  { op: 'label', id: 'top-c' },
  { op: 'foreground', id: 'top-a' },
  { op: 'foreground', id: 'top-b' },
  { op: 'new' },
  { op: 'tabs' },
  { op: 'close', id: 'top-b' },
  { op: 'tabs' },
  { op: 'where' },
];

async function withEndpoint(run) {
  const current = new Map(pages.map((page) => [page.id, { ...page }]));
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    let peer;
    peer = acceptWebSocket(request, socket, (text) => {
      const message = JSON.parse(text);
      let result = {};
      switch (message.method) {
        case 'session.new': result = { sessionId: 'tab-session' }; break;
        case 'browsingContext.getTree':
          result = { contexts: [...current.values()].map((page) => ({
            context: page.id, url: page.url, children: [],
          })) };
          break;
        case 'session.subscribe': result = {}; break;
        case 'script.callFunction': {
          const page = current.get(message.params.target.context);
          const value = message.params.functionDeclaration.includes('document.title')
            ? { type: 'string', value: page.title }
            : { type: 'boolean', value: page.foreground };
          result = { type: 'success', result: value };
          break;
        }
        case 'browsingContext.create':
          current.set('created-context', {
            id: 'created-context', url: 'about:blank', title: '', foreground: false,
          });
          result = { context: 'created-context' };
          break;
        case 'browsingContext.close':
          current.delete(message.params.context);
          result = {};
          break;
        case 'session.end': result = {}; break;
        default: throw new Error(`unexpected BiDi method ${message.method}`);
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
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

test.after(() => removeTempDir(state));

const runs = [];
for (const implementation of coreTabImplementations(core, session)) {
  test(`${implementation.name}: the core owns one named tab and walks the others`, async () => {
    const browserPort = 41000 + Math.floor(Math.random() * 10000);
    const observed = await withEndpoint((url) => implementation.scenario(url, {
      pages, script, browser_port: browserPort,
    }));
    runs.push({ name: implementation.name, observed });
    assert.deepEqual(observed, [
      ['top-a', 'top-b', 'top-c'],
      'top-b',
      'top-b',
      { position: 2, of: 3 },
      'top-c',
      'top-a',
      'top-a',
      'First tab',
      'https://c.test/no-title',
      true,
      false,
      'created-context',
      ['top-a', 'top-b', 'top-c', 'created-context'],
      null,
      ['top-a', 'top-c', 'created-context'],
      { position: 0, of: 3 },
    ]);
  });
}

if (process.env.TAWB_TEST_CRYSTAL === '1') {
  test('both runtimes agree on tab policy', () => {
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[1].observed, runs[0].observed);
  });
}
