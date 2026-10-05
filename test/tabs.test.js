'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { focusAddressBar, openNewTab, closeInitialTab } = require('../src/index');

test('the new-tab address bar starts empty at its first character', () => {
  const state = {
    mode: 'browse',
    address: null,
    core: { source: 'ax' },
    drawn: { address: null, hint: null },
  };
  const page = { url: () => 'about:blank' };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    focusAddressBar(state, page, '');
  } finally {
    process.stdout.write = write;
  }

  assert.equal(state.mode, 'address');
  assert.deepEqual(state.address, { text: '', caret: 0, scroll: 0 });
});

test('the tab a session opened is closed on the way out', async () => {
  let closed = false;
  const page = {
    goto: async () => { throw new Error('a non-last tab should not be navigated'); },
    close: async () => { closed = true; },
  };
  // Another tab is still open, so this one is not the browser's last.
  const context = { pages: () => [{}, page] };

  assert.equal(await closeInitialTab({ page, context }), 'closed');
  assert.equal(closed, true);
});

test('the last tab is blanked rather than closed when the browser is kept', async () => {
  const seen = [];
  const page = {
    goto: async (url, options) => { seen.push(['goto', url, options]); },
    close: async () => { seen.push(['close']); },
  };
  const context = { pages: () => [page] };

  assert.equal(
    await closeInitialTab({ page, context, keepBrowser: true, log: () => {} }),
    'blanked',
  );
  assert.deepEqual(seen, [['goto', 'about:blank', { waitUntil: 'domcontentloaded' }]]);
});

test('the last tab is closed when the browser is not being kept', async () => {
  const seen = [];
  const page = {
    goto: async () => { seen.push('goto'); },
    close: async () => { seen.push('close'); },
  };
  const context = { pages: () => [page] };

  assert.equal(await closeInitialTab({ page, context, keepBrowser: false }), 'closed');
  assert.deepEqual(seen, ['close']);
});

test('a last tab that will not go blank is left running', async () => {
  let closed = false;
  const page = {
    goto: async () => { throw new Error('navigation refused'); },
    close: async () => { closed = true; },
  };
  const context = { pages: () => [page] };

  assert.equal(
    await closeInitialTab({ page, context, keepBrowser: true, log: () => {} }),
    'kept',
  );
  assert.equal(closed, false, 'closing the only tab would take the browser down');
});

test('a missing page is nothing to close', async () => {
  assert.equal(await closeInitialTab({ page: null }), 'none');
});

test('opening a new tab follows it with an empty address bar focused', async () => {
  const page = { url: () => 'about:blank' };
  const state = {
    core: {
      newTab: async () => page,
    },
  };
  const events = [];

  await openNewTab(
    state,
    async (...args) => events.push(['switch', ...args]),
    (...args) => events.push(['address', ...args]),
  );

  assert.deepEqual(events, [
    ['switch', state, page, { note: 'Opened a new tab' }],
    ['address', state, page, ''],
  ]);
});
