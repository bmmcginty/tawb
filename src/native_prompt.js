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

// What counts as a question rather than a window. `alert` is what Chromium's
// own confirmations answer with; `dialog` and `file chooser` are what the
// other things a browser raises answer with.
const DIALOG_ROLES = new Set(['alert', 'dialog', 'file chooser']);

// How often to look. One `GetChildren` on the application, which is a single
// round trip over a unix socket — the reply is compared against the last one
// and nothing else is asked unless it changed.
const POLL_MS = 500;

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
    let children;
    try {
      children = await a11y.childrenOf(application);
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
      try {
        await onDialog({
          node: described,
          role: described.role,
          title: described.name || read.lines[0] || '',
          lines: read.lines,
          buttons: read.buttons,
          defaultButton: defaultButton(read.buttons),
          press: (button) => a11y.press(button),
          // Whether the browser is still asking. A dialog answered elsewhere,
          // or a browser that has gone, is not something to press a button on.
          stillOpen: async () => {
            try {
              const now = await a11y.childrenOf(application);
              return pathsOf(now).includes(key);
            } catch {
              return false;
            }
          },
        });
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

module.exports = { watchNativeDialogs, defaultButton, DIALOG_ROLES, POLL_MS };
