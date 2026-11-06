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
const {
  FirefoxPage, FirefoxFrame, FirefoxKeyboard, pierceAndRun, sliderGeometry,
  toRemoteArgument,
} = require('../src/driver_firefox');
const { clickThrough, prepareRealClick, submitsAutofilled } = require('../src/click');
const {
  readFieldState, readFieldStateInPage, sliderStateOf,
  SCROLL_TO_BOTTOM, RESTORE_SCROLL, TEXT_AT_FRAGMENT,
} = require('../src/core');
const { describeElement, locateElement } = require('../src/place');
const { extractSource } = require('../src/source_html');
const { extractForEdbrowse, resolveDescriptor, applyFieldValues } = require('../src/edb_page');
const {
  armActivationFocus, focusedByActivation, cancelActivationFocus,
  armFocusTracker, focusTrackerHasTarget, takeFocusTrackerTarget, clearFocusTracker,
} = require('../src/focus');
const { acceptWebSocket } = require('../src/broker');
const { firefoxHandleImplementations } = require('./crystal_impl');
const { bidiCallFunctionTrace } = require('./parity/protocol-trace-v1');

// parity-id: asset.extract-source
// parity-id: asset.edb-extract
// parity-id: asset.edb-resolve
// parity-id: asset.click-through
// parity-id: asset.prepare-real-click
// parity-id: asset.slider-geometry
// parity-id: asset.submits-autofilled
// parity-id: asset.focus-arm
// parity-id: asset.focus-has-target
// parity-id: asset.focus-take-target
// parity-id: asset.focus-clear
// parity-id: asset.read-field-state
// parity-id: asset.slider-state
// parity-id: asset.describe-element
// parity-id: asset.locate-element
// parity-id: asset.scroll-to-bottom
// parity-id: asset.restore-scroll
// parity-id: asset.text-at-fragment
// parity-id: asset.edb-apply

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
  { op: 'set_files', paths: ['/tmp/report.txt', '/tmp/photo.jpg'] },
  { op: 'real_click' },
  { op: 'hover' },
  { op: 'key_type', text: 'hi' },
  { op: 'key_press', key: 'Control+a' },
  { op: 'key_press', key: 'ArrowRight' },
  { op: 'key_type', text: '\uD83D\uDE00' },
  { op: 'key_error', key: 'F12' },
  { op: 'click_slider', ratio: 0.51 },
  { op: 'activate_item', item: { role: 'link', name: 'Open', axIndex: 3 } },
  { op: 'activate_item', item: { role: 'button', name: 'Sign in', axIndex: 4 } },
  { op: 'activate_item', item: { role: 'button', name: 'Covered sign in', axIndex: 5 } },
  { op: 'activate_item', item: {
    role: 'link', name: 'Challenge', pierced: true, axIndex: 6,
    frame: { id: 'child-a' },
  } },
  { op: 'activate_item', item: {
    role: 'button', name: 'hidden challenge', pressFrame: { id: 'child-a' },
  } },
];

const runs = {};

