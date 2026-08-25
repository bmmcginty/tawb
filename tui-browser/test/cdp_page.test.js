'use strict';

// The bookkeeping a tab does about its own documents.
//
// This does not look like a bug from the outside. A tab that loses track of
// its own execution context does not fail; it waits, and every snapshot pays
// a timeout it never used to. So the bookkeeping is checked directly.

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
