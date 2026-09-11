'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { settingsPath, splitSettings, readSettings } = require('../src/settings');
const { parseArgs } = require('../src/index');
const { parseArgs: parseEdbArgs } = require('../src/edb');
const { tempDir } = require('./tmpdir');

test('the settings file uses command-line option syntax', () => {
  assert.deepEqual(splitSettings(`
    # Browser defaults for every run
    --browser firefox
    --keep-browser
    --profile "a profile"
    --search='https://example.test/?q=%s' # an end-of-line comment
  `), [
    '--browser', 'firefox', '--keep-browser', '--profile', 'a profile',
    '--search=https://example.test/?q=%s',
  ]);
});

test('settings use the XDG config directory and a missing file is optional', () => {
  const home = tempDir('tawb-settings-home-');
  assert.equal(
    settingsPath({ XDG_CONFIG_HOME: '/tmp/my-config' }, home),
    path.join('/tmp/my-config', 'tawb', 'settings'),
  );
  assert.deepEqual(readSettings({ env: {}, home }), []);
});

test('settings are read from disk as arguments', () => {
  const dir = tempDir('tawb-settings-');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '--browser firefox\n--keep-browser\n');
  assert.deepEqual(readSettings({ file }), ['--browser', 'firefox', '--keep-browser']);
});

test('command-line options can override persistent browser settings', () => {
  const configured = ['--browser', 'firefox', '--keep-browser'];
  const args = parseArgs([...configured, '--browser', 'chromium', '--no-keep-browser'], {});
  assert.equal(args.engine, 'chromium');
  assert.equal(args.keepBrowser, false);

  const edbArgs = parseEdbArgs([...configured, '--browser', 'chromium', '--no-keep-browser']);
  assert.equal(edbArgs.engine, 'chromium');
  assert.equal(edbArgs.keepBrowser, false);
});

test('a malformed settings file names itself in the error', () => {
  const dir = tempDir('tawb-settings-bad-');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '--profile "unfinished\n');
  assert.throws(() => readSettings({ file }), new RegExp(`Cannot read settings from ${file}`));
});
