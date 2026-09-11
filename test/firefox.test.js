'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MARIONETTE_TIMEOUT_MS } = require('../src/firefox');

test('Marionette operations allow a slow Firefox a full minute', () => {
  assert.equal(MARIONETTE_TIMEOUT_MS, 60000);
});
