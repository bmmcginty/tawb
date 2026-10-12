'use strict';

// The D-Bus client, differenced between the JavaScript original and the
// Crystal port.
//
// Marshalling is the whole risk, and it is a risk that behavioural testing
// does not catch: an implementation that decodes its own output can have every
// alignment rule wrong and still agree with itself. So each implementation's
// bytes are handed to the other implementation's decoder, and the two
// encoders are required to produce the same hex for the same message.
//
// The client itself is then driven against one bus, written here in
// JavaScript, which authenticates and answers exactly as a real bus does. Both
// clients walk the same steps, including a step the bus refuses, so a refusal
// is compared as a refusal.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const dbus = require('../src/dbus');
const { dbusImplementations } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');
const path = require('node:path');

const implementations = dbusImplementations(dbus);

// The messages that actually travel on the accessibility bus, which is what
// the byte comparison is for. Nothing here is invented: a children list is
// 'a(so)', a property is 'v', a press answers 'b', and a role with a state is
// 'su' where the second value's alignment depends on the first value's length.
const SHAPES = [
  {
    what: 'a method call with no body',
    message: {
      serial: 7,
      destination: ':1.24',
      path: '/org/a11y/atspi/accessible/root',
      iface: 'org.a11y.atspi.Accessible',
      member: 'GetChildren',
    },
  },
  {
    what: 'a children list',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN,
      serial: 2,
      replySerial: 1,
      signature: 'a(so)',
      body: [[[':1.24', '/org/a11y/atspi/accessible/6'], [':1.24', '/org/a11y/atspi/accessible/180']]],
    },
  },
  {
    what: 'an empty children list',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN, serial: 2, replySerial: 1, signature: 'a(so)', body: [[]],
    },
  },
  {
    what: 'a property inside a variant',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN, serial: 3, replySerial: 1, signature: 'v',
      body: [{ signature: 's', value: 'Chromium' }],
    },
  },
  {
    what: 'a property whose variant holds a number',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN, serial: 3, replySerial: 1, signature: 'v',
      body: [{ signature: 'u', value: 4001 }],
    },
  },
  {
    what: 'whether a press did anything',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN, serial: 4, replySerial: 1, signature: 'b', body: [true],
    },
  },
  {
    what: 'a role and a state, where the second value aligns behind the first',
    message: {
      type: dbus.MESSAGE_METHOD_RETURN, serial: 5, replySerial: 1, signature: 'su',
      body: ['push button', 4001],
    },
  },
  {
    what: 'a property asked for by interface and name',
    message: {
      serial: 11,
      destination: ':1.24',
      path: '/org/a11y/atspi/accessible/6',
      iface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: ['org.a11y.atspi.Accessible', 'Name'],
    },
  },
  {
    what: 'a name request',
    message: {
      serial: 12,
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'RequestName',
      signature: 'su',
      body: ['org.a11y.Bus', 0],
    },
  },
  {
    what: 'an error, which is a reply that names what refused',
    message: {
      type: dbus.MESSAGE_ERROR, serial: 13, replySerial: 9,
      errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
      signature: 's', body: ['no such member'],
    },
  },
  {
    what: 'a text extraction, where two numbers follow a string',
    message: {
      serial: 14,
      destination: ':1.24',
      path: '/org/a11y/atspi/accessible/6',
      iface: 'org.a11y.atspi.Text',
      member: 'GetText',
      signature: 'ii',
      body: [0, -1],
    },
  },
];

