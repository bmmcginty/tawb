'use strict';

// Somewhere for the browser to describe its own windows to.
//
// Reading a native dialog needs two things (see atspi.js): a browser started
// with platform accessibility on, and an accessibility bus for it to register
// with. The bus is the awkward one. A graphical desktop already has it, run
// by at-spi2-core, and every screen reader on the machine uses that. A
// terminal with no desktop — which is exactly where this program is most at
// home, with the browser under Xvfb — has neither it nor the session bus it
// would live on.
//
// So one is provided, and only where one is missing:
//
//   * A session bus that already answers for org.a11y.Bus is used as it is.
//     That is the desktop case, and nothing is disturbed.
//   * A session bus with no accessibility bus behind it gets ours: the name
//     is claimed only if nobody owns it, and what it hands out is the session
//     bus itself. An accessibility bus is an ordinary bus; the separate one a
//     desktop runs is for isolation, not for a different protocol.
//   * No session bus at all means one is started for the browser, private to
//     this session and taken down with it.
//
// The name is released when the session ends, so a desktop that later starts
// a real one finds it free.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { connect } = require('./dbus');

const A11Y_NAME = 'org.a11y.Bus';
const A11Y_PATH = '/org/a11y/bus';
const A11Y_INTERFACE = 'org.a11y.Bus';
const STATUS_INTERFACE = 'org.a11y.Status';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

// RequestName's answer. 1 is "it is yours now"; anything else means somebody
// else has it, which is a reason to leave it alone rather than an error.
const NAME_PRIMARY_OWNER = 1;

const START_TIMEOUT_MS = 5000;

// Where a session bus already is. The environment names one if a desktop
// started it; systemd puts a user bus at a known path whether or not anything
// exported the variable, and that is the one a bare login session has.
function sessionBusAddress() {
  const named = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (named) return named;
  let uid;
  try {
    uid = os.userInfo().uid;
  } catch {
    return null;
  }
  const path = `/run/user/${uid}/bus`;
  return fs.existsSync(path) ? `unix:path=${path}` : null;
}

// A session bus of our own, for a machine that has none. dbus-daemon prints
// the address it chose and then stays in the foreground, which is what makes
// it something this session can own and take away again.
function startSessionBus({ log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('dbus-daemon', ['--session', '--nofork', '--print-address'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`no session bus, and dbus-daemon could not be started: ${err.message}`));
      return;
    }

    let address = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { child.kill('SIGTERM'); } catch { /* never started */ }
        reject(err);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () => finish(new Error('dbus-daemon did not say where it was listening')),
      START_TIMEOUT_MS,
    );

    child.stdout.on('data', (chunk) => {
      address += chunk.toString('utf8');
      const line = address.split('\n')[0];
      if (address.includes('\n') && line.trim()) {
        log('a11y.bus.started', { address: line.trim() });
        finish(null, { address: line.trim(), child });
      }
    });
    child.once('error', (err) => finish(new Error(`dbus-daemon could not be started: ${err.message}`)));
    child.once('exit', (code) => finish(new Error(`dbus-daemon exited with ${code}`)));
  });
}

// Answer for org.a11y.Bus on a connection we hold, handing out the bus we are
// already on. Two members are asked in practice: GetAddress, by every
// application looking for the accessibility bus, and the Status properties,
// which is how Chromium decides whether accessibility is wanted here at all.
function serveAccessibilityBus(connection, address) {
  connection.onMethodCall((message, { reply, fail }) => {
    if (message.path !== A11Y_PATH) return false;
    if (message.iface === A11Y_INTERFACE && message.member === 'GetAddress') {
      reply('s', [address]);
      return true;
    }
    if (message.iface === PROPERTIES && message.member === 'Get') {
      const [wanted, property] = message.body || [];
      if (wanted !== STATUS_INTERFACE) return false;
      if (property === 'IsEnabled') {
        reply('v', [{ signature: 'b', value: true }]);
        return true;
      }
      if (property === 'ScreenReaderEnabled') {
        // True is the honest answer. Something is about to read this
        // browser's windows aloud to a person who cannot see them, and that
        // is what the property is asking.
        reply('v', [{ signature: 'b', value: true }]);
        return true;
      }
      fail('org.freedesktop.DBus.Error.UnknownProperty', `no ${property} here`);
      return true;
    }
    if (message.iface === PROPERTIES && message.member === 'Set') {
      reply();
      return true;
    }
    return false;
  });
}