for (const implementation of firefoxHandleImplementations({
  bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
  clickThrough, prepareRealClick, submitsAutofilled,
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
            value = {
              type: handleCalls === 1 ? 'node' : 'object',
              handle: `h-${handleCalls}`,
              sharedId: `s-${handleCalls}`,
            };
          } else if (declaration === '(sel) => document.querySelectorAll(sel).length') {
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
            // approach point three pixels above the element's holder. The
            // fifth held element is covered, exercising activation's warning
            // and default-action fallback.
            const held = message.params.arguments[0]?.handle;
            value = held === 'h-6'
              ? { type: 'object', value: [
                  ['ok', { type: 'boolean', value: false }],
                  ['reason', { type: 'string', value: 'is covered' }],
                ] }
              : { type: 'object', value: [
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
            const held = message.params.arguments[0]?.handle;
            value = { type: 'boolean', value: held === 'h-5' || held === 'h-6' };
          } else if (declaration.includes('window.innerWidth')) {
            value = { type: 'object', value: [
              ['w', { type: 'number', value: 640 }],
              ['h', { type: 'number', value: 360 }],
            ] };
          } else if (declaration.includes('el.focus()')) {
            value = { type: 'boolean', value: true };
          } else if (declaration.includes('getBoundingClientRect')) {
            // sliderGeometry's answer for a 200x24 horizontal track; checked
            // last of the page functions, because clickThrough and
            // prepareRealClick name getBoundingClientRect too and are
            // identified by their own markers above.
            value = { type: 'object', value: [
              ['width', { type: 'number', value: 200 }],
              ['height', { type: 'number', value: 24 }],
              ['vertical', { type: 'boolean', value: false }],
              ['start', { type: 'number', value: 2 }],
              ['end', { type: 'number', value: 198 }],
            ] };
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
      { handle: 'h-3', sharedId: 's-3' },
      true,
      true,
      false,
      true,
      { ok: true },
      { ok: true },
      null,
      null,
      null,
      null,
      'the Firefox driver has no key named "F12"',
      null,
      { how: 'default-action', status: null },
      { how: 'real-click', status: null },
      {
        how: 'default-action',
        status: 'Pressed "Covered sign in", but the browser only sends a remembered password '
          + 'when a person presses the button, and this one is covered. '
          + 'If the sign-in is refused, type the password in.',
      },
      { how: 'real-click', status: null },
      { how: 'frame', status: 'Pressed the middle of hidden challenge.' },
    ]);

    const itemResolutions = calls.filter((message) =>
      message.params.resultOwnership === 'root'
        && message.params.functionDeclaration.includes("Symbol.for('tweb.ax')"));
    assert.deepEqual(itemResolutions.map((message) => ({
      target: message.params.target.context,
      index: message.params.arguments[0].value,
    })), [
      { target: 'ctx-top', index: 3 },
      { target: 'ctx-top', index: 4 },
      { target: 'ctx-top', index: 5 },
      { target: 'child-a', index: 6 },
    ], 'each item resolves through the retained AX node in its own frame');

    const files = received.find((message) => message.method === 'input.setFiles');
    assert.deepEqual(files.params, {
      context: 'ctx-top', element: { sharedId: 's-3' },
      files: ['/tmp/report.txt', '/tmp/photo.jpg'],
    }, 'a held file input is named by its shared reference');

    // The acting half on the wire. The click is named by shared reference —
    // the browser computes the element's own centre point — and the pointer
    // it pressed is released before anything else inherits it.
    const performed = received.filter((message) => message.method === 'input.performActions'
      && message.params.actions[0].type === 'pointer');
    assert.equal(performed.length, 7,
      'direct, item-level, frame, hover, and slider actions all reach the wire');
    assert.deepEqual(performed[0].params, {
      context: 'ctx-top',
      actions: [{
        type: 'pointer', id: 'tweb-mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 0, y: 0,
            origin: { type: 'element', element: { sharedId: 's-3' } } },
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
    assert.equal(received.filter((message) => message.method === 'input.releaseActions').length, 5,
      'every click releases its pointer; a hover deliberately does not');
    assert.deepEqual(performed[6].params, {
      context: 'child-a',
      actions: [{
        type: 'pointer', id: 'tweb-mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x: 320, y: 180, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    }, 'an unreadable frame is pressed in the middle of its own viewport');

    // The slider: a first move to disclose the hover-only chrome, the track
    // measured in the page, then the press at the point the requested ratio
    // maps onto — two pixels in from the ends of this 200-wide track.
    const sliderPerforms = performed.filter(
      (message) => message.params.actions[0].id === 'tweb-slider');
    assert.equal(sliderPerforms.length, 2);
    assert.deepEqual(sliderPerforms[0].params.actions[0].actions, [
      { type: 'pointerMove', x: 0, y: 0,
        origin: { type: 'element', element: { sharedId: 's-3' } } },
    ]);
    assert.deepEqual(sliderPerforms[1].params.actions[0].actions, [
      { type: 'pointerMove', x: 2, y: 0,
        origin: { type: 'element', element: { sharedId: 's-3' } } },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]);
    const geometryCall = received.find(
      (message) => message.method === 'script.callFunction'
        && message.params.functionDeclaration.includes('sliderGeometry'));
    assert.ok(geometryCall, 'the track is measured in the page');
    assert.deepEqual(geometryCall.params.arguments,
      [{ handle: 'h-3' }, { type: 'null' }],
      'the element rides by its handle, the requested orientation by its value');

    // The keyboard: real key events, one keystroke per code point, the
    // modifier held down across the key it qualifies and released in
    // reverse. An unknown key name is refused, not guessed.
    const keyPerforms = received.filter((message) => message.method === 'input.performActions'
      && message.params.actions[0].type === 'key');
    assert.equal(keyPerforms.length, 4);
    assert.deepEqual(keyPerforms[0].params, {
      context: 'ctx-top',
      actions: [{ type: 'key', id: 'tweb-keyboard', actions: [
        { type: 'keyDown', value: 'h' }, { type: 'keyUp', value: 'h' },
        { type: 'keyDown', value: 'i' }, { type: 'keyUp', value: 'i' },
      ] }],
    });
    assert.deepEqual(keyPerforms[1].params.actions[0].actions, [
      { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' }, { type: 'keyUp', value: '\uE009' },
    ]);
    assert.deepEqual(keyPerforms[2].params.actions[0].actions, [
      { type: 'keyDown', value: '\uE014' }, { type: 'keyUp', value: '\uE014' },
    ]);
    assert.deepEqual(keyPerforms[3].params.actions[0].actions, [
      { type: 'keyDown', value: '\uD83D\uDE00' }, { type: 'keyUp', value: '\uD83D\uDE00' },
    ], 'a character outside the basic plane is one keystroke');
  });
}

test('both runtimes invoke action assets with the same target and arguments', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled,
  });
  for (const implementation of implementations) {
    const received = [];
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        const source = message.params.functionDeclaration;
        let value;
        if (message.params.resultOwnership === 'root') {
          value = { type: 'node', handle: 'asset-handle', sharedId: 'asset-shared' };
        } else if (source === clickThrough.toString()) {
          value = { type: 'boolean', value: true };
        } else if (source === prepareRealClick.toString()) {
          value = { type: 'object', value: [
            ['ok', { type: 'boolean', value: true }],
            ['x', { type: 'number', value: 20 }],
            ['y', { type: 'number', value: 30 }],
            ['fromX', { type: 'number', value: 20 }],
            ['fromY', { type: 'number', value: 10 }],
            ['placed', { type: 'string', value: 'center' }],
          ] };
        } else if (source === submitsAutofilled.toString()) {
          value = { type: 'boolean', value: false };
        } else if (source === sliderGeometry.toString()) {
          value = { type: 'object', value: [
            ['width', { type: 'number', value: 100 }],
            ['height', { type: 'number', value: 20 }],
            ['vertical', { type: 'boolean', value: false }],
            ['start', { type: 'number', value: 2 }],
            ['end', { type: 'number', value: 98 }],
          ] };
        } else {
          value = { type: 'null' };
        }
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'action-frame', url: 'https://action.test/' },
      { op: 'evaluate_handle', fn: '(el) => el' },
      { op: 'activate' },
      { op: 'real_click' },
      { op: 'submits_autofilled' },
      { op: 'click_slider', ratio: 0.5 },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [
      null,
      { handle: 'asset-handle', sharedId: 'asset-shared' },
      true,
      { ok: true },
      false,
      null,
    ], label);

    const calls = received.filter(({ method }) => method === 'script.callFunction');
    const traceFor = (source) => {
      const call = calls.find((candidate) => candidate.params.functionDeclaration === source);
      assert.ok(call, `${label} did not invoke ${source.slice(0, 40)}`);
      return bidiCallFunctionTrace(call);
    };
    const receiver = [{ handle: 'asset-handle' }];
    for (const source of [clickThrough, prepareRealClick, submitsAutofilled]) {
      const trace = traceFor(source.toString());
      assert.deepEqual({ target: trace.target, arguments: trace.arguments }, {
        target: { context: 'action-frame' }, arguments: receiver,
      }, `${label} ${source.name}`);
    }
    const geometry = traceFor(sliderGeometry.toString());
    assert.deepEqual({ target: geometry.target, arguments: geometry.arguments }, {
      target: { context: 'action-frame' },
      arguments: [...receiver, { type: 'null' }],
    }, `${label} sliderGeometry`);
  }
});

test('both runtimes keep focus-tracker assets on one frame and token', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled,
    armActivationFocus, focusedByActivation, cancelActivationFocus,
  });
  const assets = [
    { fn: armFocusTracker },
    { fn: focusTrackerHasTarget },
    { fn: takeFocusTrackerTarget },
    { fn: clearFocusTracker },
  ];
  for (const implementation of implementations) {
    const received = [];
    let roots = 0;
    const isAsset = (source, asset) => source === asset.fn.toString()
      || source.includes(`Generated from src/focus.js ${asset.fn.name};`);
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        let value;
        if (message.params.resultOwnership === 'root') {
          roots += 1;
          value = {
            type: 'node', handle: `focus-handle-${roots}`, sharedId: `focus-shared-${roots}`,
          };
        } else if (isAsset(message.params.functionDeclaration, assets[1])) {
          value = { type: 'boolean', value: true };
        } else {
          value = { type: 'boolean', value: true };
        }
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'focus-frame', url: 'https://focus.test/' },
      { op: 'evaluate_handle', fn: '(el) => el' },
      { op: 'focus_assets' },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [
      null,
      { handle: 'focus-handle-1', sharedId: 'focus-shared-1' },
      { found: true, cancelled: true },
    ], label);

    const calls = received.filter(({ method }) => method === 'script.callFunction');
    const tracesFor = (asset) => calls
      .filter(({ params }) => isAsset(params.functionDeclaration, asset))
      .map((call) => ({ call, trace: bidiCallFunctionTrace(call) }));
    const [arms, checks, takes, clears] = assets.map(tracesFor);
    assert.equal(arms.length, 2, `${label} arm count`);
    assert.equal(checks.length, 1, `${label} check count`);
    assert.equal(takes.length, 1, `${label} take count`);
    assert.equal(clears.length, 2, `${label} clear count`);
    for (const { trace } of [...arms, ...checks, ...takes, ...clears]) {
      assert.deepEqual(trace.target, { context: 'focus-frame' }, label);
    }
    assert.deepEqual(arms.map(({ trace }) => trace.arguments[0]), [
      { handle: 'focus-handle-1' }, { handle: 'focus-handle-1' },
    ], label);
    const firstToken = arms[0].trace.arguments[1];
    const secondToken = arms[1].trace.arguments[1];
    assert.equal(firstToken.type, 'string');
    assert.equal(secondToken.type, 'string');
    assert.notEqual(firstToken.value, secondToken.value, `${label} reused an activation token`);
    assert.deepEqual(checks[0].trace.arguments, [firstToken], label);
    assert.deepEqual(takes[0].trace.arguments, [firstToken], label);
    assert.deepEqual(clears.map(({ trace }) => trace.arguments), [
      [firstToken], [secondToken],
    ], label);
    assert.equal(takes[0].call.params.resultOwnership, 'root', label);
    const disposed = received.find(({ method, params }) => method === 'script.disown'
      && params.handles.includes('focus-handle-2'));
    assert.ok(disposed, `${label} did not dispose the focused target`);
  }
});

