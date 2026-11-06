'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  FIELDS, protocolTraceV1, cdpCallFunctionTrace, bidiCallFunctionTrace,
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
