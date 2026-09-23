'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs } = require('../tools/diagnose_firefox');

test('the Firefox diagnostic accepts a bind-mounted log directory', () => {
  assert.equal(parseArgs([], { TAWB_LOG_DIR: '/environment/logs' }).logDir,
    '/environment/logs');
  assert.equal(parseArgs(['--log-dir=/mounted/logs'], {}).logDir, '/mounted/logs');
  assert.equal(parseArgs(['--log-dir', '/mounted/logs'], {}).logDir, '/mounted/logs');
});

// The reader this diagnostic exists for cannot retrieve a log written inside a
// container. An argument that was meant to redirect the log and did not must
// say so, because the alternative is a run that reports success and leaves the
// log exactly where it cannot be reached.
test('a log directory that was asked for and not given is refused', () => {
  assert.throws(() => parseArgs(['--log-dir'], {}), /--log-dir needs a directory after it/);
  assert.throws(() => parseArgs(['--log-dir='], {}), /--log-dir= needs a directory after it/);
  assert.throws(
    () => parseArgs(['--log-dir', '--log-dir=/logs'], {}),
    /--log-dir needs a directory after it/,
  );
});

test('a mistyped argument is refused rather than ignored', () => {
  assert.throws(() => parseArgs(['--logdir', '/logs'], {}), /Unrecognized argument --logdir/);
  assert.throws(() => parseArgs(['/logs'], {}), /Unrecognized argument \/logs/);
});

// --log is a real flag of the reader's. It does nothing here because this
// diagnostic always writes a log, and accepting it silently would teach that
// an argument landing here had an effect.
test('--log is refused with the reason it is not needed', () => {
  assert.throws(
    () => parseArgs(['--log', '--log-dir', '/logs'], {}),
    /always writes a log, so --log has no effect here/,
  );
});

test('every refusal names the usage it expects', () => {
  for (const argv of [['--log'], ['--logdir'], ['--log-dir']]) {
    assert.throws(() => parseArgs(argv, {}),
      /Usage: npm run diagnose:firefox -- \[--log-dir <directory>\]/);
  }
});
