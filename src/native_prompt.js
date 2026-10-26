'use strict';

// A dialog the browser drew itself, brought to the terminal.
//
// This is the same move the 401 password prompt makes, for the same reason.
// The browser asks a question in a window of its own — outside the document,
// so outside everything a reader of a page can see — and rather than route
// around the question, we take it over: the dialog's own words go on the
// terminal, the reader answers there, and the answer presses the dialog's own
// button. The browser does whatever it was going to do.
//
// The first thing this is for is adding an extension. The reader goes to the
// Chrome Web Store, presses "Add to Chrome" like anybody else, and Chrome
// raises its consent dialog listing what the extension will be able to do.
// That dialog is not in CDP and never will be (see atspi.js). It is in the
// accessibility tree, entire — heading, permissions, both buttons — so that
// is where it is read from and where it is answered.
//
// Nothing here knows what an extension is. What it knows is that the browser
// has put a question on the screen, and that a reader who cannot see it is
// owed the question and the choice. A file picker or a permission prompt
// arriving the same way would be handled the same way.

const { openAccessibility } = require('./atspi');

// What counts as a question rather than a window. `alert` is what Chromium's
// own confirmations answer with; `dialog` and `file chooser` are what the
// other things a browser raises answer with.
const DIALOG_ROLES = new Set(['alert', 'dialog', 'file chooser']);

// How often to look. A `GetChildren` on the application and one on each window
// it has open, which is a handful of round trips on a unix socket — each reply
// is compared against the last one and nothing else is asked unless something
// new appeared.
const POLL_MS = 500;

// A chooser delegated to an XDG portal belongs to the portal application,
// not to the browser. It is watched only around a browser-owned action that
// can raise one: long enough for a desktop portal to start, but not as a
// permanent claim on every file chooser in the user's session.
const EXTERNAL_CHOOSER_TIMEOUT_MS = 10000;

// Where the two engines put a dialog, which is not the same place.
//
// Chromium's install confirmation is a child of the application, beside the
// window rather than inside it. Firefox's doorhanger is a child of the window
// itself. So both the application and its windows are watched, and a dialog is
// whatever turns up in either — which is one level of looking, not a search of
// a tree with a whole browser's chrome in it.
const MAX_CONTAINERS = 8;
const MAX_CHILDREN = 80;

// How many times in a row the application can fail to answer before this
// gives up on it. A browser that has quit is the ordinary reason.
const MAX_FAILURES = 5;

function pathsOf(nodes) {
  return nodes.map((node) => `${node.bus}|${node.path}`);
}

// Which button the dialog would press if it were answered without being read.
// Chrome focuses Cancel on its install prompt and marks it the default, which
// is worth knowing: it means "the browser's own safe answer" is a thing we can
// press rather than guess at, and that pressing Enter blind would decline
// rather than install.
function defaultButton(buttons) {
  return buttons.find((button) => button.isDefault)
    || buttons.find((button) => button.focused)
    || null;
}

async function containersOf(a11y, application) {
  const windows = await a11y.childrenOf(application);
  const children = [...windows];
  for (const window of windows.slice(0, MAX_CONTAINERS)) {
    try {
      children.push(...(await a11y.childrenOf(window)).slice(0, MAX_CHILDREN));
    } catch {
      // A window that closed while we were asking.
    }
  }
  return children;
}

function readDialog(a11y, described) {
  return a11y.read(described, described.role === 'file chooser' ? { maxNodes: 1200 } : {});
}

