'use strict';

// The element half of the place-keeping policy, differenced between the
// JavaScript original and the Crystal port: the same captures, the same
// element lookups, the same choice of fallback when the element lookup only
// guessed. The page itself is scripted, so what is compared is the
// orchestration either side of the page — which answer wins, and whether the
// held element is let go of exactly once.

const test = require('node:test');
const assert = require('node:assert');

const placeModule = require('../src/place');
const { placeElementImplementations } = require('./crystal_impl');

// One view, with an element on its first and third lines and prose between.
const AX_BLOCKS = [
  { text: 'Top story', item: { name: 'Top story', role: 'link', axIndex: 0 } },
  { text: 'A paragraph that runs on', item: { role: 'text', name: '' } },
  { text: 'Second story', item: { name: 'Second story', role: 'link', axIndex: 2 } },
];
const AX_LINES = [
  { text: 'Top story', blockIndex: 0 },
  { text: 'A paragraph that runs on', blockIndex: 1 },
  { text: 'Second story', blockIndex: 2 },
];

// The same page as PAGE renders it: the visible strings are the same ones,
// so a captured text can match a block exactly, and the elements are indexed
// by the PAGE view's own node array.
const RENDER_BLOCKS = [
  { text: 'Top story', item: { name: 'Top story', renderIndex: 1 } },
  { text: 'Article', item: { name: 'Article', renderIndex: 3 } },
  { text: 'A paragraph that runs on', item: { role: 'text', name: '' } },
  { text: 'Second story', item: { name: 'Second story', renderIndex: 8 } },
];
const RENDER_LINES = [
  { text: 'Top story', blockIndex: 0 },
  { text: 'Article', blockIndex: 1 },
  { text: 'A paragraph that runs on', blockIndex: 2 },
  { text: 'Second story', blockIndex: 3 },
];

// The same page as markup: more lines, different numbering, the elements
// indexed by the SOURCE view's own node array, and no block whose text is
// exactly what either of the other two views showed.
const SOURCE_BLOCKS = [
  { text: '<html>', item: { name: 'html', domIndex: 0 } },
  { text: '<a href="/top">Top story</a>', item: { name: 'a', domIndex: 4 } },
  { text: '<p>', item: { name: 'p', domIndex: 5 } },
  { text: '  A paragraph that runs on', item: { role: 'text', name: '' } },
  { text: '<a href="/second">Second story</a>', item: { name: 'a', domIndex: 9 } },
];
const SOURCE_LINES = [
  { text: '<html>', blockIndex: 0 },
  { text: '<a href="/top">Top story</a>', blockIndex: 1 },
  { text: '<p>', blockIndex: 2 },
  { text: '  A paragraph that runs on', blockIndex: 3 },
  { text: '<a href="/second">Second story</a>', blockIndex: 4 },
];

// Two frames, both carrying the same node-array entry, so only the frame
// tells the held element's own block from the other one.
const FRAMED_BLOCKS = [
  { text: 'main copy', item: { name: 'main copy', axIndex: 7, frame: 'main' } },
  { text: 'iframe copy', item: { name: 'iframe copy', axIndex: 7, frame: 'inner' } },
];
const FRAMED_LINES = [
  { text: 'main copy', blockIndex: 0 },
  { text: 'iframe copy', blockIndex: 1 },
];

const DESCRIBED = { label: 'Second story', ordinal: 9, total: 40 };

