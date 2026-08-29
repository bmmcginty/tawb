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
    let windows;
    try {
      windows = await a11y.childrenOf(application);
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

    // Everything one level inside the application and one level inside each
    // of its windows. Chromium puts a dialog in the first place, Firefox in
    // the second.
    const children = [...windows];
    for (const window of windows.slice(0, MAX_CONTAINERS)) {
      try {
        children.push(...(await a11y.childrenOf(window)).slice(0, MAX_CHILDREN));
      } catch {
        // A window that closed while we were asking.
      }
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
        read = await a11y.read(described);
      } catch {
        continue;
      }
      // A window with nothing to say and nothing to press is not a question.
      if (!read.buttons.length && !read.lines.length) continue;

      log('native.dialog', {
        role: described.role,
        name: String(described.name || '').slice(0, 80),
        buttons: read.buttons.map((button) => button.name).join(' / ').slice(0, 80),
      });

      // What a reader is handed: what the dialog says, what it offers, and
      // the two things they can do about it. Built from a fresh reading each
      // time, so that coming back to a question the reader stepped away from
      // asks the browser what it says *now*.
      const requestFor = (state) => ({
        node: described,
        role: described.role,
        title: described.name || state.lines[0] || '',
        lines: state.lines,
        buttons: state.buttons,
        // Options the dialog offers alongside its answer, such as Firefox's
        // "Allow extension to run in private windows".
        toggles: state.toggles || [],
        // What the dialog is about, where that lives in a control rather than
        // in its words: the username and masked password in a "Save
        // password?" prompt.
        fields: state.fields || [],
        defaultButton: defaultButton(state.buttons),
        // Press a button, the way a screen reader's user activates the
        // control they are on.
        //
        // Worth knowing if this is ever called by something other than a
        // person: a press that lands within about half a second of the dialog
        // appearing is discarded by Chromium's own protection against
        // clickjacking, and discarded silently — the call still answers true
        // and nothing happens. A reader taking the time to read the question
        // is never near that window.
        press: (button) => a11y.press(button),
        // Tick or untick an option, and answer with what it is now. The
        // browser owns the state; this reads it back rather than assuming the
        // press did what it looks like it did.
        toggle: async (control) => {
          await a11y.press(control);
          const states = await a11y.statesOf(control).catch(() => null);
          return states ? states.checked : null;
        },
        // The same question, read again. A dialog the reader stepped away
        // from may have changed while they were gone, and replaying what it
        // said a minute ago would be putting words in the browser's mouth.
        reread: async () => requestFor(await a11y.read(described)),
        // Whether the browser is still asking. Membership rather than "does
        // the object still answer": a dismissed dialog goes on answering for
        // a moment after it has gone from the window.
        stillOpen: async () => {
          try {
            const windows = await a11y.childrenOf(application);
            const here = [...windows];
            for (const window of windows.slice(0, MAX_CONTAINERS)) {
              here.push(...await a11y.childrenOf(window).catch(() => []));
            }
            return pathsOf(here).includes(key);
          } catch {
            return false;
          }
        },
      });

      try {
        await onDialog(requestFor(read));
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
  const watch = watchNativeDialogs({ a11y, application, onDialog, log });
  return {
    application,
    stop() {
      watch.stop();
      a11y.close();
    },
  };
}

module.exports = {
  watchNativeDialogs, armNativeDialogs, defaultButton, DIALOG_ROLES, POLL_MS,
};
