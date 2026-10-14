'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';

test('native startup status stays quiet until its delay and replaces one line', { skip }, () => {
  const result = call('startup.scenario', {
    tty: true,
    script: [
      { op: 'update', message: 'Starting Firefox…' },
      { op: 'update', message: 'Checking Firefox…' },
      { op: 'show' },
      { op: 'update', message: 'Checking Firefox…' },
      { op: 'update', message: 'Firefox is still starting (20s)…' },
      { op: 'finish' },
    ],
  });
  assert.deepEqual(result.observations, [true, true, null, false, true, null]);
  assert.deepEqual(result.writes, [
    '\r\x1b[2KChecking Firefox…',
    '\r\x1b[2KFirefox is still starting (20s)…',
    '\n',
  ]);

  const redirected = call('startup.scenario', {
    tty: false,
    script: [
      { op: 'update', message: 'Starting Chromium…' },
      { op: 'show' },
      { op: 'finish' },
    ],
  });
  assert.deepEqual(redirected.writes, ['Starting Chromium…\n']);
});

test('native logging is opt-in, private, structured, and counted', { skip }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-crystal-log-'));
  try {
    const directory = path.join(home, 'mounted', 'logs');
    const now = new Date(2026, 7, 27, 14, 5, 9);
    const result = call('log.scenario', {
      now: now.getTime(), pid: 4321, home, directory,
      events: [
        { op: 'write', event: 'start', fields: { engine: 'firefox' } },
        { op: 'count', name: 'fastKeys', amount: 2 },
        { op: 'flush_counters', fields: { refreshes: 1 } },
        { op: 'count', name: 'pendingAtClose', amount: 3 },
      ],
    });
    assert.equal(result.path,
      path.join(directory, '.tawb.20260827140509.4321.log'));
    assert.equal(result.mode, 0o600);
    assert.match(result.contents,
      /^# tawb log .* pid \d+ commit (?:[0-9a-f]{40,64}|unknown)\n/);
    const records = result.contents.trim().split('\n').slice(1).map(JSON.parse);
    assert.equal(records[0].event, 'start');
    assert.equal(records[0].engine, 'firefox');
    assert.deepEqual({ event: records[1].event, fastKeys: records[1].fastKeys,
      refreshes: records[1].refreshes },
    { event: 'counters', fastKeys: 2, refreshes: 1 });
    assert.deepEqual({ event: records[2].event,
      pendingAtClose: records[2].pendingAtClose },
    { event: 'counters', pendingAtClose: 3 });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('native cleanup blanks a kept last tab and restores the terminal once', { skip }, () => {
  const result = call('runtime.scenario', {
    page: true, pages: 1, keep: true, alt: true,
  });
  assert.equal(result.result, 'blanked');
  assert.deepEqual(result.calls, ['blank']);
  assert.equal(result.events[0].event, 'tab.blanked');
  assert.equal(result.first, true);
  assert.equal(result.second, false, 'shutdown is idempotent');
  assert.equal(result.cleaned, 1);
  assert.equal(result.terminal, '\x1b[?1049h\x1b[r\x1b[2J\x1b[r\x1b[?1049l');
});

test('native initial-tab cleanup leaves failed kept tabs and closes others', { skip }, () => {
  const kept = call('runtime.scenario', {
    page: true, pages: 1, keep: true, gotoFault: 'navigation refused', alt: false,
  });
  assert.equal(kept.result, 'kept');
  assert.deepEqual(kept.calls, ['blank']);
  assert.equal(kept.events[0].event, 'tab.blank.failed');

  const closed = call('runtime.scenario', {
    page: true, pages: 2, keep: true, alt: false,
  });
  assert.equal(closed.result, 'closed');
  assert.deepEqual(closed.calls, ['close']);

  const missing = call('runtime.scenario', {
    page: false, pages: 0, keep: false, alt: false,
  });
  assert.equal(missing.result, 'none');
});

test('native shutdown bounds browser cleanup after restoring the terminal', { skip }, () => {
  const result = call('runtime.scenario', {
    page: false, pages: 0, keep: false, alt: false,
    cleanupMs: 80, timeoutMs: 5,
  });
  assert.equal(result.first, false);
  assert.equal(result.second, false);
  assert.equal(result.cleaned, 0);
  assert.ok(result.terminal.endsWith('\x1b[999;1H\n'));
});