test('both runtimes read field and slider state from the held control', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled, readFieldState,
  });
  for (const implementation of implementations) {
    const received = [];
    let sliderReads = 0;
    const isAsset = (source, fn) => source === fn.toString()
      || source.includes(`Generated from src/core.js ${fn.name};`);
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        const source = message.params.functionDeclaration;
        let value;
        if (message.params.resultOwnership === 'root') {
          value = { type: 'node', handle: 'state-handle', sharedId: 'state-shared' };
        } else if (isAsset(source, readFieldStateInPage)) {
          value = { type: 'object', value: [
            ['value', { type: 'string', value: 'hello' }],
            ['caret', { type: 'number', value: 2 }],
          ] };
        } else if (isAsset(source, sliderStateOf)) {
          sliderReads += 1;
          value = { type: 'object', value: [
            ['value', { type: 'number', value: sliderReads === 1 ? 5 : 6 }],
            ['min', { type: 'number', value: 0 }],
            ['max', { type: 'number', value: 10 }],
            ['step', { type: 'number', value: 1 }],
            ['orientation', { type: 'string', value: 'horizontal' }],
          ] };
        } else {
          value = { type: 'null' };
        }
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'state-frame', url: 'https://state.test/' },
      { op: 'evaluate_handle', fn: '(el) => el' },
      { op: 'read_field_state' },
      { op: 'adjust_control', role: 'slider', key: 'ArrowRight' },
      { op: 'handle_dispose' },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [
      null,
      { handle: 'state-handle', sharedId: 'state-shared' },
      { value: 'hello', caret: 2 },
      { changed: true, fallback: false, before: 5, after: 6 },
      null,
    ], label);

    const calls = received.filter(({ method }) => method === 'script.callFunction');
    const tracesFor = (fn) => calls
      .filter(({ params }) => isAsset(params.functionDeclaration, fn))
      .map(bidiCallFunctionTrace);
    const field = tracesFor(readFieldStateInPage);
    const sliders = tracesFor(sliderStateOf);
    assert.equal(field.length, 1, `${label} field-state count`);
    assert.equal(sliders.length, 2, `${label} slider-state count`);
    for (const trace of [...field, ...sliders]) {
      assert.deepEqual({ target: trace.target, arguments: trace.arguments }, {
        target: { context: 'state-frame' }, arguments: [{ handle: 'state-handle' }],
      }, label);
    }
    const disposed = received.find(({ method }) => method === 'script.disown');
    assert.deepEqual(disposed.params, {
      handles: ['state-handle'], target: { context: 'state-frame' },
    }, label);
  }
});

