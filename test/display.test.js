'use strict';

// The three classes of extra information and where a reader asked to hear
// them: context (the landmark, group, table cell), annotations (description,
// error, keystroke, described role, popup) and notes (asides).

const test = require('node:test');
const assert = require('node:assert');

const {
  displayMode, displaySettings, DEFAULTS,
} = require('../src/display');

test('a mode is one of the three, and nothing else is accepted', () => {
  for (const mode of ['inline', 'status', 'off']) assert.equal(displayMode('context', mode), mode);
  assert.equal(displayMode('context', undefined), DEFAULTS.context);
  assert.throws(() => displayMode('context', 'loud'), /Unknown context mode loud; use inline, status or off/);
  assert.deepEqual(displaySettings({ notes: 'off' }),
    { context: 'off', annotations: 'status', notes: 'off' });
});