function requestFor(a11y, application, described, state) {
  const key = `${described.bus}|${described.path}`;
  return {
    node: described,
    role: described.role,
    title: described.name || state.lines[0] || '',
    lines: state.lines,
    buttons: state.buttons,
    toggles: state.toggles || [],
    fields: state.fields || [],
    actions: state.actions || [],
    defaultButton: defaultButton(state.buttons),
    press: (button) => a11y.press(button),
    activate: (action) => a11y.doAction(action, action.actionIndex || 0),
    enterField: async (field, text) => {
      if (!(await a11y.setText(field, text))) return false;
      return a11y.doAction(field, 0);
    },
    toggle: async (control) => {
      await a11y.press(control);
      const states = await a11y.statesOf(control).catch(() => null);
      return states ? states.checked : null;
    },
    reread: async () => requestFor(
      a11y, application, described, await readDialog(a11y, described),
    ),
    stillOpen: async () => {
      try {
        return pathsOf(await containersOf(a11y, application)).includes(key);
      } catch {
        return false;
      }
    },
  };
}

// Watch one application for dialogs it raises.
//
// `onDialog` is given what the dialog says and the buttons it offers, and is
// awaited: while a reader is answering one question the watch does not go
// looking for another, because two prompts fighting over one terminal is not
// something anybody can answer.
function watchNativeDialogs({
  a11y, application, onDialog, interval = POLL_MS, log = () => {},
}) {
  let stopped = false;
  let failures = 0;
  // Everything already accounted for. A dialog is offered once: a reader who
  // leaves one unanswered has decided to leave it, and being asked again
  // every half second is not an improvement.
  let known = new Set();
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    let children;
    try {
      children = await containersOf(a11y, application);
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures >= MAX_FAILURES) {
        log('native.watch.lost', { error: String(err.message || err).slice(0, 120) });
        stopped = true;
        return;
      }
      schedule();
      return;
    }

    const present = new Set(pathsOf(children));
    // A dialog that has been answered — by the reader here, or in the browser
    // itself — is forgotten, so that the next one of its kind is new again.
    known = new Set([...known].filter((key) => present.has(key)));

    for (const node of children) {
      if (stopped) return;
      const key = `${node.bus}|${node.path}`;
      if (known.has(key)) continue;
      known.add(key);
      let described;
      try {
        described = await a11y.describeNode(node);
      } catch {
        continue;
      }
      if (!DIALOG_ROLES.has(described.role)) continue;

      let read;
      try {
        read = await readDialog(a11y, described);
      } catch {
        continue;
      }
      // A window with nothing to say, nothing to press and nothing to type
      // into is not a question.
      if (!read.buttons.length && !read.lines.length
        && !read.fields.length && !read.actions.length) continue;

      log('native.dialog', {
        role: described.role,
        name: String(described.name || '').slice(0, 80),
        buttons: read.buttons.map((button) => button.name).join(' / ').slice(0, 80),
      });

      try {
        await onDialog(requestFor(a11y, application, described, read));
      } catch (err) {
        log('native.dialog.error', { error: String(err.message || err).slice(0, 160) });
      }
    }
    schedule();
  };

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => { tick().catch(() => {}); }, interval);
    if (timer.unref) timer.unref();
  }

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// A one-shot watch for a chooser raised by a browser action but drawn by a
// different application. GTK delegates to an XDG portal on many desktops;
// the resulting accessibility tree belongs to that portal, so a watch rooted
// at Firefox can never see it.
//
// This is deliberately prepared before the action. The first inventory is a
// baseline of choosers that were already open, and the browser is not pressed
// until it is complete. After that, only a newly appearing chooser is offered.
// Thus an unrelated chooser that was already on the desktop cannot be taken
// over, and TAWB is not permanently watching other applications.
async function watchExternalFileChooser({
  a11y, browserApplication, onDialog, interval = POLL_MS,
  timeout = EXTERNAL_CHOOSER_TIMEOUT_MS, log = () => {},
}) {
  let stopped = false;
  let timer = null;
  const browserBus = browserApplication.bus;

  const scan = async () => {
    const found = [];
    const applications = await a11y.applications();
    for (const application of applications) {
      if (application.bus === browserBus) continue;
      let nodes;
      try {
        nodes = await containersOf(a11y, application);
      } catch {
        continue;
      }
      for (const node of nodes) {
        try {
          const described = await a11y.describeNode(node);
          if (described.role === 'file chooser') found.push({ application, described });
        } catch {
          // An object that disappeared while the desktop was being inventoried.
        }
      }
    }
    return found;
  };

  const known = new Set((await scan()).map(({ described }) => (
    `${described.bus}|${described.path}`
  )));
  const deadline = Date.now() + timeout;

  const tick = async () => {
    if (stopped) return;
    let found = [];
    try { found = await scan(); } catch { /* try again until the deadline */ }
    for (const { application, described } of found) {
      const key = `${described.bus}|${described.path}`;
      if (known.has(key)) continue;
      known.add(key);
      let read;
      try { read = await readDialog(a11y, described); } catch { continue; }
      // A window with nothing to say, nothing to press and nothing to type
      // into is not a question.
      if (!read.buttons.length && !read.lines.length
        && !read.fields.length && !read.actions.length) continue;
      stopped = true;
      log('native.external-dialog', {
        application: String(application.name || '').slice(0, 80),
        name: String(described.name || '').slice(0, 80),
      });
      await onDialog(requestFor(a11y, application, described, read));
      return;
    }
    if (Date.now() >= deadline) {
      stopped = true;
      log('native.external-expired', {});
      return;
    }
    timer = setTimeout(() => { tick().catch(() => {}); }, interval);
    if (timer.unref) timer.unref();
  };

  timer = setTimeout(() => { tick().catch(() => {}); }, interval);
  if (timer.unref) timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

// Everything a driver has to do to have its browser's dialogs answered here.
//
// Both engines want the same three things — the accessibility bus this
// browser is on, which application on it is ours, and a watch — and both can
// fail to have any of them for ordinary reasons: a browser somebody else
// started, a machine with no D-Bus, an engine that was not asked to describe
// its windows. None of those is an error. They mean this browser has no
// native dialogs to offer, and a reader who never meets one never notices.
async function armNativeDialogs({
  bus, pid = null, names = [], onDialog, log = () => {},
}) {
  if (!bus || !bus.available) {
    log('native.unavailable', { reason: (bus && bus.reason) || 'no accessibility bus' });
    return null;
  }
  let a11y;
  try {
    a11y = await openAccessibility({ address: bus.address, log });
  } catch (err) {
    log('native.unavailable', { reason: String(err.message || err).slice(0, 160) });
    return null;
  }
  const application = await a11y.applicationFor({ pid, names }).catch(() => null);
  if (!application) {
    log('native.unavailable', { reason: 'the browser is not describing its windows' });
    a11y.close();
    return null;
  }
  log('native.armed', { application: application.name, bus: application.bus });
  // Both watches feed one terminal. Serialize their offers so a portal
  // chooser cannot race a browser-owned permission prompt onto it.
  let offers = Promise.resolve();
  const offer = (request) => {
    offers = offers.catch(() => {}).then(() => onDialog(request));
    return offers;
  };
  const watch = watchNativeDialogs({ a11y, application, onDialog: offer, log });
  let externalWatch = null;
  let stopped = false;
  return {
    application,
    async expectExternalFileChooser() {
      if (stopped) return false;
      if (externalWatch) externalWatch.stop();
      externalWatch = await watchExternalFileChooser({
        a11y, browserApplication: application, onDialog: offer, log,
      }).catch((err) => {
        log('native.external-unavailable', { error: String(err.message || err).slice(0, 160) });
        return null;
      });
      return !!externalWatch;
    },
    stop() {
      stopped = true;
      watch.stop();
      if (externalWatch) externalWatch.stop();
      a11y.close();
    },
  };
}

module.exports = {
  watchNativeDialogs, watchExternalFileChooser, armNativeDialogs,
  defaultButton, DIALOG_ROLES, POLL_MS, EXTERNAL_CHOOSER_TIMEOUT_MS,
};
