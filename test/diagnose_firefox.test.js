'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs } = require('../tools/diagnose_firefox');

test('the Firefox diagnostic accepts a bind-mounted log directory', () => {
  assert.equal(parseArgs([], { TAWB_LOG_DIR: '/environment/logs' }).logDir,
    '/environment/logs');
  assert.equal(parseArgs(['--log-dir=/mounted/logs'], {}).logDir, '/mounted/logs');
});
