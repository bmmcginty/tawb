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
//   * No session bus at all means one is started for the browser. It normally
//     ends with the reader, but a browser deliberately kept alive keeps its
//     bus too; both are recorded and swept as one browser-lifetime resource.
//
// The name is released when the reader ends, so a desktop that later starts a
// real one finds it free. A kept browser already has the direct bus address in
// its environment, and later readers use the same recorded address.

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

// A session bus of our own, for a machine that has none. Its address is chosen
// here rather than read from stdout so the daemon can have no pipe back to the
// reader. Closing that pipe when the launching process exits otherwise takes
// down a bus that a kept browser still needs, even if the child was unrefed.
//
// The daemon is given a configuration of our own rather than `--session`, and
// the reason is the one thing that can make a browser unusable on a private
// bus. The machine's session configuration names the desktop services it will
// activate on demand — portals, dconf, GVfs, a keyring — and D-Bus's
// StartServiceByName does not return until the service has started or failed.
// On a terminal with no desktop those launchers cannot come up, so a browser
// that asks for one waits out the full activation timeout, and its own first
// network request waits with it. With no <servicedir> the names are simply not
// activatable, the browser is refused at once, and it carries on.
function privateBusConfig(socketPath) {
  return [
    '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
    ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
    '<busconfig>',
    '  <type>session</type>',
    `  <listen>unix:path=${socketPath}</listen>`,
    '  <auth>EXTERNAL</auth>',
    '  <policy context="default">',
    '    <allow send_destination="*"/>',
    '    <allow receive_sender="*"/>',
    '    <allow own="*"/>',
    '  </policy>',
    '</busconfig>',
    '',
  ].join('\n');
}

function startSessionBus({ log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    // Put a random socket path in the daemon's command line. If its pid is
    // ever reused, the browser registry can prove that a process is this
    // particular companion before signalling it, rather than accepting any
    // unrelated dbus-daemon with the same pid.
    const socketPath = path.join(
      os.tmpdir(), `tawb-a11y-${process.pid}-${randomBytes(6).toString('hex')}.sock`,
    );
    const configPath = `${socketPath}.conf`;
    const address = `unix:path=${socketPath}`;
    const removeFiles = () => {
      fs.rmSync(socketPath, { force: true });
      fs.rmSync(configPath, { force: true });
    };
    let child;
    try {
      fs.writeFileSync(configPath, privateBusConfig(socketPath), { mode: 0o600 });
      // `--address` repeats what the config's <listen> already says, on
      // purpose: the browser registry proves a companion daemon is ours by
      // finding the socket path in its command line before it signals it.
      child = spawn('dbus-daemon', [
        `--config-file=${configPath}`, `--address=${address}`, '--nofork',
      ], { stdio: 'ignore', detached: true });
    } catch (err) {
      removeFiles();
      reject(new Error(`no session bus, and dbus-daemon could not be started: ${err.message}`));
      return;
    }
    child.once('exit', removeFiles);

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (err) {
        try { child.kill('SIGTERM'); } catch { /* never started */ }
        reject(err);
      } else {
        log('a11y.bus.started', { address });
        resolve({ address, child, socketPath });
      }
    };
    const timer = setTimeout(
      () => finish(new Error('dbus-daemon did not open its private socket')),
      START_TIMEOUT_MS,
    );
    const poll = setInterval(() => {
      if (fs.existsSync(socketPath)) finish(null);
    }, 10);
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
    available: false, address: null, env: {}, reason: null, owned: false, pid: null,
    close: async () => {}, leaveRunning: async () => {},
  };

  let sessionAddress = sessionBusAddress();
  let daemon = null;
  let daemonSocket = null;
  const env = {};
  const startOwnBus = async () => {
    const started = await startSessionBus({ log });
    sessionAddress = started.address;
    daemon = started.child;
    daemonSocket = started.socketPath;
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
      if (daemonSocket) fs.rmSync(daemonSocket, { force: true });
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
        owned: false,
        pid: null,
        close: async () => { await stop(null); },
        leaveRunning: async () => {},
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
  let released = false;
  return {
    available: true,
    address: sessionAddress,
    env,
    reason: null,
    owned: !!daemon,
    pid: daemon ? daemon.pid : null,
    close: async () => {
      if (released) return;
      released = true;
      await stop(session);
    },
    // A kept browser still has DBUS_SESSION_BUS_ADDRESS and
    // AT_SPI_BUS_ADDRESS pointing here. Release the service connection owned
    // by this reader, but leave the daemon alive for the browser and make its
    // pipes stop keeping this Node process alive. The browser registry owns
    // the daemon from this point and removes it with the browser.
    leaveRunning: async () => {
      if (released) return;
      released = true;
      session.close();
      if (daemon) {
        if (daemon.stdout && daemon.stdout.unref) daemon.stdout.unref();
        if (daemon.stderr && daemon.stderr.unref) daemon.stderr.unref();
        daemon.unref();
      }
    },
  };
}

module.exports = {
  openAccessibilityBus, sessionBusAddress, startSessionBus, serveAccessibilityBus, A11Y_NAME,
};
