'use strict';

const { Keymap } = require('./keys');
const { KeyReader } = require('./input');

const ESC = '\x1b';
const ENTER = new Set(['\r', '\n']);
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
} = {}) {
  const wasRaw = !!input.isRaw;
  if (input.isTTY) input.setRawMode(true);
  const reader = new KeyReaderClass(input);
  let selected = 0;
  let scroll = 0;
  let status = 'Enter replaces a binding; Alt+A adds one.';
  let capturing = null;
  let done = false;

  const render = () => {
    const rows = wizardRows(keymap);
    const height = Math.max(1, size(output).rows - 4);
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + height) scroll = selected - height + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - height)));

    output.write('\x1b[2J');
    line(output, 1, 'Keyboard bindings');
    line(output, 2, capturing
      ? `${capturing === 'add' ? 'Adding to' : 'Replacing'} ${rows[selected].action.label}: press one key; Esc cancels.`
      : 'Up/Down: move  Enter: replace  Alt+A: add');
    for (let i = 0; i < height; i += 1) {
      const index = scroll + i;
      line(output, 3 + i, index < rows.length ? rowText(rows[index], keymap) : '');
    }
    line(output, size(output).rows, status);
    move(output, 3 + selected - scroll, 1);
  };

  const onResize = () => render();
  output.on('resize', onResize);
  render();

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

      if (keymap.isKey(key, 'ArrowDown') || key === 'j') {
        selected = Math.min(selected + 1, rows.length - 1);
      } else if (keymap.isKey(key, 'ArrowUp') || key === 'k') {
        selected = Math.max(selected - 1, 0);
      } else if (keymap.isKey(key, 'PageDown')) {
        selected = Math.min(selected + Math.max(1, size(output).rows - 4), rows.length - 1);
      } else if (keymap.isKey(key, 'PageUp')) {
        selected = Math.max(selected - Math.max(1, size(output).rows - 4), 0);
      } else if (ALT_A.has(key) && row.type === 'action') {
        capturing = 'add';
        status = `Press the key to add to ${row.action.label}.`;
      } else if (ENTER.has(key)) {
        if (row.type === 'action') {
          capturing = 'replace';
          status = `Press the replacement for ${row.action.label}; Backspace unbinds it.`;
        } else if (row.type === 'reset') {
          keymap.reset();
          status = 'Default bindings restored. They are not saved yet.';
        } else {
          status = 'Save keyboard changes? y/n';
          render();
          for (;;) {
            const answer = await reader.next();
            if (answer === 'y' || answer === 'Y') {
              keymap.save();
              done = true;
              break;
            }
            if (answer === 'n' || answer === 'N') {
              done = true;
              break;
            }
          }
        }
      }
      if (!done) render();
    }
  } finally {
    output.off('resize', onResize);
    reader.close();
    output.write('\x1b[r');
    move(output, size(output).rows, 1);
    output.write('\x1b[2K\n');
    if (input.isTTY && !wasRaw) input.setRawMode(false);
  }
}

module.exports = { runKeyWizard, wizardRows, rowText };
