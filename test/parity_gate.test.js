'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const REPORTER = path.join(ROOT, 'tools', 'fail_on_skips_reporter.js');
const BROWSER_RUNNER = path.join(ROOT, 'tools', 'test_crystal_browser.sh');

function reporterRun(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-parity-reporter-'));
  const fixture = path.join(directory, 'fixture.test.js');
  fs.writeFileSync(fixture, source);
  try {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [
      '--test',
      '--test-reporter=spec',
      `--test-reporter=${REPORTER}`,
      '--test-reporter-destination=stdout',
      '--test-reporter-destination=stderr',
      fixture,
    ], { encoding: 'utf8', env });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the browser gate gives Node an absolute reporter path', () => {
  const runner = fs.readFileSync(BROWSER_RUNNER, 'utf8');
  assert.match(runner, /--test-reporter="\$ROOT\/tools\/fail_on_skips_reporter\.js"/);
});

test('the parity reporter leaves a complete run successful', () => {
  const result = reporterRun("require('node:test')('complete', () => {});\n");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Unexpected skipped tests/);
});

test('the parity reporter makes a skipped test fail the gate', () => {
  const result = reporterRun("require('node:test')('missing browser', { skip: 'absent' }, () => {});\n");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unexpected skipped tests \(1\):/);
  assert.match(result.stderr, /missing browser/);
});