test('both runtimes describe and relocate a held element in its frame', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled, describeElement, locateElement,
  });
  for (const implementation of implementations) {
    const received = [];
    const isAsset = (source, fn) => source === fn.toString()
      || source.includes(`Generated from src/place.js ${fn.name};`);
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        const source = message.params.functionDeclaration;
        let value;
        if (message.params.resultOwnership === 'root') {
          value = { type: 'node', handle: 'place-handle', sharedId: 'place-shared' };
        } else if (isAsset(source, describeElement)) {
          value = { type: 'object', value: [
            ['label', { type: 'string', value: 'Account' }],
            ['ordinal', { type: 'number', value: 2 }],
            ['total', { type: 'number', value: 4 }],
          ] };
        } else if (isAsset(source, locateElement)) {
          value = { type: 'object', value: [
            ['index', { type: 'number', value: 7 }],
            ['exact', { type: 'boolean', value: true }],
          ] };
        } else {
          value = { type: 'null' };
        }
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'place-frame', url: 'https://place.test/' },
      { op: 'evaluate_handle', fn: '(el) => el' },
      { op: 'describe_element' },
      { op: 'locate_element', array: 'tweb.page' },
      { op: 'handle_dispose' },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [
      null,
      { handle: 'place-handle', sharedId: 'place-shared' },
      { label: 'Account', ordinal: 2, total: 4 },
      { index: 7, exact: true },
      null,
    ], label);

    const calls = received.filter(({ method }) => method === 'script.callFunction');
    const tracesFor = (fn) => calls
      .filter(({ params }) => isAsset(params.functionDeclaration, fn))
      .map(bidiCallFunctionTrace);
    const described = tracesFor(describeElement);
    const located = tracesFor(locateElement);
    assert.equal(described.length, 1, `${label} describe count`);
    assert.equal(located.length, 1, `${label} locate count`);
    assert.deepEqual({ target: described[0].target, arguments: described[0].arguments }, {
      target: { context: 'place-frame' }, arguments: [{ handle: 'place-handle' }],
    }, label);
    assert.deepEqual({ target: located[0].target, arguments: located[0].arguments }, {
      target: { context: 'place-frame' },
      arguments: [{ handle: 'place-handle' }, { type: 'string', value: 'tweb.page' }],
    }, label);
    const disposed = received.find(({ method }) => method === 'script.disown');
    assert.deepEqual(disposed.params, {
      handles: ['place-handle'], target: { context: 'place-frame' },
    }, label);
  }
});

