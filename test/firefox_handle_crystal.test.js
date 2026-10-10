'use strict';

// The handle layer, differenced wire-for-wire: values passed into the page,
// elements held across calls, frames reached by position. A scripted BiDi
// endpoint answers both runtimes and records every message, so what is
// asserted is the contract itself — the bytes a real Firefox would parse —
// and not merely that two implementations happen to agree.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bidi = require('../src/bidi');
const { FirefoxPage, FirefoxFrame } = require('../src/driver_firefox');
const { clickThrough, prepareRealClick, submitsAutofilled } = require('../src/click');
const { acceptWebSocket } = require('../src/broker');
const { firefoxHandleImplementations } = require('./crystal_impl');

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

const SCRIPT = [
  { op: 'frame', context: 'ctx-top', url: 'https://a.test/page' },
  { op: 'url' },
  { op: 'evaluate', fn: '(el) => el.tagName', arg: 'iframe' },
  { op: 'evaluate', expression: '1 + 1' },
  { op: 'evaluate', fn: '(x) => x', arg: {
    mixed: [1, 1.5, true, null, { handle: 'h-9' }],
    nested: { a: 'b' },
    ref: { handle: 'h-8', sharedId: 's-8' },
  } },
  { op: 'evaluate_handle', fn: '(el) => el', arg: { name: 'main' } },
  { op: 'handle_evaluate', fn: '(el) => el.tagName' },
  { op: 'handle_evaluate', fn: '(el) => el.value', arg: 7 },
  { op: 'handle_evaluate', fn: '(el) => el.checked', arg: true },
  { op: 'evaluate_handle', fn: '(el) => el.second' },
  { op: 'handle_evaluate', fn: '(el) => el.tagName' },
  { op: 'handle_dispose' },
  { op: 'query_all', selector: 'iframe' },
  { op: 'content_frame', index: 0 },
  { op: 'content_frame', index: 1 },
  { op: 'child_frames' },
  { op: 'use_child', index: 0 },
  { op: 'url' },
  { op: 'evaluate', fn: '(el) => el.tagName' },
  { op: 'use_main' },
  { op: 'url' },
  { op: 'evaluate_handle', fn: '(el) => el' },
  { op: 'activate' },
  { op: 'focus_control' },
  { op: 'submits_autofilled' },
  { op: 'real_click' },
  { op: 'hover' },
];

const runs = {};

