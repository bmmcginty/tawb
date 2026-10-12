'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'dist', 'tawb-crystal');

test('native CLI advertises interactive Firefox instead of the old porting guard', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /supports interactive Firefox/);
  assert.doesNotMatch(help.stdout, /interactive reader is not ported/);

  const unsupported = spawnSync(binary, ['--browser', 'chromium'], {
    encoding: 'utf8', input: '',
  });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /currently needs --browser firefox/);
  assert.doesNotMatch(unsupported.stderr, /interactive reader is not ported/);
});