test('both runtimes invoke load-more and fragment assets on the acting page', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled,
  });
  const assets = [
    { fn: SCROLL_TO_BOTTOM, marker: 'SCROLL_TO_BOTTOM' },
    { fn: RESTORE_SCROLL, marker: 'RESTORE_SCROLL' },
    { fn: TEXT_AT_FRAGMENT, marker: 'TEXT_AT_FRAGMENT' },
  ];
  for (const implementation of implementations) {
    const received = [];
    const isAsset = (source, asset) => source === asset.fn.toString()
      || source.includes(`Generated from src/core.js ${asset.marker};`);
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        const source = message.params.functionDeclaration;
        let value;
        if (isAsset(source, assets[0])) {
          value = { type: 'object', value: [
            ['elements', { type: 'number', value: 14 }],
            ['scrollable', { type: 'boolean', value: false }],
            ['moved', { type: 'boolean', value: false }],
            ['target', { type: 'string', value: 'nothing' }],
          ] };
        } else if (isAsset(source, assets[1])) {
          value = { type: 'boolean', value: true };
        } else if (isAsset(source, assets[2])) {
          value = { type: 'string', value: 'Target words' };
        } else {
          value = { type: 'null' };
        }
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'utility-frame', url: 'https://utility.test/' },
      { op: 'load_more_assets' },
      { op: 'fragment_asset', hash: 'main-content', blocks: ['Before', 'Target words here'] },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [
      null,
      { grew: false, scrollable: false, moved: false, target: 'nothing' },
      1,
    ], label);

    const calls = received.filter(({ method }) => method === 'script.callFunction');
    const traces = assets.map((asset) => calls
      .filter(({ params }) => isAsset(params.functionDeclaration, asset))
      .map(bidiCallFunctionTrace));
    assert.deepEqual(traces.map((entries) => entries.length), [1, 1, 1], label);
    for (const trace of traces.flat()) {
      assert.deepEqual(trace.target, { context: 'utility-frame' }, label);
    }
    assert.deepEqual(traces[0][0].arguments, [], `${label} scroll arguments`);
    assert.deepEqual(traces[1][0].arguments, [], `${label} restore arguments`);
    assert.deepEqual(traces[2][0].arguments,
      [{ type: 'string', value: 'main-content' }], `${label} fragment arguments`);
  }
});

