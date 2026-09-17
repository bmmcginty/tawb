'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startupStatus } = require('../src/startup');

function controlledStatus({ isTTY = true } = {}) {
  const written = [];
  let pending = null;
  let delay = null;
  let cleared = false;
  const status = startupStatus({
    write: (text) => written.push(text),
    isTTY,
    setTimer: (fn, ms) => { pending = fn; delay = ms; return 1; },
    clearTimer: () => { cleared = true; pending = null; },
  });
  return {
    status,
    written,
    delay: () => delay,
    fire: () => { const fn = pending; pending = null; fn(); },
    cleared: () => cleared,
  };
}

test('a quick startup finishes without writing a status line', () => {
  const controlled = controlledStatus();
  controlled.status.update('Starting Firefox…');
  controlled.status.update('Checking Firefox…');

  assert.equal(controlled.delay(), 10000);
  assert.deepEqual(controlled.written, []);
  controlled.status.finish();
  assert.equal(controlled.cleared(), true);
  assert.deepEqual(controlled.written, []);
});

test('a ten-second startup shows its latest phase and then replaces it', () => {
  const controlled = controlledStatus();
  const { status, written } = controlled;

  assert.equal(status.update('Starting Firefox…'), true);
  assert.equal(status.update('Checking Firefox…'), true);
  assert.deepEqual(written, []);
  controlled.fire();
  assert.equal(status.update('Checking Firefox…'), false);
  assert.equal(status.update('Firefox is still starting (20s)…'), true);
  status.finish();

  assert.deepEqual(written, [
    '\r\x1b[2KChecking Firefox…',
    '\r\x1b[2KFirefox is still starting (20s)…',
    '\n',
  ]);
});

test('redirected startup phases become complete lines after the delay', () => {
  const controlled = controlledStatus({ isTTY: false });
  controlled.status.update('Starting Firefox…');
  controlled.fire();
  controlled.status.update('Firefox is still starting (20s)…');
  controlled.status.finish();

  assert.deepEqual(controlled.written, [
    'Starting Firefox…\n',
    'Firefox is still starting (20s)…\n',
  ]);
});
