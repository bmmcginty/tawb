'use strict';

const { Keymap } = require('./keys');
const { KeyReader, EOF } = require('./input');
const {
  visibleEntries, selectionKey, selectionIndex, moveKey, appendFilter, backspaceFilter,
} = require('./list_model');
const { sectionsFor } = require('./wizard_order');

const ESC = '\x1b';
const BACKSPACE = new Set(['\x7f', '\x08']);
const ALT_A = new Set(['\x1ba', '\x1bA']);
const CLEAR_FILTER = '\x15';

function size(output) {
  return { rows: output.rows || 24, cols: output.columns || 80 };
}

function move(output, row, col = 1) { output.write(`\x1b[${row};${col}H`); }
function line(output, row, text) {
  move(output, row);
  output.write(`\x1b[2K${text.slice(0, size(output).cols)}`);
}

// What this list can be told to do. Any other action — refresh, next tab,
// find — has no meaning against a list of bindings. A printable character
// never reaches this table: it belongs to the filter first.
const WIZARD_ACTIONS = new Set([
  'next-line', 'previous-line', 'next-screen', 'previous-screen',
  'top', 'bottom', 'line-start', 'line-end', 'where', 'activate',
  'quit', 'close-popup',
]);

const MOVE_ACTIONS = {
  'next-line': 'next',
  'previous-line': 'previous',
  'next-screen': 'page-next',
  'previous-screen': 'page-previous',
  top: 'first',
  'line-start': 'first',
  bottom: 'last',
  'line-end': 'last',
};

// What a row says. The bindings are part of the search text as well as the
// visible line, so a reader who remembers a key can find the action holding
// it, and a reader who remembers part of the name does not need the key.
function actionText(action, keymap) {
  const bindings = action.bindings.length
    ? action.bindings.map((binding) => keymap.display(binding)).join(', ')
    : 'no key assigned';
  // In an interface that names its functions the row leads with the function
  // it acts on, so a reader can find their own entry by name.
  const functionName = keymap.functionNames && keymap.functionNames.get(action.id);
  const name = functionName ? `${functionName} — ${action.label}` : action.label;
  return `${name}, ${bindings}`;
}

function actionRow(action, keymap) {
  const text = actionText(action, keymap);
  const functionName = keymap.functionNames && keymap.functionNames.get(action.id);
  return {
    type: 'action',
    action,
    key: `action:${action.id}`,
    text,
    search: [text, action.id, functionName || ''].filter(Boolean).join('\n'),
  };
}

function pinnedRows() {
  return [
    {
      type: 'heading', label: 'Keyboard wizard actions', key: 'cmd:heading',
      text: 'Keyboard wizard actions', search: 'Keyboard wizard actions',
    },
    {
      type: 'reset', label: 'Restore default bindings', key: 'cmd:reset',
      text: 'Restore default bindings', search: 'Restore default bindings',
    },
    {
      type: 'exit', label: 'Exit keyboard wizard', key: 'cmd:exit',
      text: 'Exit keyboard wizard', search: 'Exit keyboard wizard',
    },
  ];
}

// Imported commands with no TAWB equivalent are listed so the screen is a
// complete picture of what the reader's configuration asked for, and headed
// so it is plain that they are an inventory rather than something to bind.
function unsupportedSection(keymap) {
  const unsupported = keymap.unsupported || [];
  if (!unsupported.length) return null;
  const labels = keymap.labels || {};
  return {
    key: 'unsupported',
    title: labels.unsupportedHeading || 'Commands with no TAWB equivalent:',
    rows: unsupported.map((name) => {
      const label = `${labels.unsupportedPrefix || 'Imported command'} ${name}, unsupported`;
      return {
        type: 'unsupported',
        label,
        key: `unsupported:${name}`,
        text: label,
        search: label,
      };
    }),
  };
}

function wizardSections(keymap) {
  const sections = sectionsFor(keymap.actions).map((section) => ({
    key: section.key,
    title: section.title,
    rows: section.rows.map((action) => actionRow(action, keymap)),
  }));
  const unsupported = unsupportedSection(keymap);
  if (unsupported) sections.push(unsupported);
  return sections;
}

function wizardList(keymap, filter = '') {
  return { sections: wizardSections(keymap), pinned: pinnedRows(), filter };
}