test('both runtimes apply edbrowse fields in the resolved frame', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled, applyFieldValues,
  });
  const entries = [
    { path: '/form[0]/input[0]', tag: 'input', value: 'Ada' },
    { path: '/form[0]/input[1]', tag: 'input', value: 'yes' },
  ];
  for (const implementation of implementations) {
    const received = [];
    const isAsset = (source) => source === applyFieldValues.toString()
      || source.includes('Generated from src/edb_page.js applyFieldValues;');
    const observations = await withEndpoint((message, peer) => {
      received.push(message);
      let result = {};
      if (message.method === 'session.new') result = { sessionId: 'session-1' };
      if (message.method === 'script.callFunction') {
        const value = isAsset(message.params.functionDeclaration)
          ? { type: 'object', value: [
              ['applied', { type: 'number', value: 2 }],
              ['missed', { type: 'array', value: [] }],
            ] }
          : { type: 'null' };
        result = { type: 'success', result: value };
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
    }, (url) => implementation.handleScenario(url, [
      { op: 'frame', context: 'edb-frame', url: 'https://edb.test/' },
      { op: 'edb_apply', entries },
    ]));
    const label = implementation.name;
    assert.deepEqual(observations, [null, { applied: 2, missed: [] }], label);

    const calls = received.filter(({ method, params }) =>
      method === 'script.callFunction' && isAsset(params.functionDeclaration));
    assert.equal(calls.length, 1, `${label} apply count`);
    const trace = bidiCallFunctionTrace(calls[0]);
    assert.deepEqual({ target: trace.target, arguments: trace.arguments }, {
      target: { context: 'edb-frame' }, arguments: [toRemoteArgument(entries)],
    }, label);
  }
});

