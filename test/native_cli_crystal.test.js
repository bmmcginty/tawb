'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'dist', 'tawb-crystal');

test('the native CLI says which engines it reads interactively', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /interactively through Firefox and\s+Chromium/,
    'both engines read interactively');
  assert.doesNotMatch(help.stdout, /interactive reader is not ported/);
  assert.doesNotMatch(help.stdout, /Interactive Chromium .*not yet available/);
  // What is still missing is named rather than discovered.
  assert.match(help.stdout, /edb front end and the standalone keyboard wizard/);
});

test('the native CLI still refuses what it cannot do', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const edb = spawnSync(binary, ['--front-end', 'edb'], {
    encoding: 'utf8', input: '',
  });
  assert.equal(edb.status, 1);
  assert.match(edb.stderr, /edb front end is not ported/);

  const wizard = spawnSync(binary, ['--keyboard'], { encoding: 'utf8', input: '' });
  assert.equal(wizard.status, 1);
  assert.match(wizard.stderr, /keyboard wizard is not connected/);
});
