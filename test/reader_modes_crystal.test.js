'use strict';

// The modes that fill a form in — typing, adjusting a slider, Lynx's
// one-command escape, and forms mode — differenced between the JavaScript
// original and the Crystal port, keystroke by keystroke.

const test = require('node:test');
const assert = require('node:assert');

const { readerImplementations } = require('./crystal_impl');

const implementations = readerImplementations(
  require('../src/index'), require('../src/keys'));
const needsCrystal = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

const PAGE_URL = 'https://example.test/form.html';

function linesFor(blocks) {
  return blocks.map((block, index) => ({ text: block.text, blockIndex: index }));
}

function stateFor(blocks, overrides = {}, coreOverrides = {}) {
  const core = {
    source: 'ax', blocks, popup: null, popupAt: -1,
    ...coreOverrides,
  };
  return {
    rows: 24, cols: 80, mode: 'browse', interface: 'default',
    cursor: 1, col: 0, scroll: 0, title: 'Example',
    lines: linesFor(blocks),
    core,
    driver: { name: 'firefox' },
    statusMsg: '', drawn: {}, linkAddress: false,
    ...overrides,
  };
}

function typingState(item, text, caret, drawn, overrides = {}, coreOverrides = {}) {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: `[${item.name}]`, item },
    { text: 'footer', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, {
    mode: 'type',
    typing: { item, text, caret, drawn },
    ...overrides,
  }, coreOverrides);
  return state;
}

async function runBoth(name, state, actions, page = {}) {
  const results = [];
  for (const implementation of implementations) {
    const spec = JSON.parse(JSON.stringify({ state, actions, page }));
    results.push(await (implementation.drawAsync
      ? implementation.drawAsync(spec)
      : Promise.resolve(implementation.draw(spec))));
  }
  assert.deepEqual(results[1].state, results[0].state, name);
  assert.deepEqual(results[1].results, results[0].results, name);
  return results[0];
}

const SEARCH = { role: 'searchbox', name: 'Search' };
const EMAIL = { role: 'searchbox', name: 'Email' };
const SAVE = { role: 'button', name: 'Save' };

test('escape leaves the field and repaints the row it was drawn on', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: 'footer', item: { role: 'text' } },
  ];
  const fresh = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: 'footer', item: { role: 'text' } },
  ];
  const state = typingState(SEARCH, 'hello', 5, '[Search: hello]', {}, {
    rescanBlocks: fresh,
  });
  const result = await runBoth('escape typing', state, [
    { op: 'typeKey', chunk: '\x1b' },
  ], { url: PAGE_URL, title: 'Example' });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.typing, null);
  assert.equal(result.state.statusMsg, 'Stopped typing into "Search".');
  assert.equal(result.state.typingReads, 0);
  assert.equal(result.state.typingReleased, false, 'the field handle is kept until the next field replaces it');
});