// The flat view the tests and the conformance surface read. The screen itself
// uses visibleEntries, which also carries the section each row came from.
function wizardRows(keymap, { filter = '' } = {}) {
  return visibleEntries(wizardList(keymap, filter)).map((entry) => (entry.kind === 'heading'
    ? { type: 'heading', label: entry.title, key: entry.key }
    : entry.row));
}

function rowText(row, keymap) {
  if (row && row.text !== undefined) return row.text;
  if (!row || row.type !== 'action') return row ? row.label : '';
  return actionText(row.action, keymap);
}

function entryText(entry, keymap) {
  if (!entry) return '';
  if (entry.kind === 'heading') return entry.title;
  return rowText(entry.row, keymap);
}

// Once / has opened the filter, every printable character belongs to it.
// Del is a control character the terminal encodes above space and is this
// screen's Backspace, so it is excluded explicitly.
function isFilterCharacter(chunk) {
  return chunk >= ' ' && chunk !== '\x7f' && !chunk.startsWith(ESC);
}

function filterStatus(keymap, filter) {
  const sections = wizardSections(keymap);
  const total = sections.reduce((count, section) => count + section.rows.length, 0);
  const shown = visibleEntries({ sections, pinned: [], filter })
    .filter((entry) => entry.kind === 'row').length;
  if (!filter) return `${total} rows.`;
  return shown
    ? `${shown} of ${total} rows matching "${filter}".`
    : `Nothing matching "${filter}".`;
}

