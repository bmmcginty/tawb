'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  log, enableLog, getLogPath, defaultLogPath, closeLog,
} = require('../src/log');

test('logging is off until --log enables a timestamped private file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-log-'));
  try {
    // A separate process proves that merely importing and calling log leaves
    // no old-style default file in either the package or the user's home.
    const probe = spawnSync(process.execPath, ['-e', `
      require(${JSON.stringify(path.join(__dirname, '..', 'src', 'log.js'))}).log('should-not-exist');
    `], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.equal(getLogPath(), null);

    const now = new Date(2026, 7, 27, 14, 5, 9);
    const expected = path.join(home, '.tawb.20260827140509.4321.log');
    assert.equal(defaultLogPath({ now, pid: 4321, home }), expected);
    assert.equal(enableLog({ now, pid: 4321, home }), expected);

    log('enabled', { answer: 42 });
    await closeLog();

    const contents = fs.readFileSync(expected, 'utf8');
    assert.match(contents, /^# tawb log .* pid \d+ commit [0-9a-f]{40,64}\n/);
    assert.match(contents, /"event":"enabled","answer":42/);
    assert.equal(fs.statSync(expected).mode & 0o777, 0o600);
  } finally {
    await closeLog();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
