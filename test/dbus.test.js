'use strict';

// The D-Bus client, exercised against a bus we control.
//
// Marshalling is the whole risk here. Every value is aligned to the width of
// its own type measured from the start of the message, and a mistake in that
// does not produce an error — it produces a reply that decodes into plausible
// nonsense, or a bus that hangs up without saying why. So the shapes this
// actually sends and receives are round-tripped byte for byte, and the
// handshake is played out over a real socket.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  connect, encodeMessage, decodeMessage, messageLength, parseAddress, splitSignature, typeLength,
  DbusError, MESSAGE_METHOD_RETURN, MESSAGE_ERROR,
} = require('../src/dbus');

test('a signature is read as the list of types it holds', () => {
  assert.deepEqual(splitSignature('a(so)'), ['a(so)']);
  assert.deepEqual(splitSignature('ss'), ['s', 's']);
  assert.deepEqual(splitSignature('ssa{sv}'), ['s', 's', 'a{sv}']);
  assert.deepEqual(splitSignature(''), []);
  assert.equal(typeLength('a(yv)'), 5);
  assert.throws(() => splitSignature('a(s'), DbusError);
});

test('a method call round-trips through the wire format', () => {
  const raw = encodeMessage({
    serial: 7,
    destination: ':1.24',
    path: '/org/a11y/atspi/accessible/root',
    iface: 'org.a11y.atspi.Accessible',
    member: 'GetChildren',
  });
  assert.equal(messageLength(raw), raw.length);
  const back = decodeMessage(raw);
  assert.equal(back.serial, 7);
  assert.equal(back.destination, ':1.24');
  assert.equal(back.path, '/org/a11y/atspi/accessible/root');
  assert.equal(back.iface, 'org.a11y.atspi.Accessible');
  assert.equal(back.member, 'GetChildren');
});

test('the replies AT-SPI actually sends survive the round trip', () => {
  // An array of (bus name, object path) pairs, which is how every list of
  // children arrives.
  const children = [[':1.24', '/org/a11y/atspi/accessible/6'], [':1.24', '/org/a11y/atspi/accessible/180']];
  const list = decodeMessage(encodeMessage({
    type: MESSAGE_METHOD_RETURN, serial: 2, replySerial: 1, signature: 'a(so)', body: [children],
  }));
  assert.deepEqual(list.body[0], children);

  // A property, which arrives inside a variant that carries its own type.
  const property = decodeMessage(encodeMessage({
    type: MESSAGE_METHOD_RETURN, serial: 3, replySerial: 1, signature: 'v',
    body: [{ signature: 's', value: 'Chromium' }],
  }));
  assert.deepEqual(property.body, ['Chromium']);

  // A press, which answers with whether it did anything.
  const pressed = decodeMessage(encodeMessage({
    type: MESSAGE_METHOD_RETURN, serial: 4, replySerial: 1, signature: 'b', body: [true],
  }));
  assert.deepEqual(pressed.body, [true]);

  // Several values at once, where the second one's alignment depends on the
  // first one's length.
  const pair = decodeMessage(encodeMessage({
    type: MESSAGE_METHOD_RETURN, serial: 5, replySerial: 1, signature: 'su', body: ['push button', 4001],
  }));
  assert.deepEqual(pair.body, ['push button', 4001]);
});

test('an incomplete message is left alone until the rest of it arrives', () => {
  const raw = encodeMessage({
    type: MESSAGE_METHOD_RETURN, serial: 2, replySerial: 1, signature: 's', body: ['half a message'],
  });
  assert.equal(messageLength(raw.subarray(0, 8)), null);
  assert.equal(messageLength(raw.subarray(0, raw.length - 1)), null);
  assert.equal(messageLength(raw), raw.length);
  // Two messages in one chunk are separable, which is the only reason a
  // stream of them can be read at all.
  assert.equal(messageLength(Buffer.concat([raw, raw])), raw.length);
});