async function runKeyWizard({
  input = process.stdin, output = process.stdout, keymap = new Keymap(), KeyReaderClass = KeyReader,
  reader: suppliedReader = null, altScreen = true,
} = {}) {
  const ownsReader = !suppliedReader;
  const wasRaw = !!input.isRaw;
  if (ownsReader && input.isTTY) input.setRawMode(true);
  const reader = suppliedReader || new KeyReaderClass(input);
  const original = new Map(keymap.actions.map((action) => [action.id, [...action.bindings]]));
  let selectedKey = null;
  let filter = '';
  let filtering = false;
  let scroll = 0;
  let status = 'Enter replaces a binding; Alt+A adds one. Press / to filter.';
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
    if (altScreen) output.write('\x1b[?1049l');
  };
  // A binding has changed. The row the reader was on is the one they should
  // still be on, and a filter that hid part of the screen is no longer the
  // question they are asking.
  const refocus = (key) => {
    filter = '';
    selectedKey = key;
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  // Run before the reader's shutdown handler, which may exit synchronously
  // when the standalone wizard has no browser to close.
  for (const signal of signals) process.prependListener(signal, leaveScreen);
  // The alternate screen is taken only when this wizard owns the screen. Left
  // standalone it saves the shell exactly as it was; opened from the browser
  // it draws on whichever screen that session is already using, so there is
  // nothing to save or restore around it.
  if (altScreen) output.write('\x1b[?1049h');
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
    const entries = visibleEntries(wizardList(keymap, filter));
    selectedKey = selectionKey(entries, selectedKey);
    const selected = selectionIndex(entries, selectedKey);
    const height = Math.max(1, size(output).rows - 4);
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + height) scroll = selected - height + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, entries.length - height)));

    if (clear) {
      output.write('\x1b[2J');
      drawn.heading = null;
      drawn.hint = null;
      drawn.status = null;
      drawn.list = [];
    }

    const heading = (keymap.labels && keymap.labels.keyboardTitle) || 'Keyboard shortcuts';
    if (drawn.heading !== heading) {
      line(output, 1, heading);
      drawn.heading = heading;
    }

    const selectedEntry = selected >= 0 ? entries[selected] : null;
    const selectedRow = selectedEntry && selectedEntry.row;
    const selectedLabel = selectedRow
      ? (selectedRow.action ? selectedRow.action.label : selectedRow.label)
      : '';
    const hint = capturing
      ? `${capturing === 'add' ? 'Adding to' : 'Replacing'} ${selectedLabel}: press one key; Esc cancels.`
      : filtering
        ? `Filter: ${filter}  Enter/Esc: browse results  Ctrl+U: clear`
        : filter
          ? `Filter: ${filter}  /: edit  ${keyLabel('previous-line', 'Up')}/${keyLabel('next-line', 'Down')}: move`
            + `  ${keyLabel('quit', 'Escape')}: exit`
          : `${keyLabel('previous-line', 'Up')}/${keyLabel('next-line', 'Down')}: move`
            + `  ${keyLabel('activate', 'Enter')}: replace  Alt+A: add`
            + `  /: filter  ${keyLabel('quit', 'Escape')}: exit`;
    if (drawn.hint !== hint) {
      line(output, 2, hint);
      drawn.hint = hint;
    }

    for (let i = 0; i < height; i += 1) {
      const index = scroll + i;
      const text = index < entries.length ? entryText(entries[index], keymap) : '';
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
    // the selected row. While the filter or a question is consuming input, it
    // moves to that prompt instead, so a screen reader does not keep reporting
    // a list item whose binding is not receiving the key. This must be the
    // final write.
    if (filtering) {
      move(output, 2, Math.min(`Filter: ${filter}`.length + 1, size(output).cols));
    } else if (capturing || pending || saving) {
      move(output, size(output).rows, Math.min(status.length + 1, size(output).cols));
    } else {
      move(output, 3 + Math.max(selected, 0) - scroll, 1);
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
      const list = wizardList(keymap, filter);
      const entries = visibleEntries(list);
      selectedKey = selectionKey(entries, selectedKey);
      const selected = selectionIndex(entries, selectedKey);
      const entry = selected >= 0 ? entries[selected] : null;
      const row = entry ? entry.row : null;

      if (capturing) {
        if (key === ESC) {
          capturing = null;
          status = 'Binding unchanged.';
        } else if (capturing === 'replace' && BACKSPACE.has(key)) {
          keymap.unbind(row.action.id);
          capturing = null;
          refocus(row.key);
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
            refocus(row.key);
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
          refocus(`action:${pending.id}`);
        } else if (key === 'n' || key === 'N' || key === ESC) {
          status = 'Binding unchanged.';
        } else {
          continue;
        }
        pending = null;
        render();
        continue;
      }

      // Filtering is an explicit input mode so printable movement bindings —
      // especially j and k — remain usable while browsing the list. Enter or
      // Escape returns to navigation without discarding the narrowed results.
      if (filtering) {
        if (key === ESC || keymap.isKey(key, 'Enter')) {
          filtering = false;
        } else if (key === CLEAR_FILTER) {
          filter = '';
        } else if (BACKSPACE.has(key)) {
          filter = backspaceFilter(filter);
        } else if (isFilterCharacter(key)) {
          filter = appendFilter(filter, key);
        } else {
          continue;
        }
        selectedKey = selectionKey(visibleEntries(wizardList(keymap, filter)), selectedKey);
        status = filterStatus(keymap, filter);
        render();
        continue;
      }

      // Adding a binding is the wizard's own control rather than a browsing
      // command, so it is read before the keymap gets a look at the key.
      if (ALT_A.has(key)) {
        if (row && row.type === 'action') {
          capturing = 'add';
          status = `Press the key to add to ${row.action.label}.`;
        } else {
          status = 'Move to an action row to add a binding.';
        }
        render();
        continue;
      }

      // Everything else goes through the same bindings the page view uses, so
      // whatever moves the reader down a line, to the top, or out of the
      // browser does the same thing to this list.
      const action = wizardAction(key);
      if (key === '/' || action === 'find-forward') {
        filtering = true;
        status = filterStatus(keymap, filter);
        render();
        continue;
      }
      const screen = Math.max(1, size(output).rows - 4);
      const movement = MOVE_ACTIONS[action];

      if (movement) {
        selectedKey = moveKey(entries, selectedKey, movement, screen);
      } else if (action === 'where') {
        status = `Item ${selected + 1} of ${entries.length} — ${entryText(entry, keymap)}.`;
      } else if (action === 'activate') {
        if (entry && entry.kind === 'heading') {
          status = entry.title;
        } else if (row && row.type === 'heading') {
          status = row.label;
        } else if (row && row.type === 'action') {
          capturing = 'replace';
          status = `Press the replacement for ${row.action.label}; Backspace unbinds it.`;
        } else if (row && row.type === 'reset') {
          keymap.reset();
          status = 'Default bindings restored. They are not saved yet.';
        } else if (row && row.type === 'unsupported') {
          status = `${row.label}.`;
        } else if (row && row.type === 'exit') {
          await leave();
        } else {
          status = 'Nothing here to activate.';
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
