'use strict';

// Somewhere for the browser to describe its own windows to, differenced
// between the JavaScript original and the Crystal port.
//
// A desktop has an accessibility bus already and this code does nothing. A
// terminal with no desktop has neither an accessibility bus nor the session
// bus an accessibility bus would live on, and that is the case worth
// comparing: a private bus is started, the name is claimed, the address handed
// out is a bus that really exists, and the property Chromium checks before it
// turns accessibility on is answered.
//
// dbus-daemon is not a dependency of this program, it is a thing a machine
// either has or has not. Where dbus-daemon is missing, so is the whole
// feature, and every test here skips.

const test = require('node:test');
const assert = require('node:assert');

const a11yBus = require('../src/a11y_bus');
const { a11yBusImplementations } = require('./crystal_impl');

const implementations = a11yBusImplementations(a11yBus);

// A bus the machine can actually start, or nothing to compare.
async function daemonOrSkip(t) {
  try {
    const started = await a11yBus.startSessionBus();
    started.child.kill('SIGTERM');
    return true;
  } catch (error) {
    t.skip(`no session bus available here: ${error.message}`);
    return false;
  }
}

// The services a private bus must not offer to activate. D-Bus's
// StartServiceByName does not return until the service has started or failed,
// so a browser that asks for a portal on a machine with no desktop waits out
// the full activation timeout and its first network request waits with it.
const UNWANTED = [
  'org.freedesktop.portal.Desktop',
  'org.freedesktop.impl.portal.desktop.gtk',
  'ca.desrt.dconf',
  'org.gtk.vfs.Daemon',
  'org.freedesktop.secrets',
];

test('the bus that is started, served, asked and stopped is the same on both sides', async (t) => {
  if (!await daemonOrSkip(t)) return;
  const steps = [
    { type: 'start' },
    { type: 'activatable' },
    { type: 'serve' },
    { type: 'ask_address' },
    { type: 'ask_property', property: 'IsEnabled' },
    { type: 'ask_property', property: 'ScreenReaderEnabled' },
    { type: 'ask_property', property: 'SomethingUnheardOf' },
    { type: 'ask_property', interface: 'org.a11y.NotStatus', property: 'IsEnabled' },
    { type: 'set_property', property: 'ScreenReaderEnabled' },
    { type: 'ask_unknown' },
    { type: 'stop' },
  ];

  const answers = [];
  for (const implementation of implementations) {
    answers.push({ name: implementation.name, outcome: await implementation.busScenario(steps) });
  }

  // Each run starts its own bus, so the addresses differ by design and
  // everything else must not. The address is checked for shape here and then
  // taken out of the comparison.
  const shaped = answers.map(({ name, outcome }) => {
    const results = outcome.results.slice();
    assert.match(results[0].address, /^unix:path=/, `${name} started no unix bus`);
    assert.equal(results[0].socketExists, true, `${name} never opened its socket`);
    assert.equal(results[0].configExists, true, `${name} wrote no configuration`);
    // The whole point of writing a configuration by hand: the machine's own
    // session configuration would make the desktop's services activatable
    // here.
    assert.ok(!/<servicedir/.test(results[0].config), `${name} offered desktop services`);
    assert.match(results[0].config, /<listen>unix:path=/);
    for (const unwanted of UNWANTED) {
      assert.ok(
        !results[1].includes(unwanted),
        `${name} offered to activate ${unwanted} on a private bus`,
      );
    }
    // The address handed out is the bus that was started, which is the whole
    // trick: an accessibility bus is an ordinary bus, and the separate one a
    // desktop runs is for isolation rather than for a different protocol.
    assert.equal(results[3], results[0].address, `${name} handed out a different bus`);
    return {
      name,
      // Claiming the name, the two properties Chromium reads, a property
      // nothing answers for, an interface nothing answers for, a Set that is
      // accepted, an unknown member that is refused, and the files removed.
      compared: [results[2], results[4], results[5], errorShape(results[6]),
        errorShape(results[7]), results[8], errorShape(results[9]), results[10]],
    };
  });

  const first = shaped[0];
  for (const other of shaped.slice(1)) {
    assert.deepEqual(
      other.compared,
      first.compared,
      `${other.name} served the accessibility bus differently from ${first.name}`,
    );
  }
  assert.equal(first.compared[0], 1, 'the accessibility name was not claimed');
  assert.equal(first.compared[1], true, 'IsEnabled was not answered');
  assert.equal(first.compared[2], true, 'ScreenReaderEnabled was not answered');
  assert.equal(first.compared[3], 'UnknownProperty');
  // A property asked for on an interface this service does not answer for is
  // not this service's to refuse by name: the handler declines the message
  // entirely, so the connection answers UnknownMethod, the same as for a
  // member nobody here has.
  assert.equal(first.compared[4], 'UnknownMethod');
  assert.equal(first.compared[6], 'UnknownMethod');
  assert.equal(first.compared[7], true, 'the socket or its configuration was left behind');
});

// A refusal compared as a refusal. The two implementations word an error
// differently where the error is their own, so what is compared is which
// refusal arrived rather than how it was spelled.
function errorShape(result) {
  if (!result || typeof result !== 'object' || !result.error) return result;
  if (/UnknownProperty/.test(result.error)) return 'UnknownProperty';
  if (/UnknownMethod/.test(result.error)) return 'UnknownMethod';
  return 'other';
}

