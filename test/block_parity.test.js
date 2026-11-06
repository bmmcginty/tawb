'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { blockV1 } = require('./parity/block-v1');
const { call } = require('./crystal_impl');

const crystalEnabled = process.env.TAWB_TEST_CRYSTAL === '1';

test('block-v1 retains the complete extraction contract', () => {
  const block = {
    kind: 'control',
    text: 'Save',
    startsBlock: true,
    isParagraph: false,
    spans: [{ start: 0, end: 4, metadata: { generated: true } }],
    item: {
      role: 'button',
      name: 'Save',
      nativeControl: { id: 7, route: ['shadow', 'button'] },
      href: '/save',
      futureExtractorField: { nested: 'retained' },
      absentProtocolField: null,
      frame: { protocolOwned: true },
      pressFrame: { protocolOwned: true },
    },
  };

  assert.deepEqual(blockV1(block), {
    kind: 'control',
    text: 'Save',
    startsBlock: true,
    isParagraph: false,
    spans: [{ end: 4, metadata: { generated: true }, start: 0 }],
    item: {
      frame: true,
      futureExtractorField: { nested: 'retained' },
      href: '/save',
      name: 'Save',
      nativeControl: { id: 7, route: ['shadow', 'button'] },
      pressFrame: true,
      role: 'button',
    },
  });
});

test('block-v1 makes omitted top-level fields observable', () => {
  assert.deepEqual(blockV1({ text: 'plain' }), {
    kind: null,
    text: 'plain',
    startsBlock: null,
    isParagraph: null,
    spans: null,
    item: null,
  });
});

test('Crystal emits the same block-v1 contract as JavaScript',
  { skip: !crystalEnabled }, () => {
    const block = {
      kind: 'control',
      text: 'Volume',
      startsBlock: false,
      isParagraph: true,
      spans: [{ start: 0, end: 6 }],
      item: {
        role: 'slider',
        value: '50%',
        nativeControl: { owner: 'media', path: [2, 4] },
        frame: 'native-protocol-context',
        futureExtractorField: { retained: true },
      },
    };
    assert.deepEqual(call('parity.block_v1', block), blockV1(block));
  });
