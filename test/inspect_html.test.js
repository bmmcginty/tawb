'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { inspectBlocks } = require('../src/inspect_html');
const { ALL_SOURCES } = require('../src/core');

test('inspect replaces the old summary without adding a fifth view', () => {
  assert.deepEqual(ALL_SOURCES, ['ax', 'render', 'inspect', 'source']);
});

test('inspect pairs accessibility semantics with its backing markup', () => {
  const frame = {};
  const blocks = inspectBlocks([{
    role: 'slider',
    name: 'Position',
    value: '0:12 of 3:04',
    markup: '<input type="range">',
    shadow: 'user-agent',
    axIndex: 7,
  }], frame);

  assert.equal(
    blocks[0].text,
    '[Position: 0:12 of 3:04]    <input type="range"> #user-agent-shadow-root',
  );
  assert.equal(blocks[0].item.axIndex, 7);
  assert.strictEqual(blocks[0].item.frame, frame);
});

test('inspect identifies accessibility nodes with no DOM element', () => {
  const [block] = inspectBlocks([{ role: 'text', name: 'generated label' }], {});
  assert.match(block.text, /<generated-accessibility-node>/);
});
