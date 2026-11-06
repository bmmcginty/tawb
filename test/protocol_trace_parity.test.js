'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  FIELDS, TRAFFIC_FIELDS, protocolTraceV1, protocolTrafficV1,
  protocolTrafficDifference, cdpCallFunctionTrace, bidiCallFunctionTrace,
} = require('./parity/protocol-trace-v1');

// parity-id: asset.extract-ax-items

test('protocol-trace-v1 retains every invocation seam field', () => {
  const record = {
    operation: 'script.callFunction',
    source: '(options) => extract(options)',
    target: { context: 'frame-1' },
    arguments: [{ type: 'object', value: [['pierce', { type: 'boolean', value: true }]] }],
    result: { type: 'array', value: [] },
    error: null,
    handles: [{ action: 'dispose', id: '<handle-1>' }],
  };
  const [kept] = protocolTraceV1([record]);
  assert.deepEqual(Object.keys(kept), FIELDS);
  assert.deepEqual(kept, record);
});

test('protocol-trace-v1 refuses omitted and ad hoc fields', () => {
  const complete = {
    operation: 'Runtime.callFunctionOn', source: '() => true', target: null,
    arguments: [], result: true, error: null, handles: [],
  };
  assert.throws(
    () => protocolTraceV1([{ ...complete, target: undefined, arguments: undefined }]),
    /arguments are not an array/,
  );
  const { target: _target, ...withoutTarget } = complete;
  assert.throws(() => protocolTraceV1([withoutTarget]), /omits target/);
  assert.throws(() => protocolTraceV1([{ ...complete, context: 'hidden omission' }]),
    /unknown field context/);
});

function traffic(kind, operation, overrides = {}) {
  return {
    kind,
    operation,
    target: null,
    arguments: null,
    deadlineMs: null,
    attempt: 0,
    result: null,
    error: null,
    handles: [],
    cleanup: null,
    ...overrides,
  };
}

test('ordered protocol traffic retains subscriptions, events, retries, and cleanup', () => {
  const records = [
    traffic('subscription', 'session.subscribe', {
      arguments: { events: ['browsingContext.load'] }, deadlineMs: 30000, attempt: 1,
    }),
    traffic('result', 'session.subscribe'),
    traffic('command', 'browsingContext.navigate', {
      target: { context: 'main', frame: null },
      arguments: { url: 'https://next.test/', wait: 'interactive' },
      deadlineMs: 30000, attempt: 1,
    }),
    traffic('event', 'browsingContext.load', {
      target: { context: 'main', frame: null },
      arguments: { url: 'https://next.test/' },
    }),
    traffic('command', 'script.callFunction', {
      target: { context: 'child', frame: 'frame-1' },
      arguments: { functionDeclaration: '() => true' },
      deadlineMs: 5000, attempt: 1,
    }),
    traffic('error', 'script.callFunction', {
      target: { context: 'child', frame: 'frame-1' }, error: 'stale context',
    }),
    traffic('command', 'script.callFunction', {
      target: { context: 'main', frame: null },
      arguments: { functionDeclaration: '() => true' },
      deadlineMs: 5000, attempt: 2,
    }),
    traffic('cleanup', 'script.disown', {
      target: { context: 'main', frame: null },
      handles: ['handle-1'], cleanup: 'released result ownership', attempt: 1,
    }),
  ];
  const kept = protocolTrafficV1('firefox', records);
  assert.deepEqual(Object.keys(kept[0]), TRAFFIC_FIELDS);
  assert.deepEqual(kept.map(({ sequence }) => sequence), records.map((unused, index) => index));
  assert.equal(kept[0].engine, 'firefox');
  assert.equal(kept[4].target.frame, 'frame-1');
  assert.equal(kept[6].attempt, 2);
  assert.equal(kept[7].cleanup, 'released result ownership');
});

test('protocol traffic compares runtimes within an engine and reports ordered differences', () => {
  const javascript = [
    traffic('subscription', 'Page.enable', { deadlineMs: 30000, attempt: 1 }),
    traffic('command', 'Page.navigate', {
      target: { session: '<session>', frame: '<top>' },
      arguments: { url: 'https://next.test/' }, deadlineMs: 30000, attempt: 1,
    }),
    traffic('event', 'Page.loadEventFired', {
      target: { session: '<session>', frame: '<top>' }, arguments: {},
    }),
    traffic('cleanup', 'Target.detachFromTarget', {
      target: { session: '<session>', frame: '<top>' },
      cleanup: 'detached adopted target', attempt: 1,
    }),
  ];
  const crystal = structuredClone(javascript);
  assert.equal(protocolTrafficDifference('chromium', javascript, crystal), null);

  crystal[1].target.frame = '<child>';
  assert.deepEqual(protocolTrafficDifference('chromium', javascript, crystal), {
    index: 1,
    javascript: { sequence: 1, engine: 'chromium', ...javascript[1] },
    crystal: { sequence: 1, engine: 'chromium', ...crystal[1] },
  });
});

test('ordered protocol traffic refuses omitted metadata and cross-contract fields', () => {
  const complete = traffic('command', 'Runtime.evaluate', { attempt: 1, deadlineMs: 1000 });
  const { cleanup: _cleanup, ...withoutCleanup } = complete;
  assert.throws(() => protocolTrafficV1('chromium', [withoutCleanup]), /omits cleanup/);
  assert.throws(() => protocolTrafficV1('webkit', [complete]), /known engine/);
  assert.throws(() => protocolTrafficV1('chromium', [{ ...complete, requestId: 7 }]),
    /unknown field requestId/);
  assert.throws(() => protocolTrafficV1('chromium', [{ ...complete, attempt: -1 }]),
    /invalid attempt/);
});

test('CDP function calls preserve source, object target, and wire arguments', () => {
  const command = {
    method: 'Runtime.callFunctionOn',
    params: {
      functionDeclaration: '(vertical) => sliderTrack(this, vertical)',
      objectId: 'slider-object',
      arguments: [{ value: true }],
      awaitPromise: true,
      returnByValue: true,
    },
  };
  assert.deepEqual(cdpCallFunctionTrace(command), {
    operation: 'Runtime.callFunctionOn',
    source: command.params.functionDeclaration,
    target: { objectId: 'slider-object', executionContextId: null },
    arguments: command.params.arguments,
    result: null,
    error: null,
    handles: ['slider-object'],
  });
});

test('BiDi function calls preserve source, target, and wire arguments', () => {
  const command = {
    id: 7,
    method: 'script.callFunction',
    params: {
      functionDeclaration: '(options) => extractAxItems(options)',
      target: { context: 'child-context' },
      arguments: [{ type: 'object', value: [
        ['layout', { type: 'boolean', value: false }],
        ['pierce', { type: 'boolean', value: true }],
      ] }],
      awaitPromise: true,
      resultOwnership: 'none',
    },
  };
  assert.deepEqual(bidiCallFunctionTrace(command), {
    operation: 'script.callFunction',
    source: '(options) => extractAxItems(options)',
    target: { context: 'child-context' },
    arguments: command.params.arguments,
    result: null,
    error: null,
    handles: [],
  });
});