// Every encoder must produce the same bytes, and every decoder must read every
// encoder's bytes. Running the comparison once over all implementations is
// what makes the two directions testable at all.
test('the implementations marshal the bus\'s own messages to the same bytes', () => {
  for (const shape of SHAPES) {
    const encoded = implementations.map((implementation) => ({
      name: implementation.name,
      hex: implementation.encode(shape.message),
    }));
    const first = encoded[0];
    for (const other of encoded.slice(1)) {
      assert.equal(
        other.hex,
        first.hex,
        `${other.name} encoded ${shape.what} differently from ${first.name}`,
      );
    }
    // Each implementation reads every implementation's bytes, and the decoded
    // messages must agree field for field.
    const decoded = [];
    for (const producer of encoded) {
      for (const reader of implementations) {
        decoded.push({
          name: `${reader.name} reading ${producer.name}`,
          message: reader.decode(producer.hex),
          length: reader.messageLength(producer.hex),
        });
      }
    }
    const baseline = decoded[0];
    for (const other of decoded.slice(1)) {
      assert.deepEqual(
        other.message,
        baseline.message,
        `${other.name} decoded ${shape.what} differently from ${baseline.name}`,
      );
      assert.equal(other.length, baseline.length, `${other.name} measured ${shape.what} differently`);
    }
    assert.equal(baseline.length, first.hex.length / 2);
  }
});

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('a signature is read as the list of types it holds', () => {
    assert.deepEqual(implementation.splitSignature('a(so)'), ['a(so)']);
    assert.deepEqual(implementation.splitSignature('ss'), ['s', 's']);
    assert.deepEqual(implementation.splitSignature('ssa{sv}'), ['s', 's', 'a{sv}']);
    assert.deepEqual(implementation.splitSignature(''), []);
    assert.deepEqual(implementation.splitSignature('aa(si)'), ['aa(si)']);
    assert.equal(implementation.typeLength('a(yv)'), 5);
    assert.equal(implementation.typeLength('ssu', 1), 1);
    assert.throws(() => implementation.splitSignature('a(s'));
  });

  check('an address names the socket to open', () => {
    assert.equal(
      implementation.parseAddress('unix:path=/run/user/1000/at-spi/bus_99'),
      '/run/user/1000/at-spi/bus_99',
    );
    assert.equal(implementation.parseAddress('unix:path=/tmp/dbus-x,guid=deadbeef'), '/tmp/dbus-x');
    assert.equal(implementation.parseAddress('unix:abstract=/tmp/dbus-y,guid=1'), '\0/tmp/dbus-y');
    // Several addresses, where only the second one is a unix socket.
    assert.equal(
      implementation.parseAddress('tcp:host=127.0.0.1,port=1;unix:path=/tmp/dbus-z'),
      '/tmp/dbus-z',
    );
    assert.throws(() => implementation.parseAddress('tcp:host=127.0.0.1,port=1'));
  });

  check('an incomplete message is left alone until the rest of it arrives', () => {
    const hex = implementation.encode({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 2, replySerial: 1, signature: 's', body: ['half a message'],
    });
    assert.equal(implementation.messageLength(hex.slice(0, 16)), null);
    assert.equal(implementation.messageLength(hex.slice(0, hex.length - 2)), null);
    assert.equal(implementation.messageLength(hex), hex.length / 2);
    // Two messages in one chunk are separable, which is the only reason a
    // stream of messages can be read at all.
    assert.equal(implementation.messageLength(hex + hex), hex.length / 2);
  });

  check('the client authenticates, registers, calls, and reports a refusal back', async () => {
    const directory = tempDir('tawb-dbus-');
    const socket = path.join(directory, 'bus');
    const asked = [];
    const server = await fakeBus(socket, (message) => {
      asked.push(`${message.iface}.${message.member}`);
      return answerAsBusWould(message);
    });
    try {
      const outcome = await implementation.clientScenario(socket, [
        {
          type: 'call',
          destination: ':1.5',
          path: '/org/a11y/atspi/accessible/root',
          iface: 'org.a11y.atspi.Accessible',
          member: 'GetChildren',
        },
        {
          type: 'call',
          destination: ':1.5',
          path: '/org/a11y/atspi/accessible/6',
          iface: 'org.freedesktop.DBus.Properties',
          member: 'Get',
          signature: 'ss',
          body: ['org.a11y.atspi.Accessible', 'Name'],
        },
        // A refusal, which is the bus answering rather than the connection
        // failing: the connection stays usable behind it.
        {
          type: 'call', destination: ':1.5', path: '/x', iface: 'org.a11y.atspi.Action', member: 'Nonsense',
        },
        {
          type: 'call',
          destination: ':1.5',
          path: '/org/a11y/atspi/accessible/root',
          iface: 'org.a11y.atspi.Accessible',
          member: 'GetChildren',
        },
        { type: 'request_name', name: 'org.a11y.Bus', flags: 0 },
        { type: 'process_id', name: ':1.5' },
      ]);

      // Hello is a registration, not a greeting: the name it answers with is
      // this connection's own, and nothing routes until the connection has
      // one.
      assert.equal(outcome.name, ':1.99');
      assert.equal(asked[0], 'org.freedesktop.DBus.Hello');
      assert.deepEqual(outcome.results[0], {
        ok: true, body: [[[':1.5', '/org/a11y/atspi/accessible/9']]],
      });
      assert.deepEqual(outcome.results[1], { ok: true, body: ['Chromium'] });
      assert.equal(outcome.results[2].ok, false);
      assert.equal(outcome.results[2].name, 'org.freedesktop.DBus.Error.UnknownMethod');
      assert.match(outcome.results[2].error, /no such member/);
      assert.deepEqual(outcome.results[3], {
        ok: true, body: [[[':1.5', '/org/a11y/atspi/accessible/9']]],
      });
      assert.deepEqual(outcome.results[4], { ok: true, outcome: 1 });
      assert.deepEqual(outcome.results[5], { ok: true, pid: 4242 });
    } finally {
      server.close();
      removeTempDir(directory);
    }
  });

  check('a call that nothing answers gives up rather than waiting forever', async () => {
    const directory = tempDir('tawb-dbus-');
    const socket = path.join(directory, 'bus');
    // Hello is answered, so the connection registers; everything after it is
    // swallowed, so the call is still outstanding when the timeout runs out.
    const server = await fakeBus(socket, (message) => (message.member === 'Hello'
      ? helloReply(message)
      : null));
    try {
      const outcome = await implementation.clientScenario(socket, [
        {
          type: 'call',
          destination: ':1.5',
          path: '/x',
          iface: 'org.a11y.atspi.Accessible',
          member: 'GetChildren',
          timeout: 300,
        },
      ]);
      assert.equal(outcome.name, ':1.1');
      assert.equal(outcome.results[0].ok, false);
      assert.match(outcome.results[0].error, /GetChildren/);
    } finally {
      server.close();
      removeTempDir(directory);
    }
  });
}

