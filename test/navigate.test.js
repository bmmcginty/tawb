'use strict';

// Going somewhere the browser will not simply load.
//
// A bad certificate, a refused connection and a name that does not resolve
// all reach us the same way: page.goto throws. But the tab is not empty
// afterwards — the engine has rendered a warning page of its own, and that
// page is the whole of what a sighted person gets, including the way past it.
// So the throw is something to report, not something to act on.

const test = require('node:test');
const assert = require('node:assert');

const {
  navigate, navigateInterruptibly, navigationFault, settleAfterFault,
} = require('../src/index');

test('the engine\'s own name for the fault is picked out of a developer message', () => {
  assert.equal(
    navigationFault('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://example.com/'),
    'ERR_CERT_AUTHORITY_INVALID');
  assert.equal(
    navigationFault('page.goto: net::ERR_CERT_DATE_INVALID at https://expired.example/'),
    'ERR_CERT_DATE_INVALID');
  assert.equal(
    navigationFault('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/'),
    'ERR_CONNECTION_REFUSED');
});

test('Firefox wraps the diagnosis, and the diagnosis is the part worth saying', () => {
  // NS_ERROR_GENERATE_FAILURE and NS_ERROR_MODULE_SECURITY say only that
  // something security-related failed; the third code says what.
  assert.equal(
    navigationFault('unknown error: Error: NS_ERROR_GENERATE_FAILURE('
      + 'NS_ERROR_MODULE_SECURITY, MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT)'),
    'MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT');
  assert.equal(
    navigationFault('unknown error: Error: NS_ERROR_GENERATE_FAILURE('
      + 'NS_ERROR_MODULE_SECURITY, SEC_ERROR_EXPIRED_CERTIFICATE)'),
    'SEC_ERROR_EXPIRED_CERTIFICATE');
  // Nothing certificate-specific to prefer: the first code stands.
  assert.equal(navigationFault('Error: NS_ERROR_UNKNOWN_HOST'), 'NS_ERROR_UNKNOWN_HOST');
});

test('a message with no code at all still says something', () => {
  assert.equal(navigationFault('page.goto: Timeout 30000ms exceeded.'), 'Timeout 30000ms exceeded.');
  assert.equal(navigationFault(''), '');
  assert.equal(navigationFault(undefined), '');
});

test('a navigation that fails is reported, not thrown', async () => {
  const refused = {
    goto: async () => { throw new Error('page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://x/'); },
  };
  const went = await navigate(refused, 'https://x/');
  assert.equal(went.ok, false, 'a refusal was reported as success');
  assert.equal(went.fault, 'ERR_CERT_AUTHORITY_INVALID');

  const fine = { goto: async () => null };
  assert.deepEqual(await navigate(fine, 'https://y/'), { ok: true, fault: null });
});

test('Escape stops waiting for an address navigation', async () => {
  let stopped = false;
  const page = {
    goto: () => new Promise((resolve) => setTimeout(resolve, 100)),
    stopLoading: async () => { stopped = true; },
  };
  const state = {
    keyReader: { nextOr: async () => ({ key: '\x1b' }) },
  };

  const started = Date.now();
  const went = await navigateInterruptibly(state, page, 'https://slow.example/');
  assert.equal(went.cancelled, true);
  assert.equal(stopped, true);
  assert.ok(Date.now() - started < 50, 'Escape waited for the navigation timeout');
});

// A core whose page becomes readable only after `readableAfter` scans, which
// is what an engine does: the throw comes from the network layer and the
// warning page is rendered after it.
function coreReadableAfter(readableAfter) {
  let scans = 0;
  return {
    scans: () => scans,
    core: {
      blocks: [],
      live: null,
      snapshotCostMs: 0,
      cursorBlock: -1,
      at(blockIndex) { this.cursorBlock = blockIndex; },
      rescan() {
        scans += 1;
        this.blocks = scans >= readableAfter
          ? [{ text: '# Your connection is not private', item: { role: 'heading' } }]
          : [];
        return Promise.resolve();
      },
    },
  };
}

test('the warning page is read again until it is actually there', async () => {
  const { core, scans } = coreReadableAfter(3);
  const state = { core, lines: [], cursor: 0, col: 0, scroll: 0 };
  assert.equal(await settleAfterFault(state, {}, { timeout: 4000 }), true,
    'gave up before the warning page had rendered');
  assert.equal(scans(), 3, 'stopped short of, or kept scanning past, the page appearing');
  assert.ok(state.lines.length, 'the buffer is still empty after settling');
});

test('a page that renders nothing is not waited on for ever', async () => {
  const { core, scans } = coreReadableAfter(Infinity);
  const state = { core, lines: [], cursor: 0, col: 0, scroll: 0 };
  const started = Date.now();
  assert.equal(await settleAfterFault(state, {}, { timeout: 400 }), false,
    'an empty page was reported as settled');
  assert.ok(Date.now() - started < 3000, 'the bound was not respected');
  assert.ok(scans() >= 1, 'the page was never read at all');
});

test('a page that is readable at once is read once', async () => {
  const { core, scans } = coreReadableAfter(1);
  const state = { core, lines: [], cursor: 0, col: 0, scroll: 0 };
  assert.equal(await settleAfterFault(state, {}, { timeout: 4000 }), true);
  assert.equal(scans(), 1, 'a page that was ready was scanned more than once');
});