test('both runtimes probe and retry privileged assets in the same frame', async () => {
  const implementations = firefoxHandleImplementations({
    bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
    clickThrough, prepareRealClick, submitsAutofilled,
  });
  const assets = [
    { name: 'extract-source', fn: extractSource, extra: {} },
    { name: 'edb-extract', fn: extractForEdbrowse, extra: {} },
    { name: 'edb-resolve', fn: resolveDescriptor, extra: { desc: { tag: 'button' } } },
  ];
  for (const asset of assets) {
    for (const implementation of implementations) {
      const received = [];
      const observations = await withEndpoint((message, peer) => {
        received.push(message);
        let result = {};
        if (message.method === 'session.new') result = { sessionId: 'session-1' };
        if (message.method === 'script.callFunction') {
          const probe = message.params.functionDeclaration.includes('(pierce() || []).length');
          result = {
            type: 'success',
            result: probe
              ? { type: 'number', value: 1 }
              : { type: 'string', value: 'pierced' },
          };
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, (url) => implementation.handleScenario(url, [
        { op: 'frame', context: 'asset-frame', url: 'https://asset.test/' },
        {
          op: 'pierce',
          fn: asset.fn.toString(),
          expression: `(${asset.fn.toString()})({pairs:this,pierce:true})`,
          arg: asset.extra,
        },
      ]));
      const label = `${implementation.name} ${asset.name}`;
      assert.deepEqual(observations, [null, 'pierced'], label);
      const calls = received.filter(({ method }) => method === 'script.callFunction');
      assert.equal(calls.length, 2, label);
      const traces = calls.map(bidiCallFunctionTrace);
      assert.equal(traces[1].source, asset.fn.toString(), label);
      assert.deepEqual(traces.map(({ target, arguments: args }) => ({ target, arguments: args })), [
        { target: { context: 'asset-frame' }, arguments: [] },
        {
          target: { context: 'asset-frame' },
          arguments: [toRemoteArgument({ pierce: true, ...asset.extra })],
        },
      ], label);
    }
  }
});

const nativeImplementation = firefoxHandleImplementations({
  bidi, FirefoxFrame, FirefoxPage, FirefoxKeyboard, pierceAndRun,
  clickThrough, prepareRealClick, submitsAutofilled,
}).find((implementation) => implementation.name === 'Crystal');

test('Crystal: a completed goto is not charged to the next fragment activation',
  { skip: !nativeImplementation }, async () => {
    const preferences = 'about:preferences';
    const started = Date.now();
    const observations = await withEndpoint((message, peer) => {
      if (message.method === 'browsingContext.navigate') {
        // The command's interactive wait is the authority that this move is
        // complete. Firefox can leave its navigationStarted event queued for
        // the client even though no later load event belongs to this wait.
        peer.send(JSON.stringify({
          method: 'browsingContext.navigationStarted',
          params: { context: 'ctx-top', url: preferences },
        }));
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          navigation: 'preferences-navigation', url: preferences,
        } }));
        return;
      }
      if (message.method === 'script.callFunction'
          && message.params.resultOwnership === 'root') {
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'node', handle: 'downloads', sharedId: 'downloads' },
        } }));
        return;
      }
      if (message.method === 'script.callFunction'
          && message.params.functionDeclaration.includes('node.click()')) {
        // Firefox's preferences categories are same-document moves. There is
        // a fragment event, not a document load to release a poisoned waiter.
        peer.send(JSON.stringify({
          method: 'browsingContext.fragmentNavigated',
          params: { context: 'ctx-top', url: `${preferences}#downloads` },
        }));
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'boolean', value: true },
        } }));
        return;
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result: {} }));
    }, (url) => nativeImplementation.handleScenario(url, [
      { op: 'frame', context: 'ctx-top', url: 'about:blank' },
      { op: 'page_goto', url: preferences },
      { op: 'activate_item', item: { role: 'tab', name: 'Downloads', axIndex: 6 } },
    ]));

    assert.deepEqual(observations[2], { how: 'default-action', status: null });
    assert.ok(Date.now() - started < 3000,
      'the completed goto was mistaken for this activation and paid the 15-second timeout');
  });

