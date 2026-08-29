'use strict';

// The browser's own windows, read the way a screen reader reads them.
//
// Some of what a browser puts in front of a person is not a page. Chrome's
// "Add extension?" confirmation is a native dialog: it has no document, no
// frame, no target, and nothing in CDP will ever describe it — I checked with
// `Target.getTargets({filter:[{}]})`, every type rather than the default
// subset, and watched `Target.targetCreated` across a whole install. It does
// not appear. The omnibox popup does, as `browser_ui:chrome://omnibox-popup`,
// so this is not a rule about browser UI; that particular dialog is simply
// not WebUI.
//
// It is, however, a dialog the browser already describes to assistive
// technology, because a sighted-but-blind user pressing "Add to Chrome" has
// to be able to answer it too. On Linux that description is AT-SPI, which is
// D-Bus (see dbus.js), and it carries everything the dialog says: its
// heading, the permissions it lists, and its buttons with an action that
// presses them. So the reader gets the dialog's own words on the terminal and
// their answer presses the dialog's own button. The browser does the install.
//
// Two conditions, both real:
//
//   * The browser must have been started with platform accessibility on —
//     `--force-renderer-accessibility`, of which `basic` is enough. Without
//     it AT-SPI shows the application and the window frame and nothing
//     inside them, because `AXPlatformNodeAuraLinux::CreateAtkObject()`
//     refuses to build a node for anything that is not a top-level window
//     unless `AXMode::kNativeAPIs` is set. Nothing else turns it on: not the
//     ACCESSIBILITY_ENABLED environment variable, not org.a11y.Status's
//     ScreenReaderEnabled, not registering as an AT-SPI listener, and not
//     CDP's own Accessibility.enable. See browser.js for where the flag is
//     passed.
//   * There must be an accessibility bus to answer on, which is at-spi2-core
//     running against a session bus. See a11y_bus.js.

const { connect, DbusError } = require('./dbus');
const fs = require('node:fs');

// Every application on the accessibility bus answers for its own tree at this
// path. The at-spi registry keeps a desktop object listing them all, but
// asking the applications directly means one daemon fewer has to be running:
// with at-spi2-registryd not started at all, a browser still registers on the
// bus and still answers here. Verified, because the alternative was starting
// a daemon we do not need.
const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const ACCESSIBLE = 'org.a11y.atspi.Accessible';
const ACTION = 'org.a11y.atspi.Action';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

// A dialog is not deep, and a page behind it can be. Both limits are here to
// keep a walk from turning into a tour of a document: what is being read is a
// confirmation with a heading, a list and two buttons.
const MAX_DEPTH = 12;
const MAX_NODES = 400;

// How long to wait on a connection that may not be an application at all.
const PROBE_TIMEOUT_MS = 1500;

// Roles that name a button a reader can press. AT-SPI spells it "push
// button"; Chromium's own views answer "button" for some of them, so both are
// taken.
const BUTTON_ROLES = new Set(['push button', 'button', 'toggle button']);

// Roles that hold no words of their own and only group what is inside them.
// A dialog is mostly these, and reading them out would bury the two lines
// that matter.
const SILENT_ROLES = new Set(['panel', 'filler', 'section', 'redundant object', 'unknown']);

// Which process a pid belongs to the group of. The browser is not always our
// own child — with no display it is started under xvfb-run and is that
// shell's child — so the process group is what identifies the browser we
// started, and `spawn` was given `detached` precisely so it leads one.
function processGroupOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The second field is the executable name in brackets and may itself
    // contain spaces and brackets, so the fields after it are counted from
    // the last close bracket rather than from the start.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(after[2]) || null; // state, ppid, pgrp
  } catch {
    return null;
  }
}

// One node of an accessibility tree: which connection answers for it, and
// which object on that connection it is.
function nodeOf(bus, path) {
  return { bus, path };
}

class Accessibility {
  constructor(connection, { log = () => {} } = {}) {
    this.connection = connection;
    this.log = log;
  }

  close() {
    this.connection.close();
  }

