'use strict';

const test = require('node:test');
const assert = require('node:assert');
const javascript = require('../src/bidi');
const { bidiImplementations } = require('./crystal_impl');

for (const implementation of bidiImplementations(javascript)) {
  const decode = implementation.fromRemoteValue;
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('BiDi scalar remote values become host values', () => {
    assert.equal(decode(null), null);
    assert.equal(decode({ type: 'null' }), null);
    assert.equal(decode({ type: 'string', value: 'hello' }), 'hello');
    assert.equal(decode({ type: 'boolean', value: true }), true);
    assert.equal(decode({ type: 'number', value: 42.5 }), 42.5);
  });

  check('BiDi arrays and sets decode recursively', () => {
    assert.deepEqual(decode({
      type: 'array',
      value: [
        { type: 'string', value: 'one' },
        { type: 'array', value: [{ type: 'number', value: 2 }] },
        { type: 'null' },
      ],
    }), ['one', [2], null]);
    assert.deepEqual(decode({
      type: 'set', value: [{ type: 'boolean', value: false }],
    }), [false]);
  });

  check('BiDi objects and maps decode tagged keys and values', () => {
    assert.deepEqual(decode({
      type: 'object',
      value: [
        ['name', { type: 'string', value: 'TAWB' }],
        [{ type: 'number', value: 7 }, { type: 'boolean', value: true }],
      ],
    }), { name: 'TAWB', 7: true });
  });

  check('unflattened BiDi references retain their protocol identities', () => {
    assert.deepEqual(decode({
      type: 'node', handle: 'handle-1', sharedId: 'shared-1',
    }), { handle: 'handle-1', sharedId: 'shared-1' });
    assert.equal(decode({ type: 'window' }), null);
  });
}