test('Crystal: item activation waits for the navigation it starts',
  { skip: !nativeImplementation }, async () => {
    const destination = 'https://video.example/watch/8';
    const observations = await withEndpoint((message, peer) => {
      if (message.method === 'script.callFunction'
          && message.params.resultOwnership === 'root') {
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'node', handle: 'link-8', sharedId: 'shared-8' },
        } }));
        return;
      }
      if (message.method === 'script.callFunction'
          && message.params.functionDeclaration.includes('node.click()')) {
        peer.send(JSON.stringify({
          method: 'browsingContext.navigationStarted',
          params: { context: 'ctx-top', url: destination },
        }));
        peer.send(JSON.stringify({
          method: 'browsingContext.domContentLoaded',
          params: { context: 'ctx-top', url: destination },
        }));
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'boolean', value: true },
        } }));
        return;
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result: {} }));
    }, (url) => nativeImplementation.handleScenario(url, [
      { op: 'frame', context: 'ctx-top', url: 'https://search.example/results' },
      { op: 'activate_item', item: { role: 'link', name: 'Result 8', axIndex: 8 } },
      { op: 'page_url' },
    ]));

    assert.equal(observations[2], destination,
      'the reader examined the old document before navigation events were drained');
  });

test('Crystal: a frame loading does not finish the tab\'s own navigation',
  { skip: !nativeImplementation }, async () => {
    const destination = 'https://video.example/watch/9';
    const frameUrl = 'https://frame.example/player';
    const observations = await withEndpoint((message, peer) => {
      if (message.method === 'script.callFunction'
          && message.params.resultOwnership === 'root') {
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'node', handle: 'link-9', sharedId: 'shared-9' },
        } }));
        return;
      }
      if (message.method === 'script.callFunction'
          && message.params.functionDeclaration.includes('node.click()')) {
        // The tab's own navigation begins and one of its frames finishes
        // first. The tab's document has not arrived yet; only its frame has.
        peer.send(JSON.stringify({
          method: 'browsingContext.navigationStarted',
          params: { context: 'ctx-top', url: destination },
        }));
        peer.send(JSON.stringify({
          method: 'browsingContext.load',
          params: { context: 'ctx-child', url: frameUrl },
        }));
        peer.send(JSON.stringify({ id: message.id, type: 'success', result: {
          type: 'success', result: { type: 'boolean', value: true },
        } }));
        setTimeout(() => peer.send(JSON.stringify({
          method: 'browsingContext.domContentLoaded',
          params: { context: 'ctx-top', url: destination },
        })), 40);
        return;
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result: {} }));
    }, (url) => nativeImplementation.handleScenario(url, [
      { op: 'frame', context: 'ctx-top', url: 'https://search.example/results' },
      { op: 'activate_item', item: { role: 'link', name: 'Result 9', axIndex: 9 } },
      { op: 'page_url' },
    ]));

    assert.equal(observations[2], destination,
      'the frame event was consumed as the tab\'s own and the frame address recorded');
  });

if (nativeImplementation) {
  test('both runtimes put the same bytes on the wire', async () => {
    assert.deepEqual(runs.Crystal.received, runs.JavaScript.received);
    assert.deepEqual(runs.Crystal.observations, runs.JavaScript.observations);
  });
}
