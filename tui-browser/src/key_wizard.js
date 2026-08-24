'use strict';

const { Keymap } = require('./keys');
const { KeyReader } = require('./input');

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

    // The terminal cursor is the selection marker. This must be the final
    // write even when nothing else changed, so a screen reader and braille
    // display follow Up and Down without any row being repainted.
    move(output, 3 + selected - scroll, 1);
  };

  // Leaving asks about saving, because the changes made here are held in
  // memory until the wizard is done with them.
  const leave = async () => {
    status = 'Save keyboard changes? y/n';
    render();
    for (;;) {
      const answer = await reader.next();
      if (answer === 'y' || answer === 'Y') {
        keymap.save();
        saved = true;
        done = true;
        return;
      }
      if (answer === 'n' || answer === 'N') {
        for (const action of keymap.actions) action.bindings = [...original.get(action.id)];
        keymap.rebuild();
        done = true;
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
          const result = keymap.assign(row.action.id, key, { add: capturing === 'add' });
          capturing = null;
          status = `${result.binding} assigned to ${row.action.label}.`
            + (result.displaced ? ` Removed from ${result.displaced.label}.` : '');
        }
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
      const action = keymap.actionFor(key);
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
      // Quitting leaves the wizard rather than the browser, and Escape does
      // too whatever it is bound to: a reader who has just unbound the keys
      // this list is read with still needs a way out of it.
      } else if (action === 'quit' || action === 'close-popup' || key === ESC) {
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
