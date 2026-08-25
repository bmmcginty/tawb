'use strict';

const { Keymap } = require('./keys');
const { KeyReader, EOF } = require('./input');

const ESC = '\x1b';
const BACKSPACE = new Set(['\x7f', '\x08']);
const ALT_A = new Set(['\x1ba', '\x1bA']);

function size(output) {
  return { rows: output.rows || 24, cols: output.columns || 80 };
}

function move(output, row, col = 1) { output.write(`\x1b[${row};${col}H`); }
function line(output, row, text) {
  move(output, row);
  output.write(`\x1b[2K${text.slice(0, size(output).cols)}`);
}

// What this list can be told to do. Any other action — refresh, next tab,
// find — has no meaning against a list of bindings.
const WIZARD_ACTIONS = new Set([
  'next-line', 'previous-line', 'next-screen', 'previous-screen',
  'top', 'bottom', 'line-start', 'line-end', 'where', 'activate',
  'quit', 'close-popup',
]);

function wizardRows(keymap) {
  return [
    ...keymap.actions.map((action) => ({ type: 'action', action })),
    { type: 'reset', label: 'Restore default bindings' },
    { type: 'exit', label: 'Exit keyboard wizard' },
  ];
}

function rowText(row, keymap) {
  if (row.type !== 'action') return row.label;
  const bindings = row.action.bindings.length
    ? row.action.bindings.map((binding) => keymap.display(binding)).join(', ')
    : '(unbound)';
  return `${row.action.label}, ${bindings}`;
}

