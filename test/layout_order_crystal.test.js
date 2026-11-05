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

function grouped(text, box, group, {
  container = 1, kind = 'grid', direction = 'ltr', position = 'static',
} = {}) {
  const one = block(text, box);
  one.item.visual.path = [{
    container, group, kind, direction, writingMode: 'horizontal-tb', position, rect: box,
  }];
  return one;
}

test('native container ordering matches grids, coherent cards and columns', { skip }, () => {
  compare([
    grouped('Product', rect(10, 10), 10),
    grouped('Reviews', rect(200, 10), 20),
    grouped('Current price is $10.50', rect(10, 300), 30, { position: 'sticky' }),
    grouped('One-time purchase', rect(10, 300), 30, { position: 'sticky' }),
  ], 'container');

  compare([
    grouped('right top', rect(0, 200), 1, { kind: 'columns' }),
    grouped('left low', rect(100, 0), 2, { kind: 'columns' }),
    grouped('left top', rect(0, 0), 3, { kind: 'columns' }),
  ], 'container');

  compare([
    grouped('first card', rect(10, 10, 100, 40), 1),
    grouped('second card', rect(11, 12, 100, 40), 2),
  ], 'container');
});
