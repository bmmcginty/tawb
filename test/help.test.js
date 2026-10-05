'use strict';

// --help is a parse concern: it has to be accepted before anything else looks
// at the options, and asking for it must not open a browser or take a
// terminal. So it is checked by running the entry points with no display and
// a settings directory that does not exist.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function help(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(__dirname, 'missing-config') },
    encoding: 'utf8',
    timeout: 20000,
  });
}

test('the reader prints its help and exits without a browser', () => {
  const result = help('src/index.js', ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: tawb /);
  assert.match(result.stdout, /--front-end/);
  assert.match(result.stdout, /--dump/);
  assert.equal(result.stderr, '');
});

test('the reader help answers -h as well', () => {
  const result = help('src/index.js', ['-h']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: tawb /);
});

test('the reader help wins over a mode that would open a browser', () => {
  // --dump would otherwise need a URL and start a browser; the help check
  // comes first, so it prints and leaves.
  const result = help('src/index.js', ['--dump', '--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: tawb /);
});

test('the edbrowse entry point prints its own help', () => {
  const result = help('src/edb.js', ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: edb /);
  assert.match(result.stdout, /--port/);
  assert.equal(result.stderr, '');
});
