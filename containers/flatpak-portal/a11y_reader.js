'use strict';

// TAWB's side of the accessibility bus, reading an application by calling into
// it. The unique name of the connection to read is the first argument.
//
// This is what `atspi.js` does and in the order it does it: the root object's
// Name and ChildCount as properties, then GetRole, then a child. The point of
// the test is only the direction — outside the sandbox, inward.

const { connect } = require('/app/src/dbus');

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

async function main() {
  const [target] = process.argv.slice(2);
  const connection = await connect(process.env.AT_SPI_BUS_ADDRESS);
  const result = { reader: connection.name, target };

  const ask = async (label, iface, member, signature, body) => {
    try {
      const answer = await connection.call({
        destination: target, path: ROOT_PATH, iface, member, signature, body, timeout: 5000,
      });
      result[label] = JSON.parse(JSON.stringify(answer));
    } catch (err) {
      result[label] = { error: String(err.message || err) };
    }
  };

  await ask('name', PROPERTIES, 'Get', 'ss', [ACCESSIBLE, 'Name']);
  await ask('childCount', PROPERTIES, 'Get', 'ss', [ACCESSIBLE, 'ChildCount']);
  await ask('role', ACCESSIBLE, 'GetRole', '', []);
  await ask('child', ACCESSIBLE, 'GetChildAtIndex', 'i', [0]);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  connection.close();
}

main().catch((err) => {
  process.stdout.write(`${JSON.stringify({ failed: String(err.stack || err) })}\n`);
  process.exit(1);
});
