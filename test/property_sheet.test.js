'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PropertySheet } = require('../src/property_sheet');
const { call } = require('./crystal_impl');

const crystal = process.env.TAWB_TEST_CRYSTAL === '1';

function rows() {
  return [
    { id: 'name', label: 'Name', kind: 'text', value: 'Listbox' },
    { id: 'read', label: 'Read', kind: 'choice', value: 'accessible-name',
      choices: ['accessible-name', 'visible-text', 'form-value'] },
    { id: 'enabled', label: 'Enabled', kind: 'boolean', value: 'yes' },
    { id: 'role', label: 'Role', kind: 'readonly', value: 'link' },
  ];
}

function javascript(spec) {
  const sheet = new PropertySheet({
    title: spec.title, rows: spec.rows, actionLabel: spec.actionLabel,
  });
  const results = (spec.actions || []).map((action) => sheet.handle(action));
  return { results, snapshot: sheet.snapshot() };
}

function run(spec) {
  const expected = javascript(spec);
  if (crystal) assert.deepEqual(call('property_sheet.scenario', spec), expected);
  return expected;
}

test('a property sheet lists source and control values with the cursor on the row', () => {
  const result = run({
    title: 'Add listbox', rows: rows(), actionLabel: 'Add listbox', actions: [],
  });
  assert.deepEqual(result.snapshot.lines, [
    'Add listbox', 'Name: Listbox', 'Read: accessible-name', 'Enabled: yes',
    'Role: link (source)', '[Add listbox]',
  ]);
  assert.equal(result.snapshot.lines[result.snapshot.cursor], 'Name: Listbox');
});

test('a choice row opens a list and writes the chosen value back', () => {
  const result = run({
    title: 'Add listbox', rows: rows(), actionLabel: 'Add listbox',
    actions: ['next', 'activate', 'next', 'activate'],
  });
  assert.deepEqual(result.results, [
    { handled: true }, { handled: true }, { handled: true },
    { handled: true, changed: true },
  ]);
  assert.match(result.snapshot.lines.find((line) => line.startsWith('Read:')), /visible-text$/);
});

test('boolean, read-only, edit and action rows answer differently', () => {
  const result = run({
    title: 'Properties', rows: rows(), actionLabel: 'Apply',
    actions: ['next', 'next', 'activate', 'next', 'activate', 'last', 'activate'],
  });
  assert.deepEqual(result.results, [
    { handled: true }, { handled: true },
    { handled: true, changed: true },
    { handled: true },
    { handled: true, message: 'Role comes from the page and is read-only.' },
    { handled: true }, { handled: true, command: 'apply' },
  ]);
  assert.match(result.snapshot.lines.find((line) => line.startsWith('Enabled:')), /no$/);
});

test('a text row asks its caller to edit that row', () => {
  const result = run({ title: 'Properties', rows: rows(), actions: ['activate'] });
  assert.deepEqual(result.results, [{ handled: true, edit: 'name' }]);
});

test('Escape closes a choice list first and the sheet second', () => {
  const choice = run({
    title: 'Properties', rows: rows(), actions: ['next', 'activate', 'close-popup'],
  });
  assert.deepEqual(choice.results, [
    { handled: true }, { handled: true }, { handled: true },
  ]);
  assert.equal(choice.snapshot.lines.some((line) => line === 'enabled'), false);
  const sheet = run({ title: 'Properties', rows: rows(), actions: ['close-popup'] });
  assert.deepEqual(sheet.results, [{ handled: true, command: 'cancel' }]);
});
