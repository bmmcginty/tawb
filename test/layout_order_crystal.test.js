'use strict';

const test = require('node:test');
const assert = require('node:assert');

const layout = require('../src/layout_order');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

const rect = (top, left, width = 80, height = 20) => ({ top, left, width, height });
function block(text, box = null, extra = {}) {
  return {
    text,
    item: {
      name: text,
      identity: `item:${text}`,
      ...(box ? { visual: {
        rect: box, direction: 'ltr', writingMode: 'horizontal-tb', ...extra,
      } } : {}),
    },
  };
}

function compare(blocks, mode) {
  const expected = layout.orderBlocks(blocks, mode).map(({ text, item }) => ({ text, item }));
  assert.deepEqual(call('layout_order.order', { blocks, mode }), expected);
}

test('native rectangle ordering matches rows, direction and fallback', { skip }, () => {
  compare([
    block('lead'), block('reviews', rect(200, 10)), block('review note'),
    block('title', rect(10, 10)), block('title note'), block('price', rect(11, 300)),
  ], 'rectangle');

  compare([
    block('right', rect(10, 300), { direction: 'rtl' }),
    block('left', rect(10, 10), { direction: 'rtl' }),
  ], 'rectangle');

  compare([
    block('left top', rect(10, 100), { writingMode: 'vertical-rl' }),
    block('right low', rect(100, 300), { writingMode: 'vertical-rl' }),
    block('right top', rect(10, 300), { writingMode: 'vertical-rl' }),
  ], 'rectangle');
});

test('native default and overlapping orders match', { skip }, () => {
  const blocks = [
    block('first', rect(10, 10, 100, 30)),
    block('second', rect(11, 12, 100, 30)),
  ];
  compare(blocks, 'default');
  compare(blocks, 'rectangle');
});