const scripts = {
  'a capture on the element holds it and carries what the page said': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 3 },
    { op: 'elements', description: DESCRIBED },
    { op: 'capture_place' },
    { op: 'elements_seen' },
  ],

  'a capture on prose anchors to the element above it': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 1, col: 2 },
    { op: 'elements', description: { label: 'Top story', ordinal: 4, total: 40 } },
    { op: 'capture_place' },
    { op: 'elements_seen' },
  ],

  'a page that will not describe the element leaves the text fallbacks': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 0 },
    { op: 'elements', description: null },
    { op: 'capture_place' },
    { op: 'elements_seen' },
  ],

  'a reference that cannot be resolved leaves the text fallbacks': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 0 },
    { op: 'elements', refuses: true },
    { op: 'capture_place' },
    { op: 'elements_seen' },
  ],

  'the element itself is found in the view being entered': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 4 },
    { op: 'elements', description: DESCRIBED },
    { op: 'capture_place' },
    { op: 'state', source: 'render', blocks: RENDER_BLOCKS, lines: RENDER_LINES, cursor: 0, col: 0 },
    { op: 'elements', description: DESCRIBED, location: { index: 8, exact: true } },
    { op: 'restore_place' },
    { op: 'cursor' },
    { op: 'elements_seen' },
  ],

  'an ancestor match loses to a line whose text is exactly right': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 0 },
    { op: 'elements', description: DESCRIBED },
    { op: 'capture_place' },
    // The element resolved to the article containing it, two lines above the
    // line the reader was actually on.
    { op: 'state', source: 'render', blocks: RENDER_BLOCKS, lines: RENDER_LINES, cursor: 0, col: 0 },
    { op: 'elements', description: DESCRIBED, location: { index: 3, exact: false } },
    { op: 'restore_place' },
    { op: 'cursor' },
  ],

  'an ancestor match keeps its neighbourhood when the text is only partial': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 1, col: 0 },
    { op: 'elements', description: { label: 'Top story', ordinal: 4, total: 40 } },
    { op: 'capture_place' },
    { op: 'state', source: 'source', blocks: SOURCE_BLOCKS, lines: SOURCE_LINES, cursor: 0, col: 0 },
    { op: 'elements',
      description: { label: 'Top story', ordinal: 4, total: 40 },
      location: { index: 0, exact: false } },
    { op: 'restore_place' },
    { op: 'cursor' },
  ],

  'an element in no block of the new view falls back to the text': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 0 },
    { op: 'elements', description: DESCRIBED },
    { op: 'capture_place' },
    { op: 'state', source: 'render', blocks: RENDER_BLOCKS, lines: RENDER_LINES, cursor: 0, col: 0 },
    { op: 'elements', description: DESCRIBED, location: { index: 31, exact: true } },
    { op: 'restore_place' },
    { op: 'cursor' },
    { op: 'elements_seen' },
  ],

  'a view with no node array is never asked about the element': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 2, col: 0 },
    { op: 'elements', description: DESCRIBED },
    { op: 'capture_place' },
    { op: 'state', source: 'playwright-ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 0, col: 0 },
    { op: 'elements', description: DESCRIBED, location: { index: 2, exact: true } },
    { op: 'restore_place' },
    { op: 'cursor' },
    { op: 'elements_seen' },
  ],

  'a block in another frame does not answer for the held element': [
    { op: 'state', source: 'ax', blocks: FRAMED_BLOCKS, lines: FRAMED_LINES, cursor: 1, col: 0 },
    { op: 'elements',
      description: { label: 'iframe copy', ordinal: 7, total: 20 },
      location: { index: 7, exact: true } },
    { op: 'capture_place' },
    { op: 'locate_by_element' },
    { op: 'cursor' },
  ],

  'a place with nothing held is located by text alone': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 0, col: 0 },
    { op: 'elements', location: { index: 2, exact: true } },
    { op: 'restore_place', place: {
      text: 'Second story', col: 0, onElement: true, label: 'Second story',
      ordinal: null, total: null, ratio: 0.9, source: 'ax', held: false,
    } },
    { op: 'cursor' },
    { op: 'elements_seen' },
  ],

  'nothing to restore leaves the cursor alone': [
    { op: 'state', source: 'ax', blocks: AX_BLOCKS, lines: AX_LINES, cursor: 1, col: 2 },
    { op: 'restore_place', place: null },
    { op: 'cursor' },
    { op: 'elements_seen' },
  ],
};

