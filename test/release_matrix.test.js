'use strict';

// The release matrix must be able to say what it will run before it runs it,
// and it must refuse to qualify an artifact that is not the checkout under
// test.
//
// A matrix that silently drops an environment, or that runs a development
// binary built before the last change, is exactly the kind of evidence this
// plan treats as no evidence at all. These checks need no browser: they read
// the plan, the environment list and the artifact gate's refusal.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('./tmpdir');

const ROOT = path.join(__dirname, '..');
const MATRIX = path.join(ROOT, 'tools', 'test_release_matrix.sh');
const DISCOVERY = path.join(ROOT, 'tools', 'browser_tests.sh');
const GATE = path.join(ROOT, 'tools', 'test_crystal_browser.sh');

const ENVIRONMENTS = [
  'chromium',
  'firefox',
  'firefox-stable',
  'firefox-beta',
  'firefox-nightly',
  'flatpak',
  'no-desktop',
];

function run(args, env = {}) {
  return spawnSync('sh', [MATRIX, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, ...env },
  });
}

function discoveredTests() {
  const found = spawnSync('sh', [DISCOVERY], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
  });
  assert.equal(found.status, 0, found.stderr);
  return found.stdout.split('\n').filter((line) => line.endsWith('.test.js'));
}

test('the matrix names every environment the plan requires', () => {
  const listed = run(['--list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n'), ENVIRONMENTS);
});

test('an unknown environment is refused rather than silently skipped', () => {
  const refused = run(['--plan'], { TAWB_MATRIX_ONLY: 'chromium,firefox-sunset' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unknown environment: firefox-sunset/);
  assert.doesNotMatch(refused.stdout, /^environment: /m);

  const comma = run(['--plan'], { TAWB_MATRIX_ONLY: 'chromium,no-desktop' });
  assert.equal(comma.status, 0, comma.stderr);
  const environments = comma.stdout.split('\n')
    .filter((line) => line.startsWith('environment: '));
  assert.deepEqual(environments, [
    'environment: chromium engine=chromium browser=distribution desktop=yes',
    'environment: no-desktop engine=chromium browser=distribution desktop=no',
    'environment: no-desktop engine=firefox browser=distribution desktop=no',
  ]);
});

test('the plan runs the release artifact through every discovered differential', () => {
  const plan = run(['--plan']);
  assert.equal(plan.status, 0, plan.stderr);
  const lines = plan.stdout.split('\n');
  assert.ok(lines.includes(
    'artifact-build: TAWB_RELEASE_BUILD=1 tools/build_crystal.sh bin/tawb-release',
  ), 'the matrix must build the artifact as a release build');
  assert.ok(lines.includes('artifact-verify: tools/verify_crystal_build.sh bin/tawb-release'),
    'the matrix must verify the artifact before running it');

  const planned = lines
    .filter((line) => line.startsWith('test: '))
    .map((line) => line.slice('test: '.length));
  // The set is the same discovery the gate uses, so a release matrix cannot
  // claim a test the gate would not run, or omit one it would.
  assert.deepEqual(planned, discoveredTests());
  assert.ok(planned.length >= 20);
});

test('the gate builds and verifies the binary it was told to test', () => {
  const gate = fs.readFileSync(GATE, 'utf8');
  // A matrix that verified bin/tawb while the tests started the release
  // artifact would prove the revision of a binary no browser ran.
  assert.match(gate, /BINARY=\$\{TAWB_CRYSTAL_BIN:-bin\/tawb\}/,
    'the gate must name one binary for build, verify, and test');
  assert.match(gate, /tools\/build_crystal\.sh "\$BINARY"/,
    'the gate must build the binary it will test');
  assert.match(gate, /tools\/verify_crystal_build\.sh "\$BINARY"/,
    'the gate must verify the binary it will test');
});

test('the gate and the matrix share one test discovery', () => {
  const gate = fs.readFileSync(GATE, 'utf8');
  assert.match(gate, /tools\/browser_tests\.sh/,
    'the gate must take its file set from the shared discovery');
  const matrix = fs.readFileSync(MATRIX, 'utf8');
  assert.match(matrix, /tools\/browser_tests\.sh/,
    'the matrix must take its file set from the shared discovery');
});

test('the Firefox channels are Mozilla archives, not the distribution package', () => {
  const plan = run(['--plan']);
  const lines = plan.stdout.split('\n').filter((line) => line.startsWith('environment: firefox-'));
  for (const channel of ['stable', 'beta', 'nightly']) {
    assert.ok(lines.includes(
      `environment: firefox-${channel} engine=firefox browser=mozilla-${channel} desktop=yes`,
    ), `firefox-${channel} must be the Mozilla ${channel} archive`);
  }
});

test('a binary that is not this checkout is refused before any browser runs', () => {
  const dir = tempDir('release-matrix-stale');
  try {
    const fake = path.join(dir, 'tawb-release');
    fs.writeFileSync(fake, '#!/bin/sh\nprintf "0.0.0 +fake (built elsewhere)\\n"\n');
    fs.chmodSync(fake, 0o755);
    const refused = run([], {
      TAWB_MATRIX_ARTIFACT: fake,
      TAWB_MATRIX_ONLY: 'chromium',
      TAWB_MATRIX_LOG: path.join(dir, 'logs'),
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /was not built from HEAD/);
    assert.doesNotMatch(refused.stdout, /^==> chromium:/m,
      'no browser may start for an artifact that failed verification');
  } finally {
    removeTempDir(dir);
  }
});

test('an unknown option is refused', () => {
  const refused = run(['--qualify']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unknown option: --qualify/);
});

test('a node test option is forwarded to the gates, not refused', () => {
  const narrow = '--test-name-pattern=the static Crystal dump';
  const plan = run(['--plan', narrow]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(plan.stdout.split('\n').includes(`forward: ${narrow}`),
    'the plan must print the option every gate would receive');
});
