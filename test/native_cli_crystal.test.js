'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'bin', 'tawb');

test('the packaged command is the native executable', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.bin.tawb, 'bin/tawb');
});

test('the native CLI says which engines it reads interactively', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /interactively through Firefox and\s+Chromium/,
    'both engines read interactively');
  assert.doesNotMatch(help.stdout, /interactive reader is not ported/);
  assert.doesNotMatch(help.stdout, /not yet available/);
  assert.match(help.stdout, /edb front end hands the same browser to edbrowse/);
});

test('the native CLI includes the edbrowse front end', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
  const edb = spawnSync(binary, ['--front-end', 'edb', '--help'], { encoding: 'utf8' });
  assert.equal(edb.status, 0, edb.stderr);
  assert.match(edb.stdout, /Usage: tawb --front-end edb/);
});

test('the native CLI refuses two whole-run modes together', {
  skip: enabled ? false : 'the Crystal runtime is not enabled',
}, () => {
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
