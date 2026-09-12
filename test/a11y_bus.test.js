'use strict';

// Somewhere for the browser to describe its own windows to.
//
// A desktop has an accessibility bus already and this does nothing. A
// terminal with no desktop has neither it nor the session bus it would live
// on, and that is the case worth testing: the name is claimed, the address
// handed out is a bus that really exists, and the property Chromium checks
// before it turns accessibility on is answered.

const test = require('node:test');
const assert = require('node:assert');

const { connect } = require('../src/dbus');
const {
  openAccessibilityBus, startSessionBus, serveAccessibilityBus, sessionBusAddress, A11Y_NAME,
} = require('../src/a11y_bus');

// dbus-daemon is not a dependency of this program, it is a thing a machine
// either has or has not. Where it is missing, so is the whole feature.
async function busOrSkip(t) {
  try {
    return await startSessionBus();
  } catch (err) {
    t.skip(`no session bus available here: ${err.message}`);
    return null;
  }
}

test('a session bus can be started for a machine that has none', async (t) => {
  const started = await busOrSkip(t);
  if (!started) return;
  try {
    assert.match(started.address, /^unix:/);
    const client = await connect(started.address);
    assert.match(client.name, /^:/);
    client.close();
  } finally {
    started.child.kill('SIGTERM');
  }
});

test('the accessibility bus we serve answers what a browser asks it', async (t) => {
  const started = await busOrSkip(t);
  if (!started) return;
  let server;
  let client;
  try {
    server = await connect(started.address);
    // Claiming the name is what makes this ours to answer for; a bus that
    // already had one would have answered before we got here.
    assert.equal(await server.requestName(A11Y_NAME), 1);
    serveAccessibilityBus(server, started.address);

    client = await connect(started.address);
    const [address] = await client.call({
      destination: A11Y_NAME,
      path: '/org/a11y/bus',
      iface: 'org.a11y.Bus',
      member: 'GetAddress',
    });
    // The address handed out is a bus that exists, which is the whole trick:
    // an accessibility bus is an ordinary bus, and the separate one a desktop
    // runs is for isolation rather than for a different protocol.
    assert.equal(address, started.address);

    // What ShouldEnableAccessibility reads before the browser will describe
    // anything at all.
    const [enabled] = await client.call({
      destination: A11Y_NAME,
      path: '/org/a11y/bus',
      iface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: ['org.a11y.Status', 'IsEnabled'],
    });
    assert.equal(enabled, true);

    // Something we do not answer for is refused rather than left hanging.
    await assert.rejects(client.call({
      destination: A11Y_NAME,
      path: '/org/a11y/bus',
      iface: 'org.a11y.Bus',
      member: 'SomethingElse',
      timeout: 4000,
    }), /UnknownMethod/);
  } finally {
    if (client) client.close();
    if (server) server.close();
    started.child.kill('SIGTERM');
  }
});

test('an unreachable exported bus is replaced with a private accessibility bus', async (t) => {
  const before = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/tawb-session-bus-that-does-not-exist';
  let bus;
  try {
    bus = await openAccessibilityBus();
    if (!bus.available && /dbus-daemon could not be started/.test(bus.reason || '')) {
      t.skip(bus.reason);
      return;
    }
    assert.equal(bus.available, true, bus.reason);
    assert.match(bus.address, /^unix:/);
    assert.equal(bus.env.DBUS_SESSION_BUS_ADDRESS, bus.address);
    assert.equal(bus.env.AT_SPI_BUS_ADDRESS, bus.address);
    assert.equal(bus.env.GNOME_ACCESSIBILITY, '1');

    const client = await connect(bus.address);
    client.close();
  } finally {
    if (bus) await bus.close();
    if (before === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = before;
  }
});

test('an exported session bus address is taken as it stands', () => {
  const before = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/tmp/whatever-bus';
  try {
    assert.equal(sessionBusAddress(), 'unix:path=/tmp/whatever-bus');
  } finally {
    if (before === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = before;
  }
});
