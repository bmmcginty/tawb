'use strict';

// An application on the accessibility bus, run from inside a Flatpak sandbox.
//
// TAWB does not read a browser by listening. TAWB connects to the
// accessibility bus and calls *into* the browser's own connection at
// `/org/a11y/atspi/accessible/root` — see the note at the top of atspi.js,
// which is why no at-spi registry daemon has to be running.
//
// A Flatpak application does not talk to the accessibility bus either: flatpak
// gives it a second `xdg-dbus-proxy`. The file chooser only needs the proxy to
// carry calls outward from the sandbox. Reading needs the opposite direction —
// a call from outside the sandbox, to a connection inside it, on a path the
// sandboxed side serves. A proxy that carries one direction and not the other
// leaves a browser that can ask for a file but cannot be read.
//
// This answers the three members `atspi.js` asks first, and prints the unique
// name its connection has, so a reader outside the sandbox can call it.

const { connect } = require('/srv/tawb/src/dbus');

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

async function main() {
  const address = process.env.AT_SPI_BUS_ADDRESS;
  const connection = await connect(address);

  connection.onMethodCall((message, { reply, fail }) => {
    if (message.path !== ROOT_PATH) return false;
    if (message.iface === ACCESSIBLE && message.member === 'GetRole') {
      reply('u', [14]); // application
      return true;
    }
    if (message.iface === ACCESSIBLE && message.member === 'GetChildAtIndex') {
      reply('(so)', [[connection.name, `${ROOT_PATH}/1`]]);
      return true;
    }
    if (message.iface === PROPERTIES && message.member === 'Get') {
      const [wanted, property] = message.body || [];
      if (wanted !== ACCESSIBLE) return false;
      if (property === 'Name') {
        reply('v', [{ signature: 's', value: 'a sandboxed application' }]);
        return true;
      }
      if (property === 'ChildCount') {
        reply('v', [{ signature: 'i', value: 1 }]);
        return true;
      }
      fail('org.freedesktop.DBus.Error.UnknownProperty', `no ${property} here`);
      return true;
    }
    return false;
  });

  process.stdout.write(`${JSON.stringify({
    address, uniqueName: connection.name, serving: ROOT_PATH,
  })}\n`);
  // Stay on the bus for as long as whoever started this keeps its stdin open.
  process.stdin.resume();
  process.stdin.on('end', () => { connection.close(); process.exit(0); });
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ failed: String(err.stack || err) })}\n`);
  process.exit(1);
});
