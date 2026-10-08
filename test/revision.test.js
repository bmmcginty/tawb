'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { resolveRevision } = require('../src/revision');

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('an explicitly packaged commit identifies the running copy', () => {
  assert.equal(resolveRevision({
    env: { TAWB_COMMIT: HASH },
    exec: () => { throw new Error('Git should not be asked'); },
  }), HASH);
});

test('a compiled commit identifies a standalone copy without adjacent files', () => {
  assert.equal(resolveRevision({
    env: {},
    builtRevision: HASH,
    exec: () => { throw new Error('Git should not be asked'); },
    readFile: () => { throw new Error('package.json should not be read'); },
  }), HASH);
});

test('a source checkout records its Git commit', () => {
  assert.equal(resolveRevision({
    env: {},
    exec: (command, args, options) => {
      assert.equal(command, 'git');
      assert.deepEqual(args, ['rev-parse', '--verify', 'HEAD']);
      assert.equal(options.encoding, 'utf8');
      return `${HASH}\n`;
    },
  }), HASH);
});

test('npm gitHead is used when an installed package has no repository', () => {
  assert.equal(resolveRevision({
    env: {},
    root: '/package',
    exec: () => { throw new Error('no git directory'); },
    readFile: (file) => {
      assert.equal(file, '/package/package.json');
      return JSON.stringify({ gitHead: HASH });
    },
  }), HASH);
});

test('unknown provenance is explicit rather than omitted', () => {
  assert.equal(resolveRevision({
    env: {},
    exec: () => { throw new Error('no git directory'); },
    readFile: () => { throw new Error('no package'); },
  }), 'unknown');
});
