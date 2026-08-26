'use strict';

// The DevTools protocol client, exercised against a socket we control.
//
// What is worth testing here is the part CDP has and BiDi does not: one
// socket carrying several conversations, told apart by a sessionId. Getting
// that routing wrong does not look like a bug, it looks like a browser that
// occasionally ignores you — an event delivered to the wrong tab, a reply
// resolving somebody else's command — so it is checked directly.

const test = require('node:test');
const assert = require('node:assert');

const { CdpConnection, CdpError } = require('../src/cdp');

// A stand-in for the browser's end of the WebSocket. It records what was
// sent and lets a test answer whenever it likes.
function fakeSocket() {
  const listeners = new Map();
  return {
    sent: [],
    closed: false,
    addEventListener(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    send(text) { this.sent.push(JSON.parse(text)); },
    close() { this.closed = true; },
    // The browser speaking.
    deliver(message) { this.deliverRaw(JSON.stringify(message)); },
    deliverRaw(data) {
      for (const handler of listeners.get('message') || []) handler({ data });
    },
    hangUp() {
      this.closed = true;
      for (const handler of listeners.get('close') || []) handler();
    },
    lastId() { return this.sent[this.sent.length - 1].id; },
  };
}

test('a command is answered by the reply carrying its own id', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);

  const first = connection.send('Runtime.evaluate', { expression: '1' });
  const second = connection.send('Runtime.evaluate', { expression: '2' });

  const [one, two] = socket.sent;
  // Answered out of order, which is allowed and does happen.
  socket.deliver({ id: two.id, result: { value: 'second' } });
  socket.deliver({ id: one.id, result: { value: 'first' } });

  assert.deepStrictEqual(await first, { value: 'first' });
  assert.deepStrictEqual(await second, { value: 'second' });
});

test('a reply sent synchronously by the transport is not lost', async () => {
  const socket = fakeSocket();
  socket.send = function send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    this.deliver({ id: message.id, result: { immediate: true } });
  };
  const connection = new CdpConnection(socket);

  assert.deepStrictEqual(await connection.send('Browser.getVersion'), { immediate: true });
});

test('an error reply rejects with the message the browser gave', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);

  const call = connection.send('DOM.resolveNode', { nodeId: 7 });
  socket.deliver({
    id: socket.lastId(),
    error: { code: -32000, message: 'No node with given id found' },
  });

  await assert.rejects(call, (err) => {
    assert.ok(err instanceof CdpError);
    // The method is in the message, because "No node with given id found" on
    // its own says nothing about what was being done.
    assert.match(err.message, /DOM\.resolveNode: No node with given id found/);
    return true;
  });
});

test('a command carries the sessionId of the session it was sent on', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const session = connection.sessionFor('S1', 'T1');

  // Neither is ever answered here, so the connection is hung up afterwards
  // rather than leaving two commands counting down to their timeout.
  const calls = Promise.allSettled([
    session.send('Page.enable'),
    connection.browser.send('Target.getTargets'),
  ]);

  assert.strictEqual(socket.sent[0].sessionId, 'S1');
  // The browser's own session is the one with no id at all, not one with a
  // null id: Chrome rejects a message carrying sessionId: null.
  assert.ok(!('sessionId' in socket.sent[1]));

  socket.hangUp();
  await calls;
});

test('an event reaches only the session it names', () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const one = connection.sessionFor('S1');
  const two = connection.sessionFor('S2');

  const heard = [];
  one.on('Page.frameNavigated', (params) => heard.push(['one', params.url]));
  two.on('Page.frameNavigated', (params) => heard.push(['two', params.url]));
  connection.browser.on('Page.frameNavigated', (params) => heard.push(['browser', params.url]));

  socket.deliver({ method: 'Page.frameNavigated', sessionId: 'S2', params: { url: 'b' } });
  socket.deliver({ method: 'Page.frameNavigated', params: { url: 'browser' } });

  assert.deepStrictEqual(heard, [['two', 'b'], ['browser', 'browser']]);
});

test('a listener that throws does not stop the others', () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const heard = [];

  connection.browser.on('Target.targetCreated', () => { throw new Error('bad listener'); });
  connection.browser.on('Target.targetCreated', () => heard.push('still ran'));

  socket.deliver({ method: 'Target.targetCreated', params: {} });
  assert.deepStrictEqual(heard, ['still ran']);
});

test('an auto-attached target has a session before any listener runs', () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  let found = null;

  // The envelope names the parent; the target that just appeared is named
  // inside the parameters. A listener's first act is to send that new session
  // a command, so it has to exist by now.
  connection.sessionFor('PAGE').on('Target.attachedToTarget', (params) => {
    found = connection.sessions.get(params.sessionId);
  });

  socket.deliver({
    method: 'Target.attachedToTarget',
    sessionId: 'PAGE',
    params: { sessionId: 'IFRAME', targetInfo: { targetId: 'T9', type: 'iframe' } },
  });

  assert.ok(found, 'the new session was not there when the listener ran');
  assert.strictEqual(found.targetId, 'T9');
});

test('a detached target is forgotten and refuses further commands', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const session = connection.sessionFor('S1', 'T1');

  socket.deliver({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } });

  assert.strictEqual(connection.sessions.has('S1'), false);
  await assert.rejects(session.send('Page.enable'), /already detached/);
});

test('detaching says so to the browser and only once', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const session = connection.sessionFor('S1', 'T1');

  const first = session.detach();
  socket.deliver({ id: socket.lastId(), result: {} });
  await first;
  await session.detach();

  const detaches = socket.sent.filter((message) => message.method === 'Target.detachFromTarget');
  assert.strictEqual(detaches.length, 1);
  assert.deepStrictEqual(detaches[0].params, { sessionId: 'S1' });
});

test('a closed connection rejects everything still waiting', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const call = connection.send('Runtime.evaluate', { expression: '1' });
  let noticed = false;
  connection.onClose(() => { noticed = true; });

  socket.hangUp();

  await assert.rejects(call, /connection closed/);
  await assert.rejects(connection.send('Runtime.evaluate'), /connection closed/);
  assert.strictEqual(noticed, true);
});

test('a command that is never answered gives up rather than hanging', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  await assert.rejects(
    connection.send('Page.navigate', { url: 'about:blank' }, { timeout: 20 }),
    /Page\.navigate did not answer/,
  );
});

test('a reply arriving after the timeout is ignored rather than crashing', async () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  const id = (async () => {
    await assert.rejects(connection.send('Page.navigate', {}, { timeout: 20 }), /did not answer/);
    return socket.sent[0].id;
  })();
  socket.deliver({ id: await id, result: { late: true } });
});

test('garbage on the socket is ignored rather than thrown', () => {
  const socket = fakeSocket();
  const connection = new CdpConnection(socket);
  let heard = 0;
  connection.browser.on('Page.loadEventFired', () => { heard += 1; });

  assert.doesNotThrow(() => socket.deliverRaw('not json at all'));
  socket.deliver({ method: 'Page.loadEventFired', params: {} });
  assert.strictEqual(heard, 1);
});
