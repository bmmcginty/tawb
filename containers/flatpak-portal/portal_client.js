'use strict';

// A portal client, run from inside a Flatpak sandbox.
//
// This does what Chromium's `SelectFileDialogLinuxPortal` and GTK's
// `GtkFileChooserNative` do, in the order they do it, and nothing else:
//
//   1. register the application id on `org.freedesktop.host.portal.Registry`;
//   2. read the `version` property of `org.freedesktop.portal.FileChooser`;
//   3. make up a handle token and compute the request path from the token and
//      the connection's own unique name;
//   4. subscribe to `Response` on that path with AddMatch, before calling;
//   5. call `OpenFile` or `SaveFile`;
//   6. check that the path the portal returned is the path already subscribed
//      to, and wait for the signal to arrive on it.
//
// Step 4 before step 5 is the whole point of the test. A Flatpak application
// does not talk to the session bus: it talks to the `xdg-dbus-proxy` flatpak
// started for it, and the proxy decides which messages cross. A method call to
// a name the proxy allows is the easy half. `Response` is a broadcast signal
// with no destination, sent by a sender the proxy knows only as a unique name,
// and a proxy that drops it leaves the chooser hanging with no error anywhere.
//
// The result is one JSON object on stdout, so the shell script that runs this
// inside the sandbox can be read from outside it.

const { connect } = require('/srv/tawb/src/dbus');

const PORTAL_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const FILECHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';
const RESPONSE_TIMEOUT_MS = 15000;

// The path a client computes for itself, from the specification rather than
// from anything the portal said.
function requestPathFor(sender, token) {
  const who = String(sender).replace(/^:/, '').replace(/\./g, '_');
  return `${PORTAL_PATH}/request/${who}/${token}`;
}

function optionValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

// The `uris` entry of the answer, which is the only part a browser uses.
function urisOf(options) {
  if (!Array.isArray(options)) return [];
  for (const entry of options) {
    if (Array.isArray(entry) && entry[0] === 'uris') {
      const held = optionValue(entry[1]);
      return Array.isArray(held) ? held : [];
    }
  }
  return [];
}

async function chooser(connection, { member, options, title, closeIt = false }) {
  const token = `tawb_probe_${Math.floor(Math.random() * 1e9)}`;
  const expected = requestPathFor(connection.name, token);

  const arrived = new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ signal: 'timeout' }), RESPONSE_TIMEOUT_MS);
    connection.onSignal((message) => {
      if (message.path !== expected) return;
      if (message.iface !== REQUEST) return;
      if (message.member !== 'Response') return;
      clearTimeout(timer);
      resolve({ signal: 'arrived', code: message.body[0], uris: urisOf(message.body[1]) });
    });
  });

  // Subscribed before the call, because the answer may be sent before the call
  // returns and a signal nobody is listening for is simply gone.
  await connection.call({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    iface: 'org.freedesktop.DBus',
    member: 'AddMatch',
    signature: 's',
    body: [`type='signal',interface='${REQUEST}',path='${expected}'`],
  });

  const [returned] = await connection.call({
    destination: PORTAL_NAME,
    path: PORTAL_PATH,
    iface: FILECHOOSER,
    member,
    signature: 'ssa{sv}',
    body: ['', title, [['handle_token', token], ...options]],
  });

  // Cancelling a chooser the reader is still looking at. The client that
  // raised the request is the only one that may close it, and the portal
  // answers a closed request with the declined code rather than silence.
  let closed = null;
  if (closeIt) {
    try {
      await connection.call({
        destination: PORTAL_NAME, path: returned, iface: REQUEST, member: 'Close',
      });
      closed = 'ok';
    } catch (err) {
      closed = String(err.message || err);
    }
  }

  const answer = await arrived;
  return {
    closed,
    member,
    expectedPath: expected,
    returnedPath: returned,
    pathMatches: returned === expected,
    ...answer,
  };
}

async function main() {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  const result = { address, sandbox: true };
  const connection = await connect(address);
  result.uniqueName = connection.name;

  try {
    await connection.call({
      destination: PORTAL_NAME,
      path: PORTAL_PATH,
      iface: 'org.freedesktop.host.portal.Registry',
      member: 'Register',
      signature: 'sa{sv}',
      body: ['org.mozilla.firefox', []],
    });
    result.register = 'ok';
  } catch (err) {
    result.register = String(err.message || err);
  }

  try {
    const [version] = await connection.call({
      destination: PORTAL_NAME,
      path: PORTAL_PATH,
      iface: 'org.freedesktop.DBus.Properties',
      member: 'Get',
      signature: 'ss',
      body: [FILECHOOSER, 'version'],
    });
    result.version = optionValue(version);
  } catch (err) {
    result.version = String(err.message || err);
  }

  result.open = await chooser(connection, {
    member: 'OpenFile', title: 'Choose a file', options: [],
  });
  result.directory = await chooser(connection, {
    member: 'OpenFile',
    title: 'Choose a folder',
    options: [['directory', { signature: 'b', value: true }]],
  });
  result.save = await chooser(connection, {
    member: 'SaveFile',
    title: 'Save as',
    options: [['current_name', { signature: 's', value: 'report.txt' }]],
  });

  result.cancelled = await chooser(connection, {
    member: 'OpenFile', title: 'please cancel this one', options: [],
  });
  result.closedByClient = await chooser(connection, {
    member: 'OpenFile', title: 'a slow one', options: [], closeIt: true,
  });

  // The accessibility bus, which is what TAWB reads a browser through. Flatpak
  // makes a second proxy for it, so whether a sandboxed browser can be read at
  // all is a separate question from whether its file chooser works.
  result.a11y = { env: process.env.AT_SPI_BUS_ADDRESS || null };
  try {
    const [address] = await connection.call({
      destination: 'org.a11y.Bus',
      path: '/org/a11y/bus',
      iface: 'org.a11y.Bus',
      member: 'GetAddress',
    });
    result.a11y.getAddress = address;
  } catch (err) {
    result.a11y.getAddress = String(err.message || err);
  }
  for (const [label, address] of [
    ['viaEnv', process.env.AT_SPI_BUS_ADDRESS],
    ['viaProxySocket', 'unix:path=/run/flatpak/at-spi-bus'],
    ['viaGetAddress', result.a11y.getAddress],
  ]) {
    if (!address || !String(address).startsWith('unix:')) continue;
    try {
      const other = await connect(address);
      result.a11y[label] = { connected: true, uniqueName: other.name };
      other.close();
    } catch (err) {
      result.a11y[label] = { connected: false, error: String(err.message || err) };
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  connection.close();
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ failed: String(err.stack || err) })}\n`);
  process.exit(1);
});
