'use strict';

// The bookkeeping a tab does about its own documents.
//
// All of this is about one failure mode, and it is worth stating plainly
// because it does not look like a bug from the outside: when a page keeps a
// document it can no longer run anything in, every snapshot pays that
// document's whole frame budget before giving up. On a school district's home
// page — a YouTube embed, a reCAPTCHA and four tracking iframes — that turned
// a 130ms snapshot into a twenty-four second one, and the reader sat in front
// of a buffer that would not move.
//
// So these are not tests about maps and sets. They are tests about the three
// ways a document stops being real, and about not waiting for one that has.

const test = require('node:test');
const assert = require('node:assert');

const { CdpPage } = require('../src/cdp_page');

// Enough of a session to be told apart from another one.
function fakeSession(sessionId) {
  return { sessionId, detached: false, send: async () => ({}), on() {}, off() {} };
}

function fakePage() {
  const session = fakeSession('PAGE');
  const page = new CdpPage({ closePage: async () => {} }, session, 'TARGET');
  page.mainFrameId = 'MAIN';
  page.ensureFrame('MAIN');
  page.noteContext(session, { id: 1, auxData: { isDefault: true, frameId: 'MAIN' } });
  return { page, session };
}

test('an execution context id belongs to the session that issued it', () => {
  const { page, session } = fakePage();
  const iframe = fakeSession('IFRAME');
  page.ensureFrame('CHILD', 'MAIN');
  // The same small number, handed out independently by two sessions on the
  // same tab. This is the ordinary case, not a coincidence to guard against:
  // each session counts from one.
  page.noteContext(iframe, { id: 1, auxData: { isDefault: true, frameId: 'CHILD' } });

  page.forgetContextById(iframe, 1);

  assert.ok(page.contexts.get('MAIN'), 'the tab lost its own context to an iframe’s');
  assert.strictEqual(page.contexts.has('CHILD'), false);
  assert.strictEqual(page.contexts.get('MAIN').session, session);
});

test('a new document in a frame drops the frames the old one had', () => {
  const { page } = fakePage();
  page.ensureFrame('AD', 'MAIN');
  page.ensureFrame('AD-INNER', 'AD');
  page.ensureFrame('VIDEO', 'MAIN');

  page.dropChildrenOf('MAIN');

  assert.deepStrictEqual(page.frames().map((frame) => frame.frameId), ['MAIN']);
  // Nothing announces that the previous document's children have gone, so
  // anything left keyed to them would be kept for ever.
  assert.strictEqual(page.contexts.has('AD'), false);
});

test('the frame a navigation happened in survives its own children being dropped', () => {
  const { page } = fakePage();
  page.ensureFrame('AD', 'MAIN');
  page.ensureFrame('AD-INNER', 'AD');

  page.dropChildrenOf('AD');

  assert.deepStrictEqual(
    page.frames().map((frame) => frame.frameId).sort(), ['AD', 'MAIN']);
});

test('a sub-target going takes the documents it answered for with it', () => {
  const { page } = fakePage();
  const iframe = fakeSession('IFRAME');
  page.sessions.add(iframe);
  const frame = page.ensureFrame('CHILD', 'MAIN');
  frame._ownSession = iframe;
  page.noteContext(iframe, { id: 7, auxData: { isDefault: true, frameId: 'CHILD' } });

  page.dropSession(iframe);

  assert.deepStrictEqual(page.frames().map((f) => f.frameId), ['MAIN']);
  assert.strictEqual(page.sessions.has(iframe), false);
  assert.ok(page.contexts.get('MAIN'), 'the tab’s own context went with the iframe’s');
});

test('a document whose process has gone is not waited for', async () => {
  const { page } = fakePage();
  const iframe = fakeSession('IFRAME');
  const frame = page.ensureFrame('CHILD', 'MAIN');
  frame._ownSession = iframe;
  iframe.detached = true;

  const started = Date.now();
  await assert.rejects(page.contextFor('CHILD'), /process has gone/);
  // The point of the test is the clock, not the message: waiting here is what
  // costs a snapshot its whole frame budget.
  assert.ok(Date.now() - started < 200, `waited ${Date.now() - started}ms for a dead process`);
});

test('a document that is no longer in the page is not waited for', async () => {
  const { page } = fakePage();
  const started = Date.now();
  await assert.rejects(page.contextFor('GONE'), /no longer in the page/);
  assert.ok(Date.now() - started < 200, `waited ${Date.now() - started}ms for a frame that is not there`);
});

test('a context recorded against a dead session is dropped rather than returned', async () => {
  const { page } = fakePage();
  const iframe = fakeSession('IFRAME');
  page.ensureFrame('CHILD', 'MAIN');
  page.noteContext(iframe, { id: 3, auxData: { isDefault: true, frameId: 'CHILD' } });
  iframe.detached = true;

  // The frame itself has no target of its own — it was answered by a session
  // that has since gone — so this is the one case that has to wait and then
  // give up. It must still not return the dead context.
  await assert.rejects(page.contextFor('CHILD'), /never announced a context/);
  assert.strictEqual(page.contexts.has('CHILD'), false);
});

test('waiting for a load state reports its timeout', async () => {
  const { page } = fakePage();

  await assert.rejects(
    page.waitForLoadState('load', { timeout: 20 }),
    /did not reach load/,
  );
});

test('the tab closing stops anything still waiting for a context', async () => {
  const { page } = fakePage();
  page.ensureFrame('CHILD', 'MAIN');
  const waiting = assert.rejects(page.contextFor('CHILD'), /tab has closed/);
  page.markClosed();
  await waiting;
});