  #call(node, iface, member, signature, body, timeout) {
    return this.connection.call({
      destination: node.bus, path: node.path, iface, member, signature, body, timeout,
    });
  }

  async childrenOf(node) {
    const [children] = await this.#call(node, ACCESSIBLE, 'GetChildren');
    return children.map(([bus, path]) => nodeOf(bus, path));
  }

  async roleOf(node, timeout) {
    const [role] = await this.#call(node, ACCESSIBLE, 'GetRoleName', '', [], timeout);
    return role;
  }

  async nameOf(node, timeout) {
    const [name] = await this.#call(node, PROPERTIES, 'Get', 'ss', [ACCESSIBLE, 'Name'], timeout);
    return typeof name === 'string' ? name : '';
  }

  // Role and name together, which is what every caller here wants and what
  // costs two round trips rather than one walk of everything.
  async describeNode(node, timeout) {
    const [role, name] = await Promise.all([this.roleOf(node, timeout), this.nameOf(node, timeout)]);
    return { ...node, role, name };
  }

  // Press a control. `DoAction(0)` is its first action, which for a button is
  // the press; the same call is what a screen reader makes when its user
  // activates the control it is on.
  async press(node) {
    const [done] = await this.#call(node, ACTION, 'DoAction', 'i', [0]);
    return done === true;
  }

  // Everything holding a connection to the accessibility bus, minus our own.
  // Most of them are applications; some are other assistive technology, which
  // is why what comes back is candidates rather than answers.
  async connections() {
    const [names] = await this.connection.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'ListNames',
    });
    return names.filter((name) => name.startsWith(':') && name !== this.connection.name);
  }

  // What is at the root of one connection's tree, or null if it does not have
  // one. The short timeout is deliberate: another assistive technology on the
  // bus is not an application and will not answer at all, and waiting the
  // ordinary timeout for each of those would make finding the browser take
  // longer than the dialog stays up.
  async applicationAt(bus, { timeout = PROBE_TIMEOUT_MS } = {}) {
    try {
      const described = await this.describeNode(nodeOf(bus, ROOT_PATH), timeout);
      return described.role === 'application' ? described : null;
    } catch {
      return null;
    }
  }

  // Every application currently on the bus.
  async applications() {
    const buses = await this.connections();
    const found = await Promise.all(buses.map((bus) => this.applicationAt(bus)));
    return found.filter(Boolean);
  }

  // The application belonging to a browser we started.
  //
  // Identity is the process, not the name: a desktop may have several
  // browsers on it and only one of them is the one this session is reading.
  // The bus knows the pid behind every connection, and the browser we started
  // leads a process group of its own, so the two together name it exactly.
  // Asking the bus who owns a name is cheap and local to it, so the pids are
  // gathered first and only the matching connection is asked for a tree.
  //
  // `names` is the fallback for a browser reached with --connect: it was
  // running before this session existed, so there is no pid of ours to match.
  async applicationFor({ pid = null, names = [] } = {}) {
    const buses = await this.connections();
    if (pid) {
      for (const bus of buses) {
        let owner;
        try {
          owner = await this.connection.processIdOf(bus);
        } catch {
          continue;
        }
        if (owner !== pid && processGroupOf(owner) !== pid) continue;
        const application = await this.applicationAt(bus);
        if (application) return application;
      }
    }
    if (names.length) {
      const wanted = names.map((name) => name.toLowerCase());
      for (const bus of buses) {
        const application = await this.applicationAt(bus);
        if (application && wanted.includes(String(application.name || '').toLowerCase())) {
          return application;
        }
      }
    }
    return null;
  }

  // The windows and dialogs an application has open, which are the direct
  // children of the application node. A native dialog is one of these: it is
  // not inside the window it came from, it is beside it.
  async topLevels(application) {
    const children = await this.childrenOf(application);
    const found = [];
    for (const child of children) {
      try {
        found.push(await this.describeNode(child));
      } catch {
        // A window that closed while we were asking about it.
      }
    }
    return found;
  }

  // Everything a dialog says, in the order it says it.
  //
  // What comes back is the lines a reader needs and the controls they can
  // answer with. Empty grouping nodes are dropped, and a node whose name
  // repeats its parent's is dropped too — a views dialog nests a heading
  // inside a panel inside a panel, and each of them answers with the same
  // string.
  async read(node, { maxDepth = MAX_DEPTH, maxNodes = MAX_NODES } = {}) {
    const root = node.role ? node : await this.describeNode(node);
    const lines = [];
    const buttons = [];
    let visited = 0;

    const walk = async (current, depth, seen) => {
      if (visited >= maxNodes) return;
      visited += 1;
      const name = String(current.name || '').trim();
      const isButton = BUTTON_ROLES.has(current.role);
      if (isButton && name) buttons.push({ ...current, name });
      else if (name && !seen.has(name) && !SILENT_ROLES.has(current.role)) lines.push(name);
      const nowSeen = name ? new Set([...seen, name]) : seen;
      if (depth >= maxDepth) return;
      let children;
      try {
        children = await this.childrenOf(current);
      } catch {
        return;
      }
      for (const child of children) {
        let described;
        try {
          described = await this.describeNode(child);
        } catch {
          continue;
        }
        await walk(described, depth + 1, nowSeen);
      }
    };

    await walk(root, 0, new Set());
    return {
      role: root.role, name: root.name, lines, buttons, truncated: visited >= maxNodes,
    };
  }
}

// Opens the accessibility bus. `address` is the bus itself; with none given
// the session bus is asked where it is, which is how every assistive
// technology finds it.
async function openAccessibility({
  address = null, sessionAddress = process.env.DBUS_SESSION_BUS_ADDRESS || null, log = () => {},
} = {}) {
  let busAddress = address;
  if (!busAddress) {
    if (!sessionAddress) throw new DbusError('no session bus, so no accessibility bus to find');
    const session = await connect(sessionAddress);
    try {
      const [found] = await session.call({
        destination: 'org.a11y.Bus',
        path: '/org/a11y/bus',
        iface: 'org.a11y.Bus',
        member: 'GetAddress',
      });
      busAddress = found;
    } finally {
      session.close();
    }
  }
  const connection = await connect(busAddress);
  log('atspi.open', { address: busAddress, name: connection.name });
  return new Accessibility(connection, { log });
}

module.exports = {
  openAccessibility, Accessibility, processGroupOf, nodeOf, BUTTON_ROLES,
};
