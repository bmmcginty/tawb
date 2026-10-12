'use strict';

// The interactive Chromium client, differenced between the JavaScript
// original and the Crystal port on the traffic it produces.
//
// Everything this client decides is decided before the socket: what a
// callFunctionOn looks like, which key events a keystroke becomes, that a
// click is three mouse events and not one, that a modified key inserts no
// text. None of that needs a browser to compare — it needs the commands, so
// both runtimes run the same script against a recording channel and the
// commands are what is compared.
//
// What a real Chromium then does with those commands is a separate question,
// and test/browser/crystal_dump.test.js is where the real browser answers.

const test = require('node:test');
const assert = require('node:assert');

const { CdpPage } = require('../src/cdp_page');
const { cdpImplementations } = require('./crystal_impl');

// The announcement every evaluation waits for: the main document saying which
// execution context it runs in.
const CONTEXT = {
  op: 'context',
  event: {
    method: 'Runtime.executionContextCreated',
    params: { context: { id: 7, auxData: { isDefault: true, frameId: 'MAIN' } } },
  },
};

// A quad is eight numbers: four corners, clockwise from the top left.
const QUADS = { quads: [[10, 20, 110, 20, 110, 70, 10, 70]] };

const replies = {
  // The JavaScript page is told its main document by the context that opened
  // it; the Crystal port reads the frame tree once for the same answer, so
  // the browser's reply to that is scripted too.
  'Page.getFrameTree': { frameTree: { frame: { id: 'MAIN' } } },
  'Runtime.callFunctionOn': { result: { value: 'answered', objectId: 'OBJECT-1' } },
  'DOM.getContentQuads': QUADS,
};

// The lifecycle a document reaches, as the browser announces it.
const lifecycle = (name, frameId = 'MAIN') => ({
  method: 'Page.lifecycleEvent', params: { frameId, name },
});

// Per-script replies and pushed events, where a script needs the browser to
// answer something of its own.
const navigation = {
  replies: {
    ...{},
    'Page.getFrameTree': { frameTree: { frame: { id: 'MAIN' } } },
    'Page.navigate': { loaderId: 'LOADER-1' },
    'Runtime.callFunctionOn': { result: { value: 'complete' } },
    'Page.getNavigationHistory': {
      currentIndex: 2,
      entries: [
        { id: 11, url: 'https://example.test/one' },
        { id: 12, url: 'https://example.test/two' },
        { id: 13, url: 'https://example.test/three' },
      ],
    },
  },
  // A document commits — which is what says where the tab actually ended up,
  // a redirect included — and then reaches its lifecycle.
  after: {
    'Page.navigate': [
      { method: 'Page.frameNavigated',
        params: { frame: { id: 'MAIN', url: 'https://example.test/landed' } } },
      lifecycle('load'),
    ],
    'Page.reload': [lifecycle('load')],
    'Page.navigateToHistoryEntry': [lifecycle('load')],
  },
};

const scripts = {
  'an evaluation runs in the document that announced a context': [
    CONTEXT,
    { op: 'evaluate', fn: '(n) => n + 1', arg: 41 },
    { op: 'sent' },
    // The bare-expression form, which is what evaluate('1 + 1') means.
    { op: 'evaluate', fn: 'document.readyState', expression: true },
    { op: 'sent' },
  ],

  'a held element is the called function\'s first argument': [
    CONTEXT,
    { op: 'evaluate_handle', fn: '() => document.body' },
    { op: 'sent' },
    { op: 'handle_evaluate', fn: '(el, name) => el.getAttribute(name)', arg: 'aria-label' },
    { op: 'sent' },
    { op: 'handle_dispose' },
    { op: 'sent' },
    // Disposing twice is one release: the reference is already gone.
    { op: 'handle_dispose' },
    { op: 'sent' },
  ],

  'an element is brought on screen before it is measured': [
    CONTEXT,
    { op: 'evaluate_handle', fn: '() => document.querySelector("button")' },
    { op: 'sent' },
    { op: 'handle_click_box' },
    { op: 'sent' },
  ],

  'a click is a move, a press and a release at the element\'s centre': [
    CONTEXT,
    { op: 'evaluate_handle', fn: '() => document.querySelector("button")' },
    { op: 'sent' },
    { op: 'handle_click' },
    { op: 'sent' },
    { op: 'handle_hover' },
    { op: 'sent' },
    // The download gesture: the same click with Chromium's Alt modifier bit.
    { op: 'handle_click', modifiers: 1 },
    { op: 'sent' },
  ],

  'typing is one keystroke per character, with the text on the keydown': [
    CONTEXT,
    { op: 'type', text: "a.'1" },
    { op: 'sent' },
  ],

  'a named key, a character key, and a modified key': [
    CONTEXT,
    { op: 'press', key: 'Enter' },
    { op: 'sent' },
    { op: 'press', key: 'ArrowRight' },
    { op: 'sent' },
    { op: 'press', key: 'x' },
    { op: 'sent' },
    { op: 'press', key: 'Shift+x' },
    { op: 'sent' },
    { op: 'press', key: 'Control+Backspace' },
    { op: 'sent' },
    { op: 'press', key: 'Control' },
    { op: 'sent' },
  ],

  'a key or modifier the driver does not know says so': [
    CONTEXT,
    { op: 'press', key: 'Hyper+a' },
    { op: 'press', key: 'MediaPlayPause' },
    { op: 'sent' },
  ],

  'a click at a point in the viewport': [
    CONTEXT,
    { op: 'click_at', x: 40.4, y: 60.6 },
    { op: 'sent' },
  ],
};

