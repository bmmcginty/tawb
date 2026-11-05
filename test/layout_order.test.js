'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { orderBlocks } = require('../src/layout_order');

function block(name, rect = null, extra = {}) {
  return {
    text: name,
    item: {
      name,
      identity: `item:${name}`,
      ...(rect ? { visual: { rect, direction: 'ltr', writingMode: 'horizontal-tb', ...extra } } : {}),
    },
  };
}
const names = (blocks) => blocks.map((one) => one.text);
const r = (top, left, width = 80, height = 20) => ({ top, left, width, height });

test('default layout preserves the exact block order and objects', () => {
  const blocks = [block('title', r(0, 0)), block('reviews', r(100, 0)), block('price', r(0, 200))];
  const ordered = orderBlocks(blocks, 'default');
  assert.deepEqual(names(ordered), ['title', 'reviews', 'price']);
  assert.equal(ordered[2], blocks[2]);
});

test('rectangle layout orders visual rows before inline positions', () => {
  const blocks = [
    block('title', r(10, 10)),
    block('reviews', r(200, 10)),
    block('price', r(11, 300)),
    block('delivery', r(70, 300)),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'rectangle')),
    ['title', 'price', 'delivery', 'reviews']);
});

test('rectangle layout follows RTL inline order', () => {
  const extra = { direction: 'rtl' };
  const blocks = [block('right', r(10, 300), extra), block('left', r(10, 10), extra)];
  assert.deepEqual(names(orderBlocks(blocks, 'rectangle')), ['right', 'left']);
});

test('rectangle layout follows vertical-rl columns then top to bottom', () => {
  const extra = { writingMode: 'vertical-rl' };
  const blocks = [
    block('left top', r(10, 100), extra),
    block('right low', r(100, 300), extra),
    block('right top', r(10, 300), extra),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'rectangle')),
    ['right top', 'right low', 'left top']);
});

test('substantially overlapping rectangles retain document order', () => {
  const blocks = [block('first', r(10, 10, 100, 30)), block('second', r(11, 12, 100, 30))];
  assert.deepEqual(names(orderBlocks(blocks, 'rectangle')), ['first', 'second']);
});

test('unplaced blocks remain attached to their document predecessor', () => {
  const blocks = [
    block('generated lead'),
    block('reviews', r(200, 10)),
    block('review note'),
    block('title', r(10, 10)),
    block('title note'),
    block('price', r(10, 300)),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'rectangle')), [
    'generated lead', 'title', 'title note', 'price', 'reviews', 'review note',
  ]);
});

test('rectangle layout preserves identity and activation metadata', () => {
  const blocks = [block('later', r(100, 0)), block('first', r(0, 0))];
  blocks[0].item.href = 'https://example.com/later';
  const ordered = orderBlocks(blocks, 'rectangle');
  assert.equal(ordered[1], blocks[0]);
  assert.equal(ordered[1].item.href, 'https://example.com/later');
});

function grouped(name, box, group, {
  container = 1, kind = 'grid', direction = 'ltr', writingMode = 'horizontal-tb', position = 'static',
} = {}) {
  const one = block(name, box);
  one.item.visual.path = [{
    container, group, kind, direction, writingMode, position, rect: box,
  }];
  return one;
}

test('container layout moves a Walmart-like purchase card beside its heading', () => {
  const blocks = [
    grouped('Product', r(10, 10), 10),
    grouped('Reviews', r(200, 10), 20),
    grouped('Current price is $10.50', r(10, 300), 30, { position: 'sticky' }),
    grouped('One-time purchase', r(10, 300), 30, { position: 'sticky' }),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'container')),
    ['Product', 'Current price is $10.50', 'One-time purchase', 'Reviews']);
});

test('container layout keeps a moved child group coherent', () => {
  const blocks = [
    grouped('late heading', r(100, 0), 1),
    grouped('late prose', r(100, 0), 1),
    grouped('early heading', r(0, 0), 2),
    grouped('early control', r(0, 0), 2),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'container')),
    ['early heading', 'early control', 'late heading', 'late prose']);
});

test('container layout leaves normal flow and overlapping groups alone', () => {
  const ordinary = [block('one', r(100, 0)), block('two', r(0, 0))];
  assert.deepEqual(names(orderBlocks(ordinary, 'container')), ['one', 'two']);

  const overlap = [
    grouped('first card', r(10, 10, 100, 40), 1),
    grouped('second card', r(11, 12, 100, 40), 2),
  ];
  assert.deepEqual(names(orderBlocks(overlap, 'container')), ['first card', 'second card']);
});

test('container layout orders CSS columns down each column in inline order', () => {
  const blocks = [
    grouped('right top', r(0, 200), 1, { kind: 'columns' }),
    grouped('left low', r(100, 0), 2, { kind: 'columns' }),
    grouped('left top', r(0, 0), 3, { kind: 'columns' }),
  ];
  assert.deepEqual(names(orderBlocks(blocks, 'container')), ['left top', 'left low', 'right top']);
});

test('container layout applies nested containers from the inside out', () => {
  const blocks = [
    grouped('outer late / inner late', r(100, 0), 10),
    grouped('outer late / inner early', r(100, 0), 10),
    grouped('outer early', r(0, 0), 20),
  ];
  blocks[0].item.visual.path.push({
    container: 2, group: 101, kind: 'flex', direction: 'ltr', writingMode: 'horizontal-tb', rect: r(110, 0),
  });
  blocks[1].item.visual.path.push({
    container: 2, group: 102, kind: 'flex', direction: 'ltr', writingMode: 'horizontal-tb', rect: r(100, 0),
  });
  assert.deepEqual(names(orderBlocks(blocks, 'container')),
    ['outer early', 'outer late / inner early', 'outer late / inner late']);
});
