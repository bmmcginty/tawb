'use strict';

const {
  TYPEAHEAD, createListState, entriesOf, select, move, cursorLocation, listMovement,
} = require('./list_screen');

function copy(value) { return JSON.parse(JSON.stringify(value)); }

function normalizeRow(row) {
  const kind = ['text', 'choice', 'boolean', 'readonly', 'action'].includes(row.kind)
    ? row.kind : 'text';
  return {
    id: String(row.id || row.label || ''),
    label: String(row.label || row.id || ''),
    value: row.value == null ? '' : row.value,
    kind,
    choices: kind === 'choice' ? (row.choices || []).map(String) : null,
    command: kind === 'action' ? String(row.command || row.id || 'apply') : null,
    note: row.note ? String(row.note) : '',
  };
}

function display(row) {
  if (row.kind === 'action') return `[${row.label}]`;
  const value = row.value === '' || row.value == null ? '(none)' : String(row.value);
  if (row.kind === 'readonly') return `${row.label}: ${value} (source)`;
  if (row.kind === 'boolean') return `${row.label}: ${row.value ? 'yes' : 'no'}`;
  return `${row.label}: ${value}`;
}

// A property sheet is a list screen whose rows name a property and show its
// current value. It shares the list state, movement and cursor contract with
// the library and every list; a choice row opens the same kind of nested list.
class PropertySheet {
  constructor({ title = 'Properties', rows = [], actionLabel = null } = {}) {
    this.title = String(title);
    this.rows = rows.map(normalizeRow);
    if (actionLabel) {
      this.rows.push(normalizeRow({ id: 'apply', label: actionLabel, kind: 'action', command: 'apply' }));
    }
    this.status = '';
    this.choosing = null;
    this.list = this.#listForRows();
    select(this.list);
  }

  #listForRows() {
    return createListState({
      rows: this.rows.map((row) => ({
        key: row.id, text: display(row), search: `${row.label} ${row.value}`,
      })),
      policy: TYPEAHEAD,
    });
  }

  entries() { return entriesOf(this.list); }
  index() { return select(this.list, this.entries()); }
  row() { const index = this.index(); return index < 0 ? null : this.rows[index]; }
  choices() { return this.choosing ? entriesOf(this.choosing.list) : []; }
  choiceIndex() { return this.choosing ? select(this.choosing.list, this.choices()) : -1; }

  beginChoice(row) {
    const selected = row.choices.indexOf(String(row.value));
    this.choosing = {
      row,
      list: createListState({
        rows: row.choices.map((choice, index) => ({
          key: `choice:${index}`, text: choice, search: choice,
        })),
        policy: TYPEAHEAD,
        fallbackIndex: Math.max(0, selected),
      }),
    };
    select(this.choosing.list);
  }

  endChoice() { this.choosing = null; }

  move(action) {
    const list = this.choosing ? this.choosing.list : this.list;
    move(list, action, 10);
  }

  handle(action) {
    if (this.choosing) {
      if (action === 'close-popup') { this.endChoice(); return { handled: true }; }
      const movement = listMovement(action);
      if (movement) { this.move(movement); return { handled: true }; }
      if (action === 'activate') {
        const index = this.choiceIndex();
        const entries = this.choices();
        if (index >= 0 && entries[index]) {
          this.choosing.row.value = entries[index].row.text;
          this.endChoice();
          return { handled: true, changed: true };
        }
        return { handled: true, message: 'No value to choose.' };
      }
      return { handled: true };
    }
    if (action === 'close-popup') return { handled: true, command: 'cancel' };
    const movement = listMovement(action);
    if (movement) { this.move(movement); return { handled: true }; }
    if (action === 'focus-next' || action === 'focus-previous') {
      this.move(action === 'focus-next' ? 'next' : 'previous');
      return { handled: true };
    }
    if (action !== 'activate') return { handled: false };
    const row = this.row();
    if (!row) return { handled: true, message: 'No property is selected.' };
    if (row.kind === 'readonly') {
      return { handled: true, message: `${row.label} comes from the page and is read-only.` };
    }
    if (row.kind === 'action') return { handled: true, command: row.command };
    if (row.kind === 'boolean') {
      row.value = !row.value;
      return { handled: true, changed: true };
    }
    if (row.kind === 'choice') {
      if (!row.choices || !row.choices.length) return { handled: true, message: 'No choices are available.' };
      this.beginChoice(row);
      return { handled: true };
    }
    return { handled: true, edit: row.id };
  }

  values() {
    const values = {};
    for (const row of this.rows) {
      if (row.kind === 'action') continue;
      values[row.id] = copy(row.value);
    }
    return values;
  }

  snapshot() {
    const lines = [this.title];
    let cursor = 0;
    if (this.choosing) {
      lines.push(display({ ...this.choosing.row, value: this.choosing.row.value }), '');
      const entries = this.choices();
      for (const entry of entries) lines.push(entry.row.text);
      const target = cursorLocation(this.choosing.list, entries, (_entry, index) => 3 + index);
      cursor = target.location >= 0 ? target.location : 2;
    } else {
      for (const row of this.rows) lines.push(display(row));
      const target = cursorLocation(this.list, this.entries(), (_entry, index) => 1 + index);
      cursor = target.location >= 0 ? target.location : 1;
    }
    return { title: this.title, status: this.status, cursor, lines };
  }
}

module.exports = { PropertySheet, display, normalizeRow };
