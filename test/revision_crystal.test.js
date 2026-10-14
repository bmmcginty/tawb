'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';
const HASH = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'abcdef0123456789abcdef0123456789abcdef01';

test('native revision resolution follows packaged, built, and package metadata precedence',
  { skip }, () => {
    assert.equal(call('revision.resolve', {
      env: { TAWB_COMMIT: HASH }, built: OTHER,
      package: JSON.stringify({ gitHead: OTHER }),
    }), HASH);
    assert.equal(call('revision.resolve', {
      env: {}, built: OTHER, package: JSON.stringify({ gitHead: HASH }),
    }), OTHER);
    assert.equal(call('revision.resolve', {
      env: {}, built: 'invalid', git: OTHER,
      package: JSON.stringify({ gitHead: HASH }),
    }), OTHER);
    assert.equal(call('revision.resolve', {
      env: {}, built: '', git: '', package: JSON.stringify({ gitHead: HASH }),
    }), HASH);
    assert.equal(call('revision.resolve', {
      env: { TAWB_COMMIT: 'not-a-hash' }, built: '', package: '{}',
    }), 'unknown');
  });