// An accessibility bus, however one has to be come by.
//
// What comes back names the bus to read trees on, the environment a browser
// must be started with to find it, and how to put back whatever was set up.
// `available: false` is an ordinary answer rather than a failure: a machine
// without D-Bus is one where native dialogs cannot be read, and everything
// else about the browser still works.
async function openAccessibilityBus({ log = () => {} } = {}) {
  const idle = {
    available: false, address: null, env: {}, reason: null, close: async () => {},
  };

  let sessionAddress = sessionBusAddress();
  let daemon = null;
  const env = {};
  const startOwnBus = async () => {
    const started = await startSessionBus({ log });
    sessionAddress = started.address;
    daemon = started.child;
    // Override an exported address too. A stale DBUS_SESSION_BUS_ADDRESS is
    // indistinguishable from a desktop bus until connecting to it fails, and
    // passing that stale value through would leave Firefox describing no
    // permission prompts at all.
    env.DBUS_SESSION_BUS_ADDRESS = sessionAddress;
    // AT-SPI clients can use the accessibility bus directly. This also avoids
    // relying on a toolkit to discover our service through a session bus that
    // exists only for this browser.
    env.AT_SPI_BUS_ADDRESS = sessionAddress;
    // Firefox's GTK accessibility bridge does not start merely because an
    // isolated bus answers ScreenReaderEnabled. This is the standard GTK
    // startup signal; without it Firefox never registers an AT-SPI tree and
    // microphone permission doorhangers remain invisible to the reader.
    env.GNOME_ACCESSIBILITY = '1';
  };
  if (!sessionAddress) {
    try {
      await startOwnBus();
    } catch (err) {
      return { ...idle, reason: String(err.message || err) };
    }
  }

  const stop = async (connection) => {
    if (connection) connection.close();
    if (daemon) {
      try { daemon.kill('SIGTERM'); } catch { /* already gone */ }
    }
  };

  let session;
  try {
    session = await connect(sessionAddress);
  } catch (err) {
    // Login shells can retain DBUS_SESSION_BUS_ADDRESS after their desktop
    // session has ended. Treat an address that cannot be reached the same as
    // no address, and give the browser a private bus instead.
    if (daemon) {
      await stop(null);
      return { ...idle, reason: String(err.message || err) };
    }
    log('a11y.bus.unreachable', {
      address: sessionAddress, error: String(err.message || err).slice(0, 160),
    });
    try {
      await startOwnBus();
      session = await connect(sessionAddress);
    } catch (fallbackError) {
      await stop(null);
      return { ...idle, reason: String(fallbackError.message || fallbackError) };
    }
  }

  // Somebody else's accessibility bus, which is the desktop case: use it and
  // hold nothing of our own. Do not ask a private bus first: its standard
  // service directories may contain an AT-SPI launcher inherited from the
  // machine, and activating that launcher can hand back the dead desktop
  // socket that made us start a private bus in the first place.
  if (!daemon) {
    try {
      const [address] = await session.call({
        destination: A11Y_NAME, path: A11Y_PATH, iface: A11Y_INTERFACE, member: 'GetAddress',
      });
      session.close();
      log('a11y.bus.found', { address });
      return {
        available: true,
        address,
        env,
        reason: null,
        close: async () => { await stop(null); },
      };
    } catch {
      // Nobody is answering for it, so we will.
    }
  }

  let owned;
  try {
    // Do not queue behind an accessibility service that appeared between the
    // probe above and this request. A queued owner could unexpectedly replace
    // the desktop service later.
    owned = await session.requestName(A11Y_NAME, 4); // DBUS_NAME_FLAG_DO_NOT_QUEUE
  } catch (err) {
    await stop(session);
    return { ...idle, reason: String(err.message || err) };
  }
  if (owned !== NAME_PRIMARY_OWNER) {
    // The name has an owner that did not answer. Whatever it is doing, it is
    // not ours to take over.
    await stop(session);
    return { ...idle, reason: 'an accessibility bus is registered but not answering' };
  }

  serveAccessibilityBus(session, sessionAddress);
  log('a11y.bus.served', { address: sessionAddress, ownSession: !!daemon });
  return {
    available: true,
    address: sessionAddress,
    env,
    reason: null,
    close: async () => { await stop(session); },
  };
}

module.exports = {
  openAccessibilityBus, sessionBusAddress, startSessionBus, serveAccessibilityBus, A11Y_NAME,
};
