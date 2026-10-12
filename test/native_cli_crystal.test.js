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
  assert.doesNotMatch(help.stdout, /not yet available/);
  // What is deliberately not here says so, and says where it went.
  assert.match(help.stdout, /edb front end is not part of the static reader/);
});

test('the native CLI refuses the front end that is not part of it', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const edb = spawnSync(binary, ['--front-end', 'edb'], {
    encoding: 'utf8', input: '',
  });
  assert.equal(edb.status, 1);
  assert.match(edb.stderr, /not part of the static reader/);

  // And the two flags that are each a whole run cannot be one run.
  const both = spawnSync(binary, ['--dump', '--keyboard'], {
    encoding: 'utf8', input: '',
  });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--keyboard cannot be combined with --dump/);
});

test('the keyboard screen opens without a browser and leaves what it found', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  // No keystrokes at all: the screen opens, finds its input ended, puts the
  // bindings back as they were and leaves. Nothing is saved, and no browser
  // was ever started.
  const wizard = spawnSync(binary, ['--keyboard', '--no-alt-screen'], {
    encoding: 'utf8', input: '', timeout: 20000,
  });
  assert.equal(wizard.status, 0, wizard.stderr);
  assert.match(wizard.stdout, /Keyboard bindings/, 'it drew its own screen');
  assert.doesNotMatch(wizard.stderr, /not connected/);
});