test('an unreachable exported bus is replaced with a private accessibility bus', async (t) => {
  if (!await daemonOrSkip(t)) return;
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/tawb-session-bus-that-does-not-exist' };
  const answers = [];
  for (const implementation of implementations) {
    answers.push({
      name: implementation.name,
      outcome: await implementation.openScenario(env, 'close'),
    });
  }
  for (const { name, outcome } of answers) {
    if (!outcome.available) {
      // Starting a bus can fail for reasons other than a missing dbus-daemon:
      // the daemon can exit at once, or never open its socket. On any of them
      // the machine simply has no bus to read dialogs on, which is a skip and
      // not a failure.
      t.skip(`no accessibility bus available to ${name}: ${outcome.reason}`);
      return;
    }
  }
  for (const { name, outcome } of answers) {
    assert.match(outcome.address, /^unix:path=/, `${name} named no unix bus`);
    // A stale exported address is overridden rather than passed through, which
    // is what otherwise leaves Firefox describing no permission prompts at all.
    assert.equal(outcome.env.DBUS_SESSION_BUS_ADDRESS, outcome.address);
    assert.equal(outcome.env.AT_SPI_BUS_ADDRESS, outcome.address);
    assert.equal(outcome.env.GNOME_ACCESSIBILITY, '1');
    assert.equal(outcome.owned, true);
    assert.equal(outcome.reason, null);
    assert.ok(outcome.pid > 0, `${name} reported no daemon to hand on`);
  }
  // Everything but the address and the pid, which are a new bus each run.
  const shaped = answers.map(({ name, outcome }) => ({
    name,
    compared: {
      available: outcome.available,
      owned: outcome.owned,
      reason: outcome.reason,
      envKeys: Object.keys(outcome.env).sort(),
    },
  }));
  for (const other of shaped.slice(1)) {
    assert.deepEqual(
      other.compared,
      shaped[0].compared,
      `${other.name} opened the accessibility bus differently from ${shaped[0].name}`,
    );
  }
});

test('a private bus can be handed to a browser that outlives its reader', async (t) => {
  if (!await daemonOrSkip(t)) return;
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/tawb-session-bus-that-does-not-exist' };
  for (const implementation of implementations) {
    const outcome = await implementation.openScenario(env, 'leave_running');
    if (!outcome.available) {
      t.skip(`no accessibility bus available to ${implementation.name}: ${outcome.reason}`);
      return;
    }
    try {
      assert.equal(outcome.owned, true, `${implementation.name} did not own the bus it started`);
      assert.ok(outcome.pid > 0, `${implementation.name} reported no daemon to hand on`);
      // The service connection belonged to the reader, but the bus itself is
      // still where a kept browser expects the bus to be and where the next
      // reader can read native windows.
      assert.equal(
        outcome.reachableAfter,
        true,
        `${implementation.name} took the bus down with the reader`,
      );
    } finally {
      try { process.kill(outcome.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
});

test('a run asked to isolate itself starts a private bus instead of using a session bus', async (t) => {
  if (!await daemonOrSkip(t)) return;
  // A reachable session bus a browser would otherwise be handed. Without the
  // request to isolate, the implementation would take the desktop's
  // accessibility bus or serve the name on this one; with it, it starts a bus
  // of its own, where the desktop's services are not activatable and so a
  // portal the browser asks for is never started.
  const offered = await a11yBus.startSessionBus();
  try {
    const env = {
      DBUS_SESSION_BUS_ADDRESS: offered.address,
      TAWB_A11Y_BUS: 'private',
    };
    for (const implementation of implementations) {
      const outcome = await implementation.openScenario(env, 'close');
      if (!outcome.available) {
        t.skip(`no accessibility bus available to ${implementation.name}: ${outcome.reason}`);
        return;
      }
      assert.equal(outcome.owned, true, `${implementation.name} used the offered bus`);
      assert.match(outcome.address, /^unix:path=/, `${implementation.name} named no unix bus`);
      assert.notEqual(
        outcome.address,
        offered.address,
        `${implementation.name} did not start a bus of its own`,
      );
      assert.equal(outcome.env.DBUS_SESSION_BUS_ADDRESS, outcome.address);
    }
  } finally {
    offered.child.kill('SIGTERM');
  }
});

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('an exported session bus address is taken as it stands', async () => {
    assert.equal(
      await implementation.sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/whatever-bus' }),
      'unix:path=/tmp/whatever-bus',
    );
  });

  check('a private bus configuration lists the socket and no services', () => {
    const config = implementation.privateBusConfig('/tmp/tawb-a11y-example.sock');
    assert.match(config, /<listen>unix:path=\/tmp\/tawb-a11y-example\.sock<\/listen>/);
    assert.match(config, /<type>session<\/type>/);
    assert.match(config, /<auth>EXTERNAL<\/auth>/);
    assert.ok(!/<servicedir/.test(config));
  });
}

// The configuration is written by hand, so both implementations must write the
// same one: a difference here is a difference in what the browser's bus will
// activate.
test('the two implementations write the same private bus configuration', () => {
  const written = implementations.map((implementation) => ({
    name: implementation.name,
    config: implementation.privateBusConfig('/tmp/tawb-a11y-example.sock'),
  }));
  for (const other of written.slice(1)) {
    assert.equal(
      other.config,
      written[0].config,
      `${other.name} wrote a different private bus configuration from ${written[0].name}`,
    );
  }
});
