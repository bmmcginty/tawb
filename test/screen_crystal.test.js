'use strict';

// The byte-level screen primitives, differenced between the JavaScript
// original and the Crystal port: the nano-style edited-row transaction that
// overwrites through the unchanged middle instead of repainting the row, and
// the cursor arithmetic that keeps the transaction in one write.

const test = require('node:test');
const assert = require('node:assert');

const { screenImplementations } = require('./crystal_impl');

const implementations = screenImplementations();

for (const implementation of implementations) {
  test(`${implementation.name}: an edited field rewrites its suffix like nano`, () => {
    const result = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: ab]',
      currentCol: 11, finalCol: 12,
    });
    const back = implementation.patchEditedLine({
      row: 7, before: '[Search: ab]', after: '[Search: a]',
      currentCol: 12, finalCol: 11,
    });

    const output = [...result.writes, ...back.writes].join('');
    assert.equal(result.changed, true);
    assert.equal(back.changed, true);
    assert.doesNotMatch(output, /\x1b\[2K/, 'editing erased the complete field row');
    assert.doesNotMatch(output, /Search/, 'editing rewrote the field label');
    assert.doesNotMatch(output, /\x1b\[\d*[@P]/, 'editing shifted terminal cells with ICH or DCH');
    assert.deepEqual(result.writes, ['b]\x08'],
      'the growing edit was one nano-style terminal transaction');
    assert.deepEqual(back.writes, ['\x08]\x1b[K\x08'],
      'the shrinking edit was one nano-style terminal transaction');
  });

  test(`${implementation.name}: an edited field keeps its absolute-position fallback in one write`, () => {
    const result = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: ab]', finalCol: 12,
    });
    assert.deepEqual(result.writes, ['\x1b[7;11Hb]\x08']);
  });

  test(`${implementation.name}: an unchanged row with nowhere to go writes nothing`, () => {
    const same = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: a]',
      currentCol: 11, finalCol: 11,
    });
    assert.equal(same.changed, false);
    assert.deepEqual(same.writes, []);

    // Unchanged text but the caret has moved: only the move is written.
    const moved = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: a]',
      currentCol: 9, finalCol: 11,
    });
    assert.equal(moved.changed, true);
    assert.deepEqual(moved.writes, ['\x1b[2C']);

    // Unchanged text with no known caret: an absolute move.
    const absolute = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: a]', finalCol: 4,
    });
    assert.deepEqual(absolute.writes, ['\x1b[7;4H']);

    // Unchanged text, no known current caret, and a final column: the
    // absolute move to where the caret belongs, since it cannot be known to
    // be there already.
    const nowhere = implementation.patchEditedLine({
      row: 7, before: '[Search: a]', after: '[Search: a]', finalCol: 11,
    });
    assert.equal(nowhere.changed, true);
    assert.deepEqual(nowhere.writes, ['\x1b[7;11H']);
  });

  test(`${implementation.name}: a shrinking edit clears its stale tail in the same transaction`, () => {
    const result = implementation.patchEditedLine({
      row: 3, before: 'alpha beta gamma', after: 'alpha', currentCol: 1, finalCol: 6,
    });
    // The shared prefix is the whole of the new text, so the write moves
    // right five cells and clears the stale tail; the caret already lands
    // where it belongs.
    assert.deepEqual(result.writes, ['\x1b[5C\x1b[K']);
  });

  test(`${implementation.name}: a mid-row edit overwrites from the first difference`, () => {
    const result = implementation.patchEditedLine({
      row: 2, before: 'one two three', after: 'one TWO three', currentCol: 13, finalCol: 8,
    });
    // Eight backspaces reach the first difference from column 13, the
    // replacement overwrites through the shared suffix, and six more
    // backspaces land the caret where it belongs — no absolute positioning,
    // and everything in one write.
    assert.deepEqual(result.writes, ['\b\b\b\b\b\b\b\bTWO three\b\b\b\b\b\b']);
  });
}