// Navigation is scripted separately because the browser has to answer for
// itself: a loader id for the document that committed, and the lifecycle it
// then reaches.
const navigationScripts = {
  'an address is navigated to and waited for': [
    CONTEXT,
    { op: 'goto', url: 'https://example.test/page' },
    { op: 'sent' },
  ],

  'the document is asked for again, with and without the cache': [
    CONTEXT,
    { op: 'reload' },
    { op: 'sent' },
    { op: 'reload', ignoreCache: true },
    { op: 'sent' },
    { op: 'stop_loading' },
    { op: 'sent' },
  ],

  'a state the document has already reached is not waited for': [
    CONTEXT,
    { op: 'seed_load_state' },
    { op: 'sent' },
    { op: 'wait_for_load_state' },
    { op: 'sent' },
  ],

  'going back is a move to the browser\'s own previous entry': [
    CONTEXT,
    { op: 'traverse_history', direction: -1 },
    { op: 'sent' },
  ],
};

const implementations = cdpImplementations({ CdpPage });

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);
  const run = (name) => implementation.scenario(scripts[name], replies);
  const navigate = (name) => implementation.scenario(
    navigationScripts[name], navigation.replies, navigation.after);

  check('an evaluation names its context and its function', async () => {
    const seen = await run('an evaluation runs in the document that announced a context');
    assert.equal(seen[1], 'answered');
    assert.deepEqual(seen[2], [{
      method: 'Runtime.callFunctionOn',
      sessionId: null,
      params: {
        functionDeclaration: '(n) => n + 1',
        arguments: [{ value: 41 }],
        returnByValue: true,
        awaitPromise: true,
        executionContextId: 7,
      },
    }]);
    assert.equal(seen[4][0].params.functionDeclaration,
      '() => { return (document.readyState); }',
      'an expression is wrapped into a function that returns it');
  });

  check('a handle call passes the element as the first argument', async () => {
    const seen = await run('a held element is the called function\'s first argument');
    assert.equal(seen[1], 'OBJECT-1', 'the page\'s own name for the object');
    assert.deepEqual(seen[2][0].params.returnByValue, undefined,
      'a handle call asks for the reference, not the value');
    assert.equal(seen[4][0].params.objectId, 'OBJECT-1');
    assert.equal(seen[4][0].params.functionDeclaration,
      'function (...rest) { return ((el, name) => el.getAttribute(name))(this, ...rest); }');
    assert.deepEqual(seen[4][0].params.arguments, [{ value: 'aria-label' }]);
    assert.deepEqual(seen[6], [{
      method: 'Runtime.releaseObject',
      sessionId: null,
      params: { objectId: 'OBJECT-1' },
    }]);
    assert.deepEqual(seen[8], [], 'the second disposal has nothing left to release');
  });

  check('a measurement scrolls first and reads the quads', async () => {
    const seen = await run('an element is brought on screen before it is measured');
    assert.deepEqual(seen[4].map((entry) => entry.method),
      ['DOM.scrollIntoViewIfNeeded', 'DOM.getContentQuads']);
    assert.deepEqual(seen[3], { x: 10, y: 20, width: 100, height: 50 });
  });

  check('a click is three mouse events, and a hover is one', async () => {
    const seen = await run('a click is a move, a press and a release at the element\'s centre');
    const clicked = seen[4].filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    assert.deepEqual(clicked.map((entry) => entry.params.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.deepEqual(clicked.map((entry) => [entry.params.x, entry.params.y]),
      [[60, 45], [60, 45], [60, 45]], 'the centre of the quad, in whole pixels');
    assert.deepEqual(clicked.map((entry) => entry.params.buttons), [0, 1, 0]);
    const hovered = seen[6].filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    assert.deepEqual(hovered.map((entry) => entry.params.type), ['mouseMoved'],
      'a pointer arriving somewhere is one event, and it stays where it was put');
    const altClicked = seen[8].filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    assert.deepEqual(altClicked.map((entry) => entry.params.modifiers), [1, 1, 1]);
  });

  check('typing carries the character on the keydown', async () => {
    const seen = await run('typing is one keystroke per character, with the text on the keydown');
    const events = seen[2];
    assert.equal(events.length, 8, 'four characters, down and up each');
    assert.deepEqual(events.map((entry) => entry.params.type),
      ['keyDown', 'keyUp', 'keyDown', 'keyUp', 'keyDown', 'keyUp', 'keyDown', 'keyUp']);
    assert.deepEqual(events[0].params, {
      key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      type: 'keyDown', text: 'a', unmodifiedText: 'a',
    });
    assert.equal(events[2].params.code, 'Period', 'a full stop is not the Delete key');
    assert.equal(events[2].params.windowsVirtualKeyCode, 190);
    assert.equal(events[4].params.code, 'Quote', 'an apostrophe is not ArrowRight');
    assert.equal(events[4].params.windowsVirtualKeyCode, 222);
    assert.equal(events[6].params.code, 'Digit1');
    assert.equal(events[1].params.text, undefined, 'a key release inserts nothing');
  });

  check('keys, characters and modifiers are pressed as the browser expects', async () => {
    const seen = await run('a named key, a character key, and a modified key');
    const enter = seen[2];
    assert.deepEqual(enter.map((entry) => entry.params.type), ['keyDown', 'keyUp']);
    assert.equal(enter[0].params.text, '\r', 'Enter inserts a carriage return');
    assert.equal(enter[0].params.windowsVirtualKeyCode, 13);

    const right = seen[4];
    assert.equal(right[0].params.type, 'rawKeyDown',
      'a key that inserts nothing is a raw keydown');
    assert.equal(right[0].params.windowsVirtualKeyCode, 39);

    const letter = seen[6];
    assert.equal(letter[0].params.text, 'x');
    assert.equal(letter[0].params.code, 'KeyX');

    const shifted = seen[8];
    assert.deepEqual(shifted.map((entry) => entry.params.type),
      ['keyDown', 'keyDown', 'keyUp', 'keyUp'], 'the modifier is held around the key');
    assert.equal(shifted[1].params.text, 'x', 'a shifted key still inserts its character');
    assert.deepEqual(shifted.map((entry) => entry.params.modifiers), [8, 8, 8, 0]);

    const command = seen[10];
    assert.equal(command[1].params.type, 'rawKeyDown');
    assert.equal(command[1].params.text, undefined,
      'Control+Backspace is a command, not a character');

    const modifierAlone = seen[12];
    assert.deepEqual(modifierAlone.map((entry) => entry.params.type), ['rawKeyDown', 'keyUp']);
    assert.equal(modifierAlone[0].params.windowsVirtualKeyCode, 17);
  });

  check('an unknown key is refused by name', async () => {
    const seen = await run('a key or modifier the driver does not know says so');
    assert.equal(seen[1], 'the Chromium driver has no modifier named "Hyper"');
    assert.equal(seen[2], 'the Chromium driver has no key named "MediaPlayPause"');
    assert.deepEqual(seen[3], [], 'and nothing was sent for either');
  });

  check('an address names the document it is replacing', async () => {
    const seen = await navigate('an address is navigated to and waited for');
    assert.equal(seen[1], 'https://example.test/landed',
      'the address that committed, not the one that was asked for');
    assert.deepEqual(seen[2], [{
      method: 'Page.navigate',
      sessionId: null,
      params: { url: 'https://example.test/page', frameId: 'MAIN' },
    }]);
  });

  check('a reload says whether the cache may answer', async () => {
    const seen = await navigate('the document is asked for again, with and without the cache');
    assert.deepEqual(seen[2], [{
      method: 'Page.reload', sessionId: null, params: { ignoreCache: false },
    }]);
    assert.deepEqual(seen[4], [{
      method: 'Page.reload', sessionId: null, params: { ignoreCache: true },
    }]);
    assert.deepEqual(seen[6], [{
      method: 'Page.stopLoading', sessionId: null, params: {},
    }]);
  });

  check('a document that has arrived is not waited for', async () => {
    const seen = await navigate('a state the document has already reached is not waited for');
    assert.deepEqual(seen[2].map((entry) => entry.method), ['Runtime.callFunctionOn'],
      'the readyState is asked once, when the tab is taken up');
    assert.equal(seen[3], true);
    assert.deepEqual(seen[4], [], 'and nothing is sent to wait for a load that happened');
  });

  check('going back names the entry rather than a count', async () => {
    const seen = await navigate('going back is a move to the browser\'s own previous entry');
    assert.equal(seen[1], true);
    assert.deepEqual(seen[2].map((entry) => entry.method),
      ['Page.getNavigationHistory', 'Page.navigateToHistoryEntry']);
    assert.deepEqual(seen[2][1].params, { entryId: 12 });
  });

  check('a point is clicked in whole pixels', async () => {
    const seen = await run('a click at a point in the viewport');
    const events = seen[2];
    assert.deepEqual(events.map((entry) => [entry.params.x, entry.params.y]),
      [[40, 61], [40, 61], [40, 61]]);
  });
}

if (implementations.length > 1) {
  const [javascript, crystal] = implementations;
  for (const [name, script] of Object.entries(scripts)) {
    test(`both runtimes agree: ${name}`, async () => {
      assert.deepEqual(await crystal.scenario(script, replies),
        await javascript.scenario(script, replies));
    });
  }
  for (const [name, script] of Object.entries(navigationScripts)) {
    test(`both runtimes agree: ${name}`, async () => {
      assert.deepEqual(
        await crystal.scenario(script, navigation.replies, navigation.after),
        await javascript.scenario(script, navigation.replies, navigation.after));
    });
  }
}