async function runKeyWizard({
  input = process.stdin, output = process.stdout, keymap = new Keymap(), KeyReaderClass = KeyReader,
  reader: suppliedReader = null,
} = {}) {
  const ownsReader = !suppliedReader;
  const wasRaw = !!input.isRaw;
  if (ownsReader && input.isTTY) input.setRawMode(true);
  const reader = suppliedReader || new KeyReaderClass(input);
  const original = new Map(keymap.actions.map((action) => [action.id, [...action.bindings]]));
  let selected = 0;
  let scroll = 0;
  let status = 'Enter replaces a binding; Alt+A adds one.';
  let capturing = null;
  let pending = null;
  let saving = false;
  let done = false;
  let saved = false;
  let leftScreen = false;
  const drawn = { heading: null, hint: null, status: null, list: [] };
  const leaveScreen = () => {
    if (leftScreen) return;
    leftScreen = true;
    output.write('\x1b[?1049l');
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // Run before the reader's shutdown handler, which may exit synchronously
  // when the standalone wizard has no browser to close.
  for (const signal of signals) process.prependListener(signal, leaveScreen);
  // Keep the page underneath exactly as it was. Clearing the ordinary screen
  // left a standalone wizard at an empty terminal and erased the browser UI
  // when the wizard was opened from it.
  output.write('\x1b[?1049h');
  output.write('\x1b[r');

  // The wizard is driven by the same bindings as the rest of the browser, so
  // its hint has to name whatever those bindings currently are — including a
  // change the reader has just made a few rows further up this very list.
  const keyLabel = (id, fallback) => {
    const action = keymap.byId.get(id);
    const binding = action && action.bindings[0];
    return binding ? keymap.display(binding) : fallback;
  };

  const render = ({ clear = false } = {}) => {
    const rows = wizardRows(keymap);
    const height = Math.max(1, size(output).rows - 4);
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + height) scroll = selected - height + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)));

    if (clear) {
      output.write('\x1b[2J');
      drawn.heading = null;
      drawn.hint = null;
      drawn.status = null;
      drawn.list = [];
    }

    const heading = 'Keyboard bindings';
    if (drawn.heading !== heading) {
      line(output, 1, heading);
      drawn.heading = heading;
    }

    const hint = capturing
      ? `${capturing === 'add' ? 'Adding to' : 'Replacing'} ${rows[selected].action.label}: press one key; Esc cancels.`
      : `${keyLabel('previous-line', 'Up')}/${keyLabel('next-line', 'Down')}: move`
        + `  ${keyLabel('activate', 'Enter')}: replace  Alt+A: add`
        + `  ${keyLabel('quit', 'Escape')}: exit`;
    if (drawn.hint !== hint) {
      line(output, 2, hint);
      drawn.hint = hint;
    }

    for (let i = 0; i < height; i += 1) {
      const index = scroll + i;
      const text = index < rows.length ? rowText(rows[index], keymap) : '';
      if (drawn.list[i] === text) continue;
      line(output, 3 + i, text);
      drawn.list[i] = text;
    }
    // A resize can shorten the list area. Forget rows which no longer have a
    // physical list row, so growing it again does not mistake stale text for
    // something still on screen.
    drawn.list.length = height;

    if (drawn.status !== status) {
      line(output, size(output).rows, status);
      drawn.status = status;
    }

    // The cursor marks the place the next key will affect. Ordinarily that is
    // the selected row. While a question is waiting for one key or a y/n
    // answer, it is the answer position at the end of that prompt instead —
    // otherwise a screen reader keeps reporting the list item while input is
    // being consumed somewhere else entirely. This must be the final write.
    if (capturing || pending || saving) {
      move(output, size(output).rows, Math.min(status.length + 1, size(output).cols));
    } else {
      move(output, 3 + selected - scroll, 1);
    }
  };

  // The wizard is the one screen where the bindings themselves are half
  // edited, so it must stay usable while they are. A key whose action means
  // nothing to this list falls back to what the key itself does here: the
  // arrows always move, Enter always activates and Escape always leaves,
  // however they happen to be bound. Nothing is taken away by this — a key
  // being captured for a binding is read raw, so the arrows and Enter can
  // still be assigned to anything.
  const wizardAction = (key) => {
    const action = keymap.actionFor(key);
    if (WIZARD_ACTIONS.has(action)) return action;
    if (keymap.isKey(key, 'ArrowDown')) return 'next-line';
    if (keymap.isKey(key, 'ArrowUp')) return 'previous-line';
    if (keymap.isKey(key, 'Enter')) return 'activate';
    if (key === ESC) return 'quit';
    return action;
  };

  // Leaving without saving: the wizard's changes live in memory until it is
  // done with them, so putting the originals back is all there is to it.
  const restore = () => {
    for (const action of keymap.actions) action.bindings = [...original.get(action.id)];
    keymap.rebuild();
    done = true;
  };

  // Leaving asks about saving, because the changes made here are held in
  // memory until the wizard is done with them.
  const leave = async () => {
    saving = true;
    status = 'Save keyboard changes? y/n';
    render();
    for (;;) {
      const answer = await reader.next();
      // A question asked of a keyboard that is no longer there is not
      // answered "yes". Bindings are held in memory until this point, so
      // putting the originals back is what leaving without saving means —
      // and without this the loop would spin on an answer that never comes.
      if (answer === EOF) { restore(); return; }
      if (answer === 'y' || answer === 'Y') {
        keymap.save();
        saved = true;
        done = true;
        return;
      }
      if (answer === 'n' || answer === 'N') {
        restore();
        return;
      }
    }
  };

  const onResize = () => render({ clear: true });
  output.on('resize', onResize);
  render({ clear: true });

  try {
    while (!done) {
      const key = await reader.next();
      // The keyboard has gone. Nothing typed here has been written yet, so
      // the wizard leaves the keymap as it found it.
      if (key === EOF) { restore(); break; }
      const rows = wizardRows(keymap);
      const row = rows[selected];

      if (capturing) {
        if (key === ESC) {
          capturing = null;
          status = 'Binding unchanged.';
        } else if (capturing === 'replace' && BACKSPACE.has(key)) {
          keymap.unbind(row.action.id);
          capturing = null;
          status = `${row.action.label} is unbound.`;
        } else {
          const add = capturing === 'add';
          const binding = keymap.nameForSequence(key);
          const clashes = keymap.conflicts(row.action.id, binding);
          capturing = null;
          if (clashes.length) {
            // Taking a key from something else is the one edit here the
            // reader cannot see coming, so it is named and asked about
            // rather than reported once it has already happened.
            pending = { id: row.action.id, label: row.action.label, key, add };
            status = `${keymap.display(binding)} is assigned to `
              + `${clashes.map((action) => action.label).join(' and ')}; `
              + `rebind to ${row.action.label}? y/n`;
          } else {
            status = `${keymap.assign(row.action.id, key, { add }).binding} `
              + `assigned to ${row.action.label}.`;
          }
        }
        render();
        continue;
      }

      if (pending) {
        if (key === 'y' || key === 'Y') {
          const result = keymap.assign(pending.id, pending.key, { add: pending.add });
          status = `${result.binding} assigned to ${pending.label}.`
            + (result.displaced ? ` Removed from ${result.displaced.label}.` : '');
        } else if (key === 'n' || key === 'N' || key === ESC) {
          status = 'Binding unchanged.';
        } else {
          continue;
        }
        pending = null;
        render();
        continue;
      }

      // Adding a binding is the wizard's own control rather than a browsing
      // command, so it is read before the keymap gets a look at the key.
      if (ALT_A.has(key) && row.type === 'action') {
        capturing = 'add';
        status = `Press the key to add to ${row.action.label}.`;
        render();
        continue;
      }

      // Everything else goes through the same bindings the page view uses, so
      // whatever moves the reader down a line, to the top, or out of the
      // browser does the same thing to this list.
      const action = wizardAction(key);
      const screen = Math.max(1, size(output).rows - 4);

      if (action === 'next-line') {
        selected = Math.min(selected + 1, rows.length - 1);
      } else if (action === 'previous-line') {
        selected = Math.max(selected - 1, 0);
      } else if (action === 'next-screen') {
        selected = Math.min(selected + screen, rows.length - 1);
      } else if (action === 'previous-screen') {
        selected = Math.max(selected - screen, 0);
      } else if (action === 'top' || action === 'line-start') {
        // A list row is a single item with nowhere to go across it, so the
        // start and end keys move within the list like the top and bottom
        // keys rather than doing nothing at all.
        selected = 0;
      } else if (action === 'bottom' || action === 'line-end') {
        selected = rows.length - 1;
      } else if (action === 'where') {
        status = `Item ${selected + 1} of ${rows.length} — ${rowText(row, keymap)}.`;
      } else if (action === 'activate') {
        if (row.type === 'action') {
          capturing = 'replace';
          status = `Press the replacement for ${row.action.label}; Backspace unbinds it.`;
        } else if (row.type === 'reset') {
          keymap.reset();
          status = 'Default bindings restored. They are not saved yet.';
        } else {
          await leave();
        }
      // Quitting leaves the wizard rather than the browser, and closing a
      // popup is what Escape means everywhere else in the browser.
      } else if (action === 'quit' || action === 'close-popup') {
        await leave();
      }
      if (!done) render();
    }
  } finally {
    output.off('resize', onResize);
    for (const signal of signals) process.off(signal, leaveScreen);
    if (ownsReader) reader.close();
    leaveScreen();
    if (ownsReader && input.isTTY && !wasRaw) input.setRawMode(false);
  }
  return saved;
}

module.exports = { runKeyWizard, wizardRows, rowText };
