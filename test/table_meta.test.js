'use strict';

// Table position travels on the item, through the block builder, untouched.
//
// The extractors put where a cell's content came from on the item they emit.
// Everything after that is shared code that must not lose it and must not
// behave differently because of it: the default interface's reading order and
// markers are decided without ever looking at the field.

const test = require('node:test');
const assert = require('node:assert');

const { buildBlocks, foldSeparatorBlocks } = require('../src/blocks');
const { renderLine } = require('../src/aria');
const { renderLynxItem } = require('../src/lynx_display');

const HEADER = { id: 1, row: 0, cell: 1, header: true, colspan: 2 };

test('an item that came from a cell keeps its cell through block building', () => {
  const items = [
    { role: 'text', name: 'Name', table: HEADER },
    { role: '__break__', name: '' },
    { role: 'link', name: 'Alpha', table: { id: 1, row: 1, cell: 0, header: false } },
  ];
  const blocks = buildBlocks(items);
  assert.deepEqual(blocks[0].item.table, HEADER);
  assert.deepEqual(blocks[1].item.table, { id: 1, row: 1, cell: 0, header: false });
});

test('prose joined inside one cell keeps that cell', () => {
  const cell = { id: 2, row: 0, cell: 0, header: false };
  const blocks = buildBlocks([
    { role: 'text', name: 'Bold', table: cell },
    { role: 'text', name: 'and emphasis', table: cell },
  ]);
  assert.equal(blocks.length, 1, 'the two runs are one line');
  assert.equal(blocks[0].text, 'Bold and emphasis');
  assert.deepEqual(blocks[0].item.table, cell);
});

test('a cell boundary still keeps two cells apart, each with its own place', () => {
  const folded = foldSeparatorBlocks([
    { text: 'A', item: { role: 'text', name: 'A', table: { id: 3, row: 0, cell: 0 } }, startsBlock: true },
    { text: 'B', item: { role: 'text', name: 'B', table: { id: 3, row: 0, cell: 1 } }, startsBlock: true },
  ]);
  assert.equal(folded.length, 2);
  assert.equal(folded[0].item.table.cell, 0);
  assert.equal(folded[1].item.table.cell, 1);
});

test('the table position changes no marker in either interface', () => {
  const link = { role: 'link', name: 'Alpha', table: { id: 1, row: 0, cell: 0 } };
  const plain = { role: 'link', name: 'Alpha' };
  assert.equal(renderLine(link), renderLine(plain));
  assert.equal(renderLine(link), '{Alpha}');
  assert.equal(renderLynxItem(link), renderLynxItem(plain));
  assert.equal(renderLynxItem(link), 'Alpha');

  const heading = { role: 'heading', name: 'Name', level: 2, table: { id: 1, row: 0, cell: 0, header: true } };
  assert.equal(renderLine(heading), '## Name');
  assert.equal(renderLynxItem(heading), 'Name');
});
