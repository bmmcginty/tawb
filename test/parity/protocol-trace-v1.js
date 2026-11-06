'use strict';

// Versioned canonical observation for protocol traffic. Callers provide the
// protocol-neutral facts they observed at the wire boundary; this serializer
// makes omission observable instead of letting each differential keep a
// different reduced shape.

const FIELDS = [
  'operation', 'source', 'target', 'arguments', 'result', 'error', 'handles',
];

// Ordered wire traffic is a separate contract from a page-function call. The
// latter describes one invocation in detail; this shape keeps the surrounding
// subscription, events, retries, deadline, and cleanup visible as well.
const TRAFFIC_FIELDS = [
  'sequence', 'engine', 'kind', 'operation', 'target', 'arguments',
  'deadlineMs', 'attempt', 'result', 'error', 'handles', 'cleanup',
];
const TRAFFIC_KINDS = new Set([
  'command', 'subscription', 'event', 'result', 'error', 'cleanup',
]);

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

function protocolTrafficV1(engine, records) {
  if (!['chromium', 'firefox'].includes(engine)) {
    throw new TypeError('protocol-trace-v1 traffic requires a known engine');
  }
  if (!Array.isArray(records)) throw new TypeError('protocol-trace-v1 traffic expects an array');
  return records.map((record, sequence) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} is not an object`);
    }
    const supplied = Object.keys(record);
    const allowed = TRAFFIC_FIELDS.filter((field) => !['sequence', 'engine'].includes(field));
    const unknown = supplied.filter((field) => !allowed.includes(field));
    if (unknown.length) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} has unknown field ${unknown[0]}`);
    }
    for (const field of allowed) {
      if (!own(record, field)) {
        throw new TypeError(`protocol-trace-v1 traffic record ${sequence} omits ${field}`);
      }
    }
    if (!TRAFFIC_KINDS.has(record.kind)) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} has invalid kind`);
    }
    if (typeof record.operation !== 'string' || !record.operation) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} has no operation`);
    }
    if (!Array.isArray(record.handles)) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} handles are not an array`);
    }
    if (!Number.isInteger(record.attempt) || record.attempt < 0) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} has invalid attempt`);
    }
    if (record.deadlineMs !== null
        && (!Number.isFinite(record.deadlineMs) || record.deadlineMs < 0)) {
      throw new TypeError(`protocol-trace-v1 traffic record ${sequence} has invalid deadlineMs`);
    }
    const complete = { sequence, engine, ...record };
    return Object.fromEntries(TRAFFIC_FIELDS.map((field) => [field, complete[field]]));
  });
}

function protocolTrafficDifference(engine, javascriptRecords, crystalRecords) {
  const javascript = protocolTrafficV1(engine, javascriptRecords);
  const crystal = protocolTrafficV1(engine, crystalRecords);
  const length = Math.max(javascript.length, crystal.length);
  for (let index = 0; index < length; index += 1) {
    if (JSON.stringify(javascript[index]) !== JSON.stringify(crystal[index])) {
      return { index, javascript: javascript[index] ?? null, crystal: crystal[index] ?? null };
    }
  }
  return null;
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
  FIELDS, TRAFFIC_FIELDS, protocolTraceV1, protocolTrafficV1,
  protocolTrafficDifference, cdpCallFunctionTrace, bidiCallFunctionTrace,
};