for (const implementation of firefoxHandleImplementations({
  bidi, FirefoxFrame, FirefoxPage, clickThrough, prepareRealClick, submitsAutofilled,
})) {
  test(`${implementation.name}: the handle layer answers and speaks the wire`, async () => {
    const received = [];
    let handleCalls = 0;
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      switch (message.method) {
        case 'session.new':
          result = { sessionId: 'session-1' };
          break;
        case 'browsingContext.getTree':
          result = { contexts: [{
            context: message.params.root,
            url: 'https://a.test/page',
            children: [{ context: 'child-a', url: 'https://child.test/a', children: [] }],
          }] };
          break;
        case 'script.callFunction': {
          const declaration = message.params.functionDeclaration;
          let value;
          if (message.params.resultOwnership === 'root') {
            handleCalls += 1;
            value = handleCalls === 1
              ? { type: 'node', handle: 'h-1', sharedId: 's-1' }
              : { type: 'object', handle: 'h-2', sharedId: 's-2' };
          } else if (declaration.includes('querySelectorAll')) {
            value = { type: 'number', value: 2 };
          } else if (declaration === '(x) => x') {
            value = { type: 'boolean', value: true };
          } else if (declaration === '() => { return (1 + 1); }') {
            value = { type: 'number', value: 2 };
          } else if (declaration.includes('el.value')) {
            value = { type: 'number', value: 3 };
          } else if (declaration.includes('el.checked')) {
            value = { type: 'boolean', value: true };
          } else if (declaration.includes('scrollIntoView')) {
            // prepareRealClick's answer: the point it vetted, and the
            // approach point three pixels above the element's holder.
            value = { type: 'object', value: [
              ['ok', { type: 'boolean', value: true }],
              ['x', { type: 'number', value: 321 }],
              ['y', { type: 'number', value: 117 }],
              ['fromX', { type: 'number', value: 321 }],
              ['fromY', { type: 'number', value: 47 }],
              ['placed', { type: 'string', value: 'center' }],
            ] };
          } else if (declaration.includes('node.click()')) {
            value = { type: 'boolean', value: true };
          } else if (declaration.includes('autofill')) {
            value = { type: 'boolean', value: false };
          } else if (declaration.includes('el.focus()')) {
            value = { type: 'boolean', value: true };
          } else {
            value = { type: 'string', value: 'DIV' };
          }
          result = { type: 'success', result: value };
          break;
        }
        default:
          result = {};
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, SCRIPT));

    runs[implementation.name] = { received, observations };

    const calls = received.filter((message) => message.method === 'script.callFunction');
    assert.equal(calls[0].params.functionDeclaration, '(el) => el.tagName');
    assert.deepEqual(calls[0].params.arguments, [{ type: 'string', value: 'iframe' }]);
    assert.equal(calls[0].params.resultOwnership, 'none');
    assert.equal(calls[0].params.awaitPromise, true);
    assert.deepEqual(calls[0].params.target, { context: 'ctx-top' });

    assert.equal(calls[1].params.functionDeclaration, '() => { return (1 + 1); }');
    assert.deepEqual(calls[1].params.arguments, []);

    const mixed = calls[2].params.arguments[0];
    assert.equal(mixed.type, 'object');
    assert.deepEqual(mixed.value, [
      ['mixed', { type: 'array', value: [
        { type: 'number', value: 1 }, { type: 'number', value: 1.5 },
        { type: 'boolean', value: true }, { type: 'null' }, { handle: 'h-9' },
      ] }],
      ['nested', { type: 'object', value: [['a', { type: 'string', value: 'b' }]] }],
      ['ref', { handle: 'h-8' }],
    ], 'a node reference passes by its handle, and nothing else rides along');

    assert.equal(calls[3].params.resultOwnership, 'root',
      'holding an element is what root ownership is for');
    assert.deepEqual(calls[3].params.arguments, [{
      type: 'object', value: [['name', { type: 'string', value: 'main' }]],
    }]);

    assert.deepEqual(calls[4].params.arguments, [{ handle: 'h-1' }]);
    assert.deepEqual(calls[5].params.arguments,
      [{ handle: 'h-1' }, { type: 'number', value: 7 }]);
    assert.deepEqual(calls[6].params.arguments,
      [{ handle: 'h-1' }, { type: 'boolean', value: true }]);
    assert.deepEqual(calls[8].params.arguments, [{ handle: 'h-2' }],
      'the second held element replaced the first');

    const counted = calls[9];
    assert.equal(counted.params.functionDeclaration,
      '(sel) => document.querySelectorAll(sel).length');
    assert.deepEqual(counted.params.arguments, [{ type: 'string', value: 'iframe' }]);

    assert.deepEqual(calls[10].params.target, { context: 'child-a' },
      'a child frame answers from its own document');

    const disown = received.find((message) => message.method === 'script.disown');
    assert.deepEqual(disown.params, {
      handles: ['h-2'], target: { context: 'ctx-top' },
    });

    const tree = received.find((message) => message.method === 'browsingContext.getTree');
    assert.deepEqual(tree.params, { root: 'ctx-top', maxDepth: 1 });

    assert.deepEqual(observations, [
      null,
      'https://a.test/page',
      'DIV',
      2,
      true,
      { handle: 'h-1', sharedId: 's-1' },
      'DIV',
      3,
      true,
      { handle: 'h-2', sharedId: 's-2' },
      'DIV',
      null,
      2,
      { id: 'child-a', url: 'https://child.test/a' },
      null,
      [{ id: 'child-a', url: 'https://child.test/a' }],
      { id: 'child-a', url: 'https://child.test/a' },
      'https://child.test/a',
      'DIV',
      null,
      'https://a.test/page',
      { handle: 'h-2', sharedId: 's-2' },
      true,
      true,
      false,
      { ok: true },
      { ok: true },
    ]);

    // The acting half on the wire. The click is named by shared reference —
    // the browser computes the element's own centre point — and the pointer
    // it pressed is released before anything else inherits it.
    const performed = received.filter((message) => message.method === 'input.performActions');
    assert.equal(performed.length, 2, 'one performActions for the click, one for the hover');
    assert.deepEqual(performed[0].params, {
      context: 'ctx-top',
      actions: [{
        type: 'pointer', id: 'tweb-mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 0, y: 0,
            origin: { type: 'element', element: { sharedId: 's-2' } } },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    const release = received.find((message) => message.method === 'input.releaseActions');
    assert.ok(release, 'the click releases its pointer');
    assert.deepEqual(release.params, { context: 'ctx-top' });
    assert.ok(received.indexOf(release) > received.indexOf(performed[0]));

    // The hover arrives from outside the element and aims at the point the
    // check vetted, in viewport coordinates; it releases nothing, because
    // the pointer has to stay where it was put.
    assert.deepEqual(performed[1].params, {
      context: 'ctx-top',
      actions: [{
        type: 'pointer', id: 'tweb-mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 321, y: 47, origin: 'viewport' },
          { type: 'pointerMove', x: 321, y: 117, origin: 'viewport' },
        ],
      }],
    });
    assert.equal(received.filter((message) => message.method === 'input.releaseActions').length, 1,
      'a hover releases nothing: the pointer stays on the element');
  });
}

if (firefoxHandleImplementations({
  bidi, FirefoxFrame, FirefoxPage, clickThrough, prepareRealClick, submitsAutofilled,
}).length > 1) {
  test('both runtimes put the same bytes on the wire', async () => {
    assert.deepEqual(runs.Crystal.received, runs.JavaScript.received);
    assert.deepEqual(runs.Crystal.observations, runs.JavaScript.observations);
  });
}
