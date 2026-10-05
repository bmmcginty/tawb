'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { settingsPath, splitSettings, readSettings } = require('../src/settings');
const { parseArgs, keymapForOptions } = require('../src/index');
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

test('the interface and its Lynx settings can be chosen in the settings file', () => {
  const dir = tempDir('tawb-settings-interface-');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '--interface=lynx\n--lynx-executable=/opt/lynx\n');
  const args = parseArgs([...readSettings({ file })], {});
  assert.equal(args.interface, 'lynx');
  assert.equal(args.lynxExecutable, '/opt/lynx');

  // The command line is still read after the file, so it wins.
  assert.equal(
    parseArgs([...readSettings({ file }), '--interface=default'], {}).interface, 'default');
});

test('command-line options can override persistent browser settings', () => {
  const configured = ['--browser', 'firefox', '--keep-browser'];
  assert.equal(parseArgs([], { TAWB_LOG_DIR: '/environment/logs' }).logDir, '/environment/logs');
  assert.equal(parseEdbArgs([], { TAWB_LOG_DIR: '/environment/logs' }).logDir, '/environment/logs');

  const args = parseArgs([
    ...configured, '--browser', 'chromium', '--no-keep-browser', '--log', '--log-dir', '/host/logs',
  ], {});
  assert.equal(args.engine, 'chromium');
  assert.equal(args.keepBrowser, false);
  assert.equal(args.log, true);
  assert.equal(args.logDir, '/host/logs');

  assert.equal(parseArgs([], {}).dump, false);
  assert.equal(parseArgs(['--dump', 'message.html'], {}).dump, true);
  assert.equal(parseArgs([], {}).interface, 'default');
  assert.equal(parseArgs([], {}).lynxExecutable, 'lynx');
  assert.equal(parseArgs([], { TAWB_LYNX: '/opt/lynx' }).lynxExecutable, '/opt/lynx');
  assert.equal(parseArgs([], { TAWB_INTERFACE: 'lynx' }).interface, 'lynx');
  assert.equal(parseArgs(['--interface=lynx'], {}).interface, 'lynx');
  assert.equal(parseArgs(['--interface', 'default'], { TAWB_INTERFACE: 'lynx' }).interface, 'default');
  assert.throws(() => parseArgs(['--interface=visual'], {}), /Unknown interface/);
  const lynxArgs = parseArgs([
    '--interface=lynx', '--lynx-executable=/opt/lynx', '--lynx-config', '/config/lynx.cfg',
  ], {});
  assert.equal(lynxArgs.lynxExecutable, '/opt/lynx');
  assert.equal(lynxArgs.lynxConfig, '/config/lynx.cfg');
  assert.equal(parseArgs(['--lynx-executable', '/opt/x'], {}).lynxExecutable, '/opt/x');
  assert.equal(parseArgs(['--lynx-config=/config/x'], {}).lynxConfig, '/config/x');

  assert.equal(parseArgs([], {}).escapeUnicode, false);
  assert.equal(parseArgs(['--escape-unicode'], {}).escapeUnicode, true);
  assert.equal(parseArgs(['--escape-unicode', '--no-escape-unicode'], {}).escapeUnicode, false);

  // The alternate screen is the default, and a settings-file choice can be
  // overridden for one run.
  assert.equal(parseArgs([], {}).altScreen, true);
  assert.equal(parseArgs(['--no-alt-screen'], {}).altScreen, false);
  assert.equal(parseArgs(['--no-alt-screen', '--alt-screen'], {}).altScreen, true);

  // Closing the session's tab is off unless asked for, on the command line or
  // in the settings file.
  assert.equal(parseArgs([], {}).closeInitialTabOnExit, false);
  assert.equal(
    parseArgs(['--close-initial-tab-on-exit'], {}).closeInitialTabOnExit, true);
  assert.equal(
    parseArgs(['--close-initial-tab-on-exit', '--no-close-initial-tab-on-exit'], {})
      .closeInitialTabOnExit,
    false,
  );

  const edbArgs = parseEdbArgs([
    ...configured, '--browser', 'chromium', '--no-keep-browser', '--log', '--log-dir=/host/logs',
  ], {});
  assert.equal(edbArgs.engine, 'chromium');
  assert.equal(edbArgs.keepBrowser, false);
  assert.equal(edbArgs.log, true);
  assert.equal(edbArgs.logDir, '/host/logs');

  // edb resolves the same shared browser options, plus its port, and refuses
  // unknown options the same way.
  const shared = parseEdbArgs(['--browser-timeout', '10', '--keep-browser', '--port', '8080'], {});
  assert.equal(shared.browserTimeoutMs, 10000);
  assert.equal(shared.keepBrowser, true);
  assert.equal(shared.port, 8080);
  assert.throws(() => parseEdbArgs(['--not-an-option'], {}), /Unknown option/);
  assert.throws(() => parseEdbArgs(['--port', 'not-a-port'], {}), /between 0 and 65535/);
});

