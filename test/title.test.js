'use strict';

// The page's title, on the first row of the window.
//
// It is what a page calls itself; before this the only way to hear it was to
// open the tab list. It costs a row of the viewport, so the row holds the
// title alone — the address sits on the row below it.

const test = require('node:test');
const assert = require('node:assert');

const { readTitle, drawTitle, drawAddress, drawHint, viewportHeight } = require('../src/index');

// What was written to the terminal, and which row each write landed on.
function capture(fn) {
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { fn(); } finally { process.stdout.write = real; }
  const text = written.join('');
  const rows = [...text.matchAll(/\x1b\[(\d+);\d+H\x1b\[2K([^\x1b]*)/g)]
    .map((m) => ({ row: Number(m[1]), text: m[2] }));
  return { text, rows };
}

function titleState(title) {
  return { title, drawn: { title: null, address: null, hint: null } };
}

test('a title is collapsed to one line and trimmed', async () => {
  assert.equal(await readTitle({ title: async () => '  Example\n\tDomain  ' }), 'Example Domain');
  assert.equal(await readTitle({ title: async () => 'Plain' }), 'Plain');
});

test('a page with no title, or one that will not answer, leaves the row empty', async () => {
  assert.equal(await readTitle({ title: async () => '' }), '');
  assert.equal(await readTitle({ title: async () => null }), '');
  // Closed, navigating, or an engine that refuses: not a reason to crash the
  // reader over a decoration.
  assert.equal(await readTitle({ title: async () => { throw new Error('closed'); } }), '');
});

test('the title is written to the first row of the window', () => {
  const state = titleState('Example Domain');
  const { rows } = capture(() => drawTitle(state));
  assert.deepEqual(rows, [{ row: 1, text: 'Example Domain' }]);
});

test('the address is on the row below the title, and the hint below that', () => {
  const state = {
    ...titleState('Example Domain'),
    mode: 'browse',
    core: { source: 'ax' },
  };
  const page = { url: () => 'https://example.com/' };
  const { rows } = capture(() => {
    drawTitle(state);
    drawAddress(state, page);
    drawHint(state);
  });
  assert.equal(rows.length, 3, 'the banner should be three written rows');
  assert.equal(rows[0].row, 1, 'the title is not on the first row');
  assert.equal(rows[1].row, 2, 'the address is not directly under the title');
  assert.equal(rows[2].row, 3, 'the hint is not directly under the address');
  assert.match(rows[1].text, /example\.com/, 'the address row lost the URL');
});

test('typing in the address bar rewrites its suffix like nano', () => {
  const state = {
    ...titleState('Example Domain'),
    mode: 'address',
    address: { text: 'example.co', caret: 8, scroll: 0 },
    core: { source: 'ax' },
  };
  const page = { url: () => 'https://old.example/' };
  capture(() => drawAddress(state, page, { force: true }));

  state.address.text = 'example.xco';
  state.address.caret += 1;
  const { text, rows } = capture(() => drawAddress(state, page, { edit: true }));
  assert.deepEqual(rows, [], 'typing repainted the complete address row');
  assert.doesNotMatch(text, /\x1b\[2K/, 'typing erased the complete address row');
  assert.doesNotMatch(text, /\x1b\[\d*[@P]/, 'typing shifted terminal cells with ICH or DCH');
  assert.equal(text, 'xco\x08\x08', 'typing was not one nano-style terminal transaction');

  state.address.caret -= 1;
  assert.equal(capture(() => drawAddress(state, page, { edit: true })).text, '\x08',
    'moving left used absolute positioning instead of backspace');
});

test('an unchanged title is not rewritten, because a repaint is re-read', () => {
  const state = titleState('Example Domain');
  capture(() => drawTitle(state));
  // A screen reader re-reads a repainted row and a braille display re-flashes
  // it, whether or not it now says anything different.
  assert.deepEqual(capture(() => drawTitle(state)).rows, [], 'the same title was drawn twice');
  assert.deepEqual(capture(() => drawTitle(state, { force: true })).rows,
    [{ row: 1, text: 'Example Domain' }], 'a forced redraw was skipped');

  state.title = 'Somewhere Else';
  assert.deepEqual(capture(() => drawTitle(state)).rows,
    [{ row: 1, text: 'Somewhere Else' }], 'a changed title was not drawn');
});

test('a title longer than the window is cut to it', () => {
  const state = titleState('x'.repeat(500));
  const { rows } = capture(() => drawTitle(state));
  assert.equal(rows[0].text.length, process.stdout.columns || 80,
    'the title row ran past the edge of the window');
});

test('the title row is taken out of the reading area, not overlaid on it', () => {
  // Four header rows now — title, address, hint, blank — and two at the foot.
  assert.equal(viewportHeight(), Math.max(1, (process.stdout.rows || 24) - 4 - 2));
});