test('an address names the socket to open', () => {
  assert.equal(parseAddress('unix:path=/run/user/1000/at-spi/bus_99'), '/run/user/1000/at-spi/bus_99');
  assert.equal(parseAddress('unix:path=/tmp/dbus-x,guid=deadbeef'), '/tmp/dbus-x');
  assert.equal(parseAddress('unix:abstract=/tmp/dbus-y,guid=1'), '\0/tmp/dbus-y');
  assert.throws(() => parseAddress('tcp:host=127.0.0.1,port=1'), DbusError);
});

// A bus that authenticates and answers, so the handshake and the reply
// routing are exercised as they happen rather than as they are imagined.
function fakeBus(socketPath, answer) {
  const server = net.createServer((socket) => {
    let greeted = false;
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!greeted) {
        const text = buffered.toString('ascii');
        if (text.includes('AUTH EXTERNAL') && !text.includes('BEGIN')) {
          socket.write('OK 1234deadbeef\r\n');
          return;
        }
        if (!text.includes('BEGIN\r\n')) return;
        greeted = true;
        buffered = buffered.subarray(text.indexOf('BEGIN\r\n') + 7);
      }
      for (;;) {
        const length = messageLength(buffered);
        if (length == null) return;
        const message = decodeMessage(buffered.subarray(0, length));
        buffered = buffered.subarray(length);
        const reply = answer(message);
        if (reply) socket.write(reply);
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

test('the client authenticates, registers, calls and reports an error back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-dbus-'));
  const socketPath = path.join(dir, 'bus');
  const asked = [];
  const server = await fakeBus(socketPath, (message) => {
    asked.push(`${message.iface}.${message.member}`);
    if (message.member === 'Hello') {
      return encodeMessage({
        type: MESSAGE_METHOD_RETURN, serial: 100, replySerial: message.serial,
        signature: 's', body: [':1.99'],
      });
    }
    if (message.member === 'GetChildren') {
      return encodeMessage({
        type: MESSAGE_METHOD_RETURN, serial: 101, replySerial: message.serial,
        signature: 'a(so)', body: [[[':1.5', '/org/a11y/atspi/accessible/9']]],
      });
    }
    return encodeMessage({
      type: MESSAGE_ERROR, serial: 102, replySerial: message.serial,
      errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
      signature: 's', body: ['no such member'],
    });
  });

  try {
    const bus = await connect(`unix:path=${socketPath}`);
    // Hello is a registration, not a greeting: the name it answers with is
    // this connection's own, and nothing routes until it has one.
    assert.equal(bus.name, ':1.99');
    assert.equal(asked[0], 'org.freedesktop.DBus.Hello');

    const [children] = await bus.call({
      destination: ':1.5', path: '/org/a11y/atspi/accessible/root',
      iface: 'org.a11y.atspi.Accessible', member: 'GetChildren',
    });
    assert.deepEqual(children, [[':1.5', '/org/a11y/atspi/accessible/9']]);

    // An error is the bus answering, not the connection failing: it names
    // what went wrong and the connection stays usable.
    await assert.rejects(
      bus.call({
        destination: ':1.5', path: '/x', iface: 'org.a11y.atspi.Action', member: 'Nonsense',
      }),
      (err) => err instanceof DbusError
        && err.dbusName === 'org.freedesktop.DBus.Error.UnknownMethod'
        && /no such member/.test(err.message),
    );
    const [again] = await bus.call({
      destination: ':1.5', path: '/x', iface: 'org.a11y.atspi.Accessible', member: 'GetChildren',
    });
    assert.equal(again.length, 1);
    bus.close();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection that goes away rejects what was waiting on it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-dbus-'));
  const socketPath = path.join(dir, 'bus');
  const server = await fakeBus(socketPath, (message) => (message.member === 'Hello'
    ? encodeMessage({
      type: MESSAGE_METHOD_RETURN, serial: 1, replySerial: message.serial,
      signature: 's', body: [':1.1'],
    })
    // Anything else is swallowed, so the call is still outstanding when the
    // bus hangs up.
    : null));
  try {
    const bus = await connect(`unix:path=${socketPath}`);
    const pending = bus.call({
      destination: ':1.5', path: '/x', iface: 'org.a11y.atspi.Accessible', member: 'GetChildren',
    });
    bus.close();
    await assert.rejects(pending, DbusError);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
