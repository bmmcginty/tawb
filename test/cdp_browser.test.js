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
    this.sent = [];
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

  async send(method, params = {}) {
    this.sent.push({ method, params });
    if (method === 'Target.setAutoAttach' || method === 'Target.setDiscoverTargets') return {};
    if (method === 'Page.getFrameTree') return this.connection.frameTrees.get(this.targetId) || null;
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
    targetInfos: new Map(),
    frameTrees: new Map(),
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
        sessionId, targetInfo: this.targetInfos.get(targetId) || { type: 'page', targetId },
      });
      return session;
    },
    onClose(handler) { this.closeHandler = handler; },
    close() {
      this.closed = true;
      if (this.closeHandler) this.closeHandler();
    },
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
  assert.ok(!page.session.sent.some((call) => call.method === 'Target.setAutoAttach'),
    'a page must not enable Chromium child-worker reporting');
  assert.deepStrictEqual(
    browser.connection.browser.sent.find((call) => call.method === 'Target.setAutoAttach').params,
    {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'page' }],
    },
  );
  assert.deepStrictEqual(
    browser.connection.browser.sent.find((call) => call.method === 'Target.setDiscoverTargets').params,
    { discover: true, filter: [{ type: 'iframe' }] },
  );
  assert.ok(page.session.sent.some((call) => call.method === 'Runtime.runIfWaitingForDebugger'));

  const extra = await context.newCDPSession(page);

  assert.notStrictEqual(extra, page.session);
  assert.deepStrictEqual(context.pages(), [page]);
  assert.deepStrictEqual(announced, [page]);
});

test('discovered iframe targets use the existing frame wiring without recursive auto-attach', async () => {
  const connection = fakeConnection();
  const browser = await attachToBrowser(connection);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  // Discovery can arrive before Page.frameAttached. parentFrameId lets the
  // target wait until its owning page has reported that side of the tree.
  const info = {
    type: 'iframe', targetId: 'CHILD', parentFrameId: 'PARENT',
    url: 'https://frame.test/',
  };
  connection.targetInfos.set('CHILD', info);
  connection.frameTrees.set('CHILD', {
    frameTree: { frame: { id: 'CHILD', parentId: 'PARENT', url: info.url } },
  });
  connection.browser.emit('Target.targetCreated', { targetInfo: info });
  assert.equal(page.frameById('CHILD'), null, 'an unowned target was attached by guessing');

  page.session.emit('Page.frameAttached', { frameId: 'PARENT', parentFrameId: page.mainFrameId });
  await context.attachDiscoveredFrames();

  const frame = page.frameById('CHILD');
  assert.ok(frame && frame.ownTarget(), 'the iframe did not receive its explicit session');
  assert.equal(frame.parentId, 'PARENT');
  assert.ok(frame.session().sent.some((call) => call.method === 'Page.enable'));
  assert.ok(frame.session().sent.some((call) => call.method === 'Runtime.enable'));
  assert.ok(!frame.session().sent.some((call) => call.method === 'Target.setAutoAttach'),
    'the iframe recursively enabled child-worker reporting');

  connection.browser.emit('Target.detachedFromTarget', { sessionId: frame.session().sessionId });
  assert.equal(page.frameById('CHILD'), null, 'a detached OOPIF remained in the frame tree');
});

test('discovery ignores workers rather than attaching and pausing them', async () => {
  const connection = fakeConnection();
  await attachToBrowser(connection);
  const before = connection.nextSession;

  connection.browser.emit('Target.targetCreated', {
    targetInfo: { type: 'worker', targetId: 'WORKER', url: 'blob:https://example.test/id' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connection.nextSession, before);
});

test('unsupported auto-attached targets are detached', async () => {
  const connection = fakeConnection();
  await attachToBrowser(connection);

  const session = connection.sessionFor('WORKER-SESSION', 'WORKER-TARGET');
  connection.browser.emit('Target.attachedToTarget', {
    sessionId: session.sessionId,
    targetInfo: { type: 'service_worker', targetId: session.targetId },
  });

  assert.strictEqual(session.detached, true);
});

test('a lost connection closes every page', async () => {
  const connection = fakeConnection();
  const browser = await attachToBrowser(connection);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  connection.close();

  assert.strictEqual(page.isClosed(), true);
  assert.deepStrictEqual(context.pages(), []);
});
