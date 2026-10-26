'use strict';

// The file chooser both browsers ask the desktop for, answered here.
//
// The shape a client depends on is the request object: a token it chose, a
// path it can compute, a subscription it made before calling, and an answer
// that arrives later as a signal. Getting any of those wrong leaves a browser
// waiting for something that will never arrive, which from the outside is a
// window that never appears — the exact failure this exists to prevent.

const test = require('node:test');
const assert = require('node:assert');

const portal = require('../src/portal');

// A connection that records what the service says and lets a test call the
// service the way a client would.
function fakeConnection() {
  const replies = [];
  const signals = [];
  const handlers = [];
  return {
    replies, signals,
    onMethodCall(handler) { handlers.push(handler); return this; },
    emitSignal(message) { signals.push(message); },
    // One incoming call, answered with whatever the service said.
    call({ sender = ':1.42', path = portal.PORTAL_PATH, iface, member, body = [] } = {}) {
      let answered = null;
      let refused = null;
      const message = { sender, path, iface, member, body };
      const answer = {
        reply(signature = '', replyBody = []) {
          answered = { signature, body: replyBody };
        },
        fail(name, text) {
          refused = { name, text };
        },
      };
      let handled = false;
      for (const handler of handlers) {
        if (handler(message, answer) === true) { handled = true; break; }
      }
      const record = { handled, answered, refused };
      replies.push(record);
      return record;
    },
  };
}

// What a client would do: make up a token, subscribe, then call. The
// subscription is what the path in the reply has to match. The question is
// answered in a later turn of the loop, so a test that wants the answer waits
// for `settled` — and one about a question still waiting does not.
async function openChooser(service, connection, {
  sender = ':1.42', method = 'OpenFile', options = [], title = 'Choose',
} = {}) {
  const token = 'tok';
  connection.call({
    sender,
    iface: portal.FILECHOOSER,
    member: method,
    body: ['', title, [
      ['handle_token', token],
      ...options,
    ]],
  });
  const replied = connection.replies.at(-1).answered;
  await settled();
  return { path: replied && replied.body[0], replied, token };
}

// One turn of the event loop: enough for the question to be put, and not
// enough to wait for one that is never answered.
function settled() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('the version a caller asks about before using the chooser', async () => {
  const connection = fakeConnection();
  portal.serveFileChooser(connection, { ask: () => null });
  const answered = connection.call({
    iface: portal.PROPERTIES, member: 'Get', body: [portal.FILECHOOSER, 'version'],
  });
  assert.equal(answered.handled, true);
  assert.deepEqual(answered.answered, {
    signature: 'v', body: [{ signature: 'u', value: portal.VERSION }],
  });
});

test('the request path is the one the caller computed for itself', async () => {
  const connection = fakeConnection();
  const service = portal.serveFileChooser(connection, { ask: () => null });
  const { path } = await openChooser(service, connection);
  // A client subscribes here before it calls. Any other path is a signal
  // nobody is listening for.
  assert.equal(path, '/org/freedesktop/portal/desktop/request/1_42/tok');
});

test('a chosen folder comes back as a file URI on the request', async () => {
  const connection = fakeConnection();
  const asked = [];
  const service = portal.serveFileChooser(connection, {
    ask: (request) => { asked.push(request); return ['/home/reader/Downloads']; },
  });
  const { path } = await openChooser(service, connection, {
    options: [['directory', true]],
  });
  await service.idle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].directory, true);
  const response = connection.signals.at(-1);
  assert.equal(response.path, path);
  assert.equal(response.iface, portal.REQUEST);
  assert.equal(response.member, 'Response');
  assert.equal(response.signature, 'ua{sv}');
  assert.deepEqual(response.body[0], portal.RESPONSE_SUCCESS);
  assert.deepEqual(response.body[1], [[
    'uris', { signature: 'as', value: ['file:///home/reader/Downloads'] },
  ]]);
});

test('a name with a space is escaped, because otherwise it cannot be opened', async () => {
  const connection = fakeConnection();
  const service = portal.serveFileChooser(connection, {
    ask: () => ['/home/reader/My Documents/a b.txt'],
  });
  await openChooser(service, connection);
  await service.idle();
  const uris = connection.signals.at(-1).body[1][0][1].value;
  assert.deepEqual(uris, ['file:///home/reader/My%20Documents/a%20b.txt']);
});

test('saving carries the folder and name the browser offered', async () => {
  const connection = fakeConnection();
  let asked = null;
  const service = portal.serveFileChooser(connection, {
    ask: (request) => { asked = request; return ['/home/reader/report.pdf']; },
  });
  await openChooser(service, connection, {
    method: 'SaveFile',
    options: [
      // A byte string with a trailing nul, which is the portal's own
      // convention for a path.
      ['current_folder', [...Buffer.from('/home/reader\0')]],
      ['current_name', 'report.pdf'],
    ],
  });
  assert.equal(asked.saving, true);
  assert.equal(asked.initial, '/home/reader');
  assert.equal(asked.name, 'report.pdf');
});

test('declining is a cancelled response, not a chooser left waiting', async () => {
  const connection = fakeConnection();
  const service = portal.serveFileChooser(connection, { ask: () => null });
  await openChooser(service, connection);
  await service.idle();
  const response = connection.signals.at(-1);
  assert.equal(response.body[0], portal.RESPONSE_CANCELLED);
  assert.deepEqual(response.body[1], [['uris', { signature: 'as', value: [] }]]);
});

test('a caller may cancel a request it raised', async () => {
  const connection = fakeConnection();
  const service = portal.serveFileChooser(connection, { ask: () => new Promise(() => {}) });
  const { path } = await openChooser(service, connection);
  const closed = connection.call({
    sender: ':1.42', path, iface: portal.REQUEST, member: 'Close',
  });
  assert.equal(closed.handled, true);
  assert.deepEqual(closed.answered, { signature: '', body: [] });
  assert.equal(connection.signals.at(-1).body[0], portal.RESPONSE_CANCELLED);
  assert.deepEqual(service.openRequests(), []);
});

test('a sender that may not choose is refused rather than shown a prompt', async () => {
  const connection = fakeConnection();
  let asked = 0;
  const service = portal.serveFileChooser(connection, {
    ask: () => { asked += 1; return null; },
    allow: (sender) => sender === ':1.99',
  });
  const refused = connection.call({
    sender: ':1.42', iface: portal.FILECHOOSER, member: 'OpenFile', body: ['', '', []],
  });
  assert.equal(refused.handled, true);
  assert.match(refused.refused.name, /NotAllowed/);
  assert.equal(asked, 0);
  service.stop();
});

test('what this frontend does not implement is left for somebody else', () => {
  const connection = fakeConnection();
  portal.serveFileChooser(connection, { ask: () => null });
  // Another portal interface on the same object is not this program's to
  // answer, and claiming it would be worse than saying nothing.
  const other = connection.call({
    iface: 'org.freedesktop.portal.Settings', member: 'ReadAll', body: [],
  });
  assert.equal(other.handled, false);
  const elsewhere = connection.call({ path: '/org/freedesktop/portal/desktop/other', iface: 'x', member: 'y' });
  assert.equal(elsewhere.handled, false);
});

test('stopping answers every question still waiting', async () => {
  const connection = fakeConnection();
  const service = portal.serveFileChooser(connection, { ask: () => new Promise(() => {}) });
  await openChooser(service, connection);
  assert.equal(service.openRequests().length, 1);
  service.stop();
  assert.deepEqual(service.openRequests(), []);
  assert.equal(connection.signals.at(-1).body[0], portal.RESPONSE_CANCELLED);
});