test('typing sends the key and reads the field back', { skip: needsCrystal }, async () => {
  const state = typingState(SEARCH, 'hello', 5, '[Search: hello]', {}, {
    typedFields: [{ text: 'hellox', caret: 6, native: true }],
  });
  const result = await runBoth('type a character', state, [
    { op: 'typeKey', chunk: 'x' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.typing, { text: 'hellox', caret: 6 });
  assert.equal(result.state.typingReads, 1);
  assert.ok(result.results[0].writes.length > 0, 'the field row was rewritten');
});

test('a backspace goes to the browser as the editing key it is', { skip: needsCrystal }, async () => {
  const state = typingState(SEARCH, 'hello', 5, '[Search: hello]', {}, {
    typedFields: [{ text: 'hell', caret: 4, native: true }],
  });
  const result = await runBoth('backspace', state, [
    { op: 'typeKey', chunk: '\x7f' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.typing, { text: 'hell', caret: 4 });
});

test('escape sequences nobody claimed are left for the page to ignore', { skip: needsCrystal }, async () => {
  const state = typingState(SEARCH, 'hello', 5, '[Search: hello]', {}, {
    typedFields: [],
  });
  const result = await runBoth('unknown escape', state, [
    { op: 'typeKey', chunk: '\x1b[1;5A' },
  ], { url: PAGE_URL });
  assert.deepEqual(result.state.typing, { text: 'hello', caret: 5 });
  assert.equal(result.state.typingReads, 0, 'nothing was sent, so nothing was read back');
});

test('tab moves to the next control and stays typing when it is one', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: '[Email]', item: EMAIL },
  ];
  const state = stateFor(blocks, {
    mode: 'type',
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: '[Search: q]' },
  }, {
    field: { text: '', caret: 0, native: true },
  });
  const result = await runBoth('tab to the next field', state, [
    { op: 'typeKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'type');
  assert.deepEqual(result.state.typing, { text: '', caret: 0 });
  assert.equal(result.state.statusMsg,
    'Typing into "Email" — Tab: next control, Esc: stop, Enter: submit.');
  assert.equal(result.state.typingReleased, true, 'the old field was let go');
});

test('tab past an editable field into a control lands in forms mode', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: '[Save]', item: SAVE },
  ];
  const state = stateFor(blocks, {
    mode: 'type',
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: '[Search: q]' },
  }, {});
  const result = await runBoth('tab to a button', state, [
    { op: 'typeKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'forms');
  assert.equal(result.state.typing, null);
  assert.equal(result.state.statusMsg, 'Next control: Save.');
});

test('tab with no next control says so and stops typing', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
  ];
  const state = stateFor(blocks, {
    mode: 'type',
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: '[Search: q]' },
  }, {});
  const result = await runBoth('tab at the end', state, [
    { op: 'typeKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'No next control.');
});

test('lynx keeps tab out of fields that need activation', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: '[Email]', item: EMAIL },
  ];
  const state = stateFor(blocks, {
    mode: 'type', interface: 'lynx',
    keys: { profile: 'lynx', preferences: { textfieldsNeedActivation: true } },
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: 'Search q' },
  }, {});
  const result = await runBoth('lynx activation', state, [
    { op: 'typeKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.statusMsg, 'Next control: Email.');
});

test('lynx leaves a field with the arrow keys, like its line editor does', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: '[Save]', item: SAVE },
  ];
  const state = stateFor(blocks, {
    mode: 'type', interface: 'lynx',
    keys: { profile: 'lynx' },
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: 'Search q' },
  }, {});
  const result = await runBoth('lynx arrow off the field', state, [
    { op: 'typeKey', chunk: '\x1b[B' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse', 'lynx lands back in its browse map');
  assert.equal(result.state.statusMsg, 'Next control: Save.');
});

test('enter submits the form and reads whatever came back', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: 'results', item: { role: 'text' } },
  ];
  const fresh = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
    { text: 'results for q', item: { role: 'text' } },
  ];
  const state = stateFor(blocks, {
    mode: 'type',
    typing: { item: SEARCH, text: 'q', caret: 1, drawn: '[Search: q]' },
  }, { rescanBlocks: fresh });
  const result = await runBoth('submit', state, [
    { op: 'typeKey', chunk: '\r' },
  ], { url: PAGE_URL, title: 'Results' });
  assert.equal(result.state.mode, 'browse');
  assert.equal(result.state.typing, null);
  assert.equal(result.state.statusMsg, 'Submitted "Search".');
  assert.equal(result.state.lines[2].text, 'results for q');
});