const implementations = placeElementImplementations(placeModule);

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);
  const run = (name) => implementation.scenario(scripts[name]);

  check('a capture on the element holds it and says so', async () => {
    const seen = await run('a capture on the element holds it and carries what the page said');
    assert.deepEqual(seen[2], {
      source: 'ax',
      text: 'Second story',
      col: 3,
      ratio: 2 / 3,
      onElement: true,
      label: 'Second story',
      ordinal: 9,
      total: 40,
      held: true,
      frame: null,
    });
    assert.deepEqual(seen[3].described, [AX_BLOCKS[2].item],
      'the cursor\'s own block is the element that was described');
    assert.equal(seen[3].releases, 0, 'a held element is let go of by the restore');
  });

  check('a capture on prose anchors above it', async () => {
    const seen = await run('a capture on prose anchors to the element above it');
    assert.equal(seen[2].onElement, false);
    assert.equal(seen[2].text, 'A paragraph that runs on');
    assert.equal(seen[2].label, 'Top story');
    assert.equal(seen[2].held, true);
    assert.deepEqual(seen[3].described, [AX_BLOCKS[0].item],
      'the nearest element above the prose is the one described');
  });

  check('an undescribed element is let go of at once', async () => {
    const seen = await run('a page that will not describe the element leaves the text fallbacks');
    assert.equal(seen[2].held, false);
    assert.equal(seen[2].label, '');
    assert.equal(seen[2].ordinal, null);
    assert.equal(seen[2].total, null);
    assert.equal(seen[3].releases, 1, 'the handle it could not describe is disposed of');
  });

  check('an unresolvable reference holds nothing', async () => {
    const seen = await run('a reference that cannot be resolved leaves the text fallbacks');
    assert.equal(seen[2].held, false);
    assert.equal(seen[2].text, 'Second story', 'the text fallbacks are still there');
    assert.equal(seen[3].releases, 0, 'nothing was held, so nothing is let go of');
  });

  check('the element itself wins, and is let go of once', async () => {
    const seen = await run('the element itself is found in the view being entered');
    assert.equal(seen[5], 'exact');
    assert.deepEqual(seen[6], { cursor: 3, col: 4 },
      'the PAGE line for that element, keeping the column within its text');
    assert.deepEqual(seen[7].arrays, ['tweb.render'],
      'the PAGE view is asked about its own node array');
    assert.equal(seen[7].releases, 1);
  });

  check('an exact text match beats an ancestor match', async () => {
    const seen = await run('an ancestor match loses to a line whose text is exactly right');
    assert.equal(seen[5], 'exact');
    assert.deepEqual(seen[6], { cursor: 3, col: 0 },
      'the line whose text is what the reader was reading, not the container');
  });

  check('a partial text match loses to the element neighbourhood', async () => {
    const seen = await run('an ancestor match keeps its neighbourhood when the text is only partial');
    assert.equal(seen[5], 'near');
    assert.deepEqual(seen[6], { cursor: 3, col: 2 },
      'the prose found below where the ancestor landed, at the column it starts in');
  });

  check('an element no block carries falls back to the text', async () => {
    const seen = await run('an element in no block of the new view falls back to the text');
    assert.equal(seen[5], 'exact');
    assert.deepEqual(seen[6], { cursor: 3, col: 0 });
    assert.equal(seen[7].releases, 1, 'the held element is still let go of');
  });

  check('a view with no node array is not asked', async () => {
    const seen = await run('a view with no node array is never asked about the element');
    assert.deepEqual(seen[7].arrays, [], 'there was no array to ask about');
    assert.equal(seen[7].releases, 1);
  });

  check('the frame decides which block answers', async () => {
    const seen = await run('a block in another frame does not answer for the held element');
    assert.equal(seen[3], 'exact');
    assert.deepEqual(seen[4], { cursor: 1, col: 0 },
      'the block in the frame the element came from');
  });

  check('a place holding nothing is found by text', async () => {
    const seen = await run('a place with nothing held is located by text alone');
    assert.equal(seen[2], 'exact');
    assert.deepEqual(seen[3], { cursor: 2, col: 0 });
    assert.deepEqual(seen[4], { described: [], arrays: [], releases: 0 },
      'the page is never asked when nothing is held');
  });

  check('no place leaves the cursor alone', async () => {
    const seen = await run('nothing to restore leaves the cursor alone');
    assert.equal(seen[1], null);
    assert.deepEqual(seen[2], { cursor: 1, col: 2 });
    assert.deepEqual(seen[3].releases, 0);
  });
}

if (implementations.length > 1) {
  const [javascript, crystal] = implementations;
  for (const [name, script] of Object.entries(scripts)) {
    test(`both runtimes agree: ${name}`, async () => {
      assert.deepEqual(await crystal.scenario(script), await javascript.scenario(script));
    });
  }
}