test('the option parser refuses what it does not know', () => {
  // The hand-written loop ignored anything it did not recognise, which made a
  // typo look like it worked. The standard parser refuses it, and a bare --
  // still lets a positional start with a dash.
  assert.throws(() => parseArgs(['--not-an-option'], {}), /Unknown option/);
  assert.throws(() => parseArgs(['--browser'], {}), /argument missing/);
  assert.equal(parseArgs(['--', '--not-an-option'], {}).url, '--not-an-option');
});

test('the link preferences are not set from the environment', () => {
  // These are reading preferences, not deployment values. The environment is
  // reserved for values a wrapper or a container supplies -- the log
  // directory, the lynx path, the search template -- and these two live in the
  // settings file, set by their command-line spellings.
  assert.equal(parseArgs([], { TAWB_LINK_ADDRESS: 'off' }).linkAddress, true);
  assert.equal(parseArgs([], { TAWB_SHORT_LINKS: 'on' }).shortLinks, false);
  assert.equal(parseArgs(['--no-link-address'], {}).linkAddress, false);
  assert.equal(parseArgs(['--short-links'], {}).shortLinks, true);
});

test('--browser-timeout is per-run seconds and validates its value', () => {
  assert.equal(parseArgs([], {}).browserTimeoutMs, null);
  assert.equal(parseArgs(['--browser-timeout', '120'], {}).browserTimeoutMs, 120000);
  assert.equal(parseArgs(['--browser-timeout=45'], {}).browserTimeoutMs, 45000);
  assert.throws(() => parseArgs(['--browser-timeout', 'soon'], {}), /positive number of seconds/);
  assert.throws(() => parseArgs(['--browser-timeout=-1'], {}), /positive number of seconds/);
});

test('Lynx preferences cannot be set through the command line or main settings', () => {
  // They live in settings.lynx.json and are changed on the options screen. The
  // main settings file is read as command-line arguments, so its vocabulary
  // must refuse these names too, however they are spelled.
  const names = [
    'show-cursor', 'number-links-on-left', 'number-fields-on-left',
    'textfields-need-activation', 'keypad-mode', 'search-case',
  ];
  for (const name of names) {
    assert.throws(() => parseArgs([`--${name}`], {}), /Unknown option/, name);
    assert.throws(() => parseArgs([`--${name}=on`], {}), /Unknown option/, name);
  }
});

test('only the Lynx interface asks Lynx for effective bindings', () => {
  let calls = 0;
  const importLynx = (options) => {
    calls += 1;
    assert.deepEqual(options, { executable: '/opt/lynx', config: '/config/lynx.cfg' });
    return { bindings: { 'confirm-quit': ['x'] }, unsupported: ['SHELL'] };
  };
  const lynx = keymapForOptions({
    interface: 'lynx', lynxExecutable: '/opt/lynx', lynxConfig: '/config/lynx.cfg',
  }, { importLynx });
  assert.equal(lynx.actionFor('x'), 'confirm-quit');
  assert.deepEqual(lynx.unsupported, ['SHELL']);

  const ordinary = keymapForOptions({ interface: 'default' }, { importLynx });
  assert.equal(ordinary.actionFor('q'), 'quit');
  assert.equal(calls, 1);
});

test('a malformed settings file names itself in the error', () => {
  const dir = tempDir('tawb-settings-bad-');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '--profile "unfinished\n');
  assert.throws(() => readSettings({ file }), new RegExp(`Cannot read settings from ${file}`));
});
