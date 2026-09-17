'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startupStatus } = require('../src/startup');

test('startup phases replace one terminal line without animating repeats', () => {
  const written = [];
  const status = startupStatus({ write: (text) => written.push(text), isTTY: true });

  assert.equal(status.update('Starting Firefox…'), true);
  assert.equal(status.update('Starting Firefox…'), false);
  assert.equal(status.update('Checking Firefox…'), true);
  status.finish();

  assert.deepEqual(written, [
    '\r\x1b[2KStarting Firefox…',
    '\r\x1b[2KChecking Firefox…',
    '\n',
  ]);
});

test('redirected startup phases are complete lines', () => {
  const written = [];
  const status = startupStatus({ write: (text) => written.push(text), isTTY: false });
  status.update('Starting Firefox…');
  status.update('Firefox is still starting (10s)…');
  status.finish();

  assert.deepEqual(written, [
    'Starting Firefox…\n',
    'Firefox is still starting (10s)…\n',
  ]);
});
