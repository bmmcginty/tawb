'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { renderLine } = require('../src/aria');

test('ARIA values and orientation are spoken on fields', () => {
  assert.equal(renderLine({
    role: 'slider', name: 'Volume', value: '35 percent', orientation: 'vertical',
  }), '[Volume: 35 percent, vertical]');
});

test('ARIA control states are spoken without visual-only symbols', () => {
  assert.equal(renderLine({ role: 'checkbox', name: 'Updates', checked: false }),
    '[*Updates, not checked]');
  assert.equal(renderLine({ role: 'checkbox', name: 'Topics', checked: 'mixed' }),
    '[*Topics, partly checked]');
  assert.equal(renderLine({ role: 'button', name: 'Pin', pressed: true }),
    '[*Pin, pressed]');
  assert.equal(renderLine({ role: 'option', name: 'Newest', selected: true, disabled: true }),
    '[*Newest, selected, unavailable]');
});

test('ARIA document and validation states are spoken', () => {
  assert.equal(renderLine({ role: 'link', name: 'Setup', current: 'step' }),
    '{Setup, current step}');
  assert.equal(renderLine({
    role: 'textbox', name: 'Email', required: true, invalid: 'spelling', readonly: true,
  }), '[Email, read only, required, invalid: spelling]');
});