function helloReply(message) {
  return dbus.encodeMessage({
    type: dbus.MESSAGE_METHOD_RETURN,
    serial: 1,
    replySerial: message.serial,
    signature: 's',
    body: [':1.1'],
  });
}

// What a bus answers, for the members this scenario asks about. Written once
// so that both clients are answered identically.
function answerAsBusWould(message) {
  if (message.member === 'Hello') {
    return dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 100, replySerial: message.serial,
      signature: 's', body: [':1.99'],
    });
  }
  if (message.member === 'GetChildren') {
    return dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 101, replySerial: message.serial,
      signature: 'a(so)', body: [[[':1.5', '/org/a11y/atspi/accessible/9']]],
    });
  }
  if (message.member === 'Get') {
    return dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 102, replySerial: message.serial,
      signature: 'v', body: [{ signature: 's', value: 'Chromium' }],
    });
  }
  if (message.member === 'RequestName') {
    return dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 103, replySerial: message.serial,
      signature: 'u', body: [1],
    });
  }
  if (message.member === 'GetConnectionUnixProcessID') {
    return dbus.encodeMessage({
      type: dbus.MESSAGE_METHOD_RETURN, serial: 104, replySerial: message.serial,
      signature: 'u', body: [4242],
    });
  }
  return dbus.encodeMessage({
    type: dbus.MESSAGE_ERROR, serial: 105, replySerial: message.serial,
    errorName: 'org.freedesktop.DBus.Error.UnknownMethod',
    signature: 's', body: ['no such member'],
  });
}

// A bus that authenticates and answers, so the handshake and the reply routing
// are exercised as they happen rather than as they are imagined.
function fakeBus(socketPath, answer) {
  const server = net.createServer((socket) => {
    let greeted = false;
    let buffered = Buffer.alloc(0);
    socket.on('error', () => { /* a client that hangs up is the point of one test */ });
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
        const length = dbus.messageLength(buffered);
        if (length == null) return;
        const message = dbus.decodeMessage(buffered.subarray(0, length));
        buffered = buffered.subarray(length);
        const reply = answer(message);
        if (reply) socket.write(reply);
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}