test('lynx hands one command back to the browse map', { skip: needsCrystal }, async () => {
  const state = typingState(SEARCH, 'q', 1, 'Search q', {
    interface: 'lynx',
    keys: { profile: 'lynx' },
  }, {});
  const result = await runBoth('field command', state, [
    { op: 'typeKey', chunk: '\x16' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'field-command');
  assert.equal(result.state.statusMsg, 'Command:');
});

test('the command escape can be cancelled', { skip: needsCrystal }, async () => {
  const state = typingState(SEARCH, 'q', 1, '[Search: q]', {}, {});
  const cancelled = await runBoth('cancelled', state, [
    { op: 'fieldCommandKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(cancelled.state.mode, 'type');
  assert.equal(cancelled.state.statusMsg, 'Command cancelled.');
  // A key the browse map knows is completed here and dispatched there;
  // the dispatch itself is the browse-mode key dispatch, still
  // JavaScript-only, so only the completion is differenced for now.
});

test('adjusting a slider reports how the page took the key', { skip: needsCrystal }, async () => {
  const VOLUME = { role: 'slider', name: 'Volume' };
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume 40%]', item: VOLUME },
  ];
  const base = stateFor(blocks, {
    mode: 'control',
    controlling: { item: VOLUME },
  });
  const raised = await runBoth('adjusted', base, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  assert.equal(raised.state.statusMsg, 'Adjusted "Volume" with ArrowRight.');
  assert.equal(raised.state.mode, 'control');
  const ignored = await runBoth('ignored', base, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  const refused = await runBoth('refused', base, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  const stopped = await runBoth('stopped', base, [
    { op: 'controlKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(stopped.state.statusMsg, 'Stopped controlling "Volume".');
  assert.equal(stopped.state.mode, 'browse');
  assert.equal(stopped.state.controlling, null);
  return { raised, ignored, refused };
});

test('a slider that ignores the standard key is adjusted through its geometry', { skip: needsCrystal }, async () => {
  const VOLUME = { role: 'slider', name: 'Volume' };
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume 40%]', item: VOLUME },
  ];
  const state = stateFor(blocks, {
    mode: 'control',
    controlling: { item: VOLUME },
  }, { adjustOutcome: { changed: true, fallback: true } });
  const result = await runBoth('fallback adjustment', state, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg,
    'Adjusted "Volume" with its visual slider because it ignored ArrowRight.');
});

test('a slider that ignores everything is said, not repeated', { skip: needsCrystal }, async () => {
  const VOLUME = { role: 'slider', name: 'Volume' };
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume 40%]', item: VOLUME },
  ];
  const state = stateFor(blocks, {
    mode: 'control',
    controlling: { item: VOLUME },
  }, { adjustOutcome: { changed: false, fallback: false } });
  const result = await runBoth('ignored adjustment', state, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'The page ignored ArrowRight on "Volume".');
});

test('an adjustment the browser refuses is an error on the status row', { skip: needsCrystal }, async () => {
  const VOLUME = { role: 'slider', name: 'Volume' };
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume 40%]', item: VOLUME },
  ];
  const state = stateFor(blocks, {
    mode: 'control',
    controlling: { item: VOLUME },
  }, { adjustFailure: { message: 'the control is gone' } });
  const result = await runBoth('refused adjustment', state, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  assert.equal(result.state.statusMsg, 'Could not adjust "Volume": the control is gone');
  assert.equal(result.state.mode, 'control');
});

test('a key that adjusts nothing leaves the control mode alone', { skip: needsCrystal }, async () => {
  const VOLUME = { role: 'slider', name: 'Volume' };
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume 40%]', item: VOLUME },
  ];
  const state = stateFor(blocks, {
    mode: 'control',
    controlling: { item: VOLUME },
  }, {});
  const result = await runBoth('unbound key', state, [
    { op: 'controlKey', chunk: 'x' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'control');
  assert.equal(result.state.statusMsg, '');
});

test('forms mode walks the controls and activates on enter', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Save]', item: SAVE },
    { text: '[Email]', item: EMAIL },
  ];
  const state = stateFor(blocks, { mode: 'forms' }, {
    field: { text: '', caret: 0, native: true },
  });
  const walked = await runBoth('walk', state, [
    { op: 'formsKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(walked.state.mode, 'type');
  assert.equal(walked.state.statusMsg,
    'Typing into "Email" — Tab: next control, Esc: stop, Enter: submit.');
  const pressed = await runBoth('activate', state, [
    { op: 'formsKey', chunk: '\r' },
  ], { url: PAGE_URL });
  assert.equal(pressed.state.statusMsg, 'Activated: Save — no visible change.');
  const left = await runBoth('left', state, [
    { op: 'formsKey', chunk: '\x1b' },
  ], { url: PAGE_URL });
  assert.equal(left.state.mode, 'browse');
  assert.equal(left.state.statusMsg, 'Left forms mode.');
});

test('forms mode says when the controls have run out', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Save]', item: SAVE },
  ];
  const state = stateFor(blocks, { mode: 'forms' }, {});
  const result = await runBoth('end of the form', state, [
    { op: 'formsKey', chunk: '\t' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'forms');
  assert.equal(result.state.statusMsg, 'No next control.');
});

test('typing with no field returns to the browse map', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Search]', item: SEARCH },
  ];
  const state = stateFor(blocks, { mode: 'type', typing: null }, {});
  const result = await runBoth('no field', state, [
    { op: 'typeKey', chunk: 'x' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
});

test('adjusting with no control returns to the browse map', { skip: needsCrystal }, async () => {
  const blocks = [
    { text: 'label', item: { role: 'text' } },
    { text: '[Volume]', item: { role: 'slider', name: 'Volume' } },
  ];
  const state = stateFor(blocks, { mode: 'control', controlling: null }, {});
  const result = await runBoth('no control', state, [
    { op: 'controlKey', chunk: '\x1b[C' },
  ], { url: PAGE_URL });
  assert.equal(result.state.mode, 'browse');
});
