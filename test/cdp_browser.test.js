'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { attachToBrowser } = require('../src/cdp_browser');

class FakeSession {
  constructor(connection, sessionId = null, targetId = null) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.listeners = new Map();
    this.detached = false;
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return this;
  }

  emit(event, params) {
    for (const handler of [...(this.listeners.get(event) || [])]) handler(params);
  }

  async send(method) {
    if (method === 'Target.setAutoAttach') return {};
    if (method === 'Target.createTarget') {
      const targetId = `TARGET-${++this.connection.nextTarget}`;
      this.connection.autoAttach(targetId);
      return { targetId };
    }
    if (method === 'Page.getFrameTree') return null;
    return {};
  }

  async detach() {
    this.detached = true;
  }
}

function fakeConnection() {
  const connection = {
    nextTarget: 0,
    nextSession: 0,
    sessions: new Map(),
    closed: false,
    sessionFor(sessionId, targetId = null) {
      let session = this.sessions.get(sessionId);
      if (!session) {
        session = new FakeSession(this, sessionId, targetId);
        this.sessions.set(sessionId, session);
      }
      return session;
    },
    autoAttach(targetId) {
      const sessionId = `SESSION-${++this.nextSession}`;
      this.sessionFor(sessionId, targetId);
      this.browser.emit('Target.attachedToTarget', {
        sessionId, targetInfo: { type: 'page', targetId },
      });
    },
    async attach(targetId) {
      // Target.attachToTarget raises the same browser event as auto-attach.
      // This is the event that used to be mistaken for a new tab.
      const sessionId = `SESSION-${++this.nextSession}`;
      const session = this.sessionFor(sessionId, targetId);
      this.browser.emit('Target.attachedToTarget', {
        sessionId, targetInfo: { type: 'page', targetId },
      });
      return session;
    },
    close() { this.closed = true; },
  };
  connection.browser = new FakeSession(connection);
  return connection;
}

test('a second CDP session on a tab is not announced as another page', async () => {
  const browser = await attachToBrowser(fakeConnection());
  const context = browser.contexts()[0];
  const announced = [];
  context.on('page', (page) => announced.push(page));

  const page = await context.newPage();
  assert.deepStrictEqual(context.pages(), [page]);
  assert.deepStrictEqual(announced, [page]);

  const extra = await context.newCDPSession(page);

  assert.notStrictEqual(extra, page.session);
  assert.deepStrictEqual(context.pages(), [page]);
  assert.deepStrictEqual(announced, [page]);
});
