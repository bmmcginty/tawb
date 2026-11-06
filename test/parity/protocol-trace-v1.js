'use strict';

// Versioned canonical observation for protocol traffic. Callers provide the
// protocol-neutral facts they observed at the wire boundary; this serializer
// makes omission observable instead of letting each differential keep a
// different reduced shape.

const FIELDS = [
  'operation', 'source', 'target', 'arguments', 'result', 'error', 'handles',
];

function own(record, field) {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function protocolTraceV1(records) {
  if (!Array.isArray(records)) throw new TypeError('protocol-trace-v1 expects an array');
  return records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`protocol-trace-v1 record ${index} is not an object`);
    }
    for (const field of FIELDS) {
      if (!own(record, field)) {
        throw new TypeError(`protocol-trace-v1 record ${index} omits ${field}`);
      }
    }
    const unknown = Object.keys(record).filter((field) => !FIELDS.includes(field));
    if (unknown.length) {
      throw new TypeError(`protocol-trace-v1 record ${index} has unknown field ${unknown[0]}`);
    }
    if (typeof record.operation !== 'string' || !record.operation) {
      throw new TypeError(`protocol-trace-v1 record ${index} has no operation`);
    }
    if (!Array.isArray(record.arguments)) {
      throw new TypeError(`protocol-trace-v1 record ${index} arguments are not an array`);
    }
    if (!Array.isArray(record.handles)) {
      throw new TypeError(`protocol-trace-v1 record ${index} handles are not an array`);
    }
    return Object.fromEntries(FIELDS.map((field) => [field, record[field]]));
  });
}

function cdpCallFunctionTrace(message) {
  if (!message || message.method !== 'Runtime.callFunctionOn') {
    throw new TypeError('expected a CDP Runtime.callFunctionOn command');
  }
  const params = message.params || {};
  return protocolTraceV1([{
    operation: message.method,
    source: params.functionDeclaration ?? null,
    target: {
      objectId: params.objectId ?? null,
      executionContextId: params.executionContextId ?? null,
    },
    arguments: params.arguments ?? [],
    result: null,
    error: null,
    handles: params.objectId == null ? [] : [params.objectId],
  }])[0];
}

function bidiCallFunctionTrace(message) {
  if (!message || message.method !== 'script.callFunction') {
    throw new TypeError('expected a BiDi script.callFunction command');
  }
  const params = message.params || {};
  return protocolTraceV1([{
    operation: message.method,
    source: params.functionDeclaration ?? null,
    target: params.target ?? null,
    arguments: params.arguments ?? [],
    result: null,
    error: null,
    handles: [],
  }])[0];
}

module.exports = {
  FIELDS, protocolTraceV1, cdpCallFunctionTrace, bidiCallFunctionTrace,
};
