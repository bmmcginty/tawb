'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { settingsPath, splitSettings, readSettings } = require('../src/settings');
const { parseArgs: jsParseArgs, keymapForOptions } = require('../src/index');
const { parseArgs: jsParseEdbArgs, runEdb } = require('../src/edb');
const { frontEndName: jsFrontEndName } = require('../src/options');
const { optionImplementations } = require('./crystal_impl');
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

function defineOptionTests(implementation) {
  const { parseArgs, parseEdbArgs, frontEndName } = implementation;
  const optionTest = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  optionTest('the front end and its Lynx settings can be chosen in the settings file', () => {
    const dir = tempDir('tawb-settings-front-end-');
    const file = path.join(dir, 'settings');
    fs.writeFileSync(file, '--front-end=lynx\n--lynx-executable=/opt/lynx\n');
    const args = parseArgs([...readSettings({ file })], {});
    assert.equal(args.frontEnd, 'lynx');
    assert.equal(args.lynxExecutable, '/opt/lynx');

    // The command line is still read after the file, so it wins.
    assert.equal(
      parseArgs([...readSettings({ file }), '--front-end=default'], {}).frontEnd, 'default');
  });

  optionTest('command-line options can override persistent browser settings', () => {
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
    assert.equal(parseArgs([], {}).frontEnd, 'default');
    assert.equal(parseArgs([], {}).lynxExecutable, 'lynx');
    assert.equal(parseArgs([], { TAWB_LYNX: '/opt/lynx' }).lynxExecutable, '/opt/lynx');
    assert.equal(parseArgs([], { TAWB_FRONT_END: 'lynx' }).frontEnd, 'lynx');
    assert.equal(parseArgs(['--front-end=lynx'], {}).frontEnd, 'lynx');
    assert.equal(parseArgs(['--front-end', 'default'], { TAWB_FRONT_END: 'lynx' }).frontEnd, 'default');
    assert.equal(parseArgs(['--front-end=edb'], {}).frontEnd, 'edb');
    assert.equal(parseArgs([], { TAWB_FRONT_END: 'edb' }).frontEnd, 'edb');
    assert.equal(parseArgs(['--front-end=edb', '--port', '8080'], {}).port, 8080);
    assert.throws(() => parseArgs(['--front-end=visual'], {}), /Unknown front end/);
    const lynxArgs = parseArgs([
      '--front-end=lynx', '--lynx-executable=/opt/lynx', '--lynx-config', '/config/lynx.cfg',
    ], {});
    assert.equal(lynxArgs.lynxExecutable, '/opt/lynx');
    assert.equal(lynxArgs.lynxConfig, '/config/lynx.cfg');
    assert.equal(parseArgs(['--lynx-executable', '/opt/x'], {}).lynxExecutable, '/opt/x');
    assert.equal(parseArgs(['--lynx-config=/config/x'], {}).lynxConfig, '/config/x');
    assert.equal(parseArgs([], {}).lynxReimport, false);
    assert.equal(parseArgs(['--lynx-reimport'], {}).lynxReimport, true);

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

    // --help is accepted by every entry point, in both spellings.
    assert.equal(parseArgs([], {}).help, false);
    assert.equal(parseArgs(['--help'], {}).help, true);
    assert.equal(parseArgs(['-h'], {}).help, true);
    assert.equal(parseEdbArgs(['--help'], {}).help, true);
  });

  optionTest('the option parser refuses what it does not know', () => {
    // A bare -- still lets a positional start with a dash.
    assert.throws(() => parseArgs(['--not-an-option'], {}), /Unknown option/);
    assert.throws(() => parseArgs(['--browser'], {}), /argument missing/);
    assert.equal(parseArgs(['--', '--not-an-option'], {}).url, '--not-an-option');
  });

  optionTest('the link preferences are not set from the environment', () => {
    assert.equal(parseArgs([], { TAWB_LINK_ADDRESS: 'off' }).linkAddress, true);
    assert.equal(parseArgs([], { TAWB_SHORT_LINKS: 'on' }).shortLinks, false);
    assert.equal(parseArgs(['--no-link-address'], {}).linkAddress, false);
    assert.equal(parseArgs(['--short-links'], {}).shortLinks, true);
  });

  optionTest('--browser-timeout is per-run seconds and validates its value', () => {
    assert.equal(parseArgs([], {}).browserTimeoutMs, null);
    assert.equal(parseArgs(['--browser-timeout', '120'], {}).browserTimeoutMs, 120000);
    assert.equal(parseArgs(['--browser-timeout=45'], {}).browserTimeoutMs, 45000);
    assert.throws(() => parseArgs(['--browser-timeout', 'soon'], {}), /positive number of seconds/);
    assert.throws(() => parseArgs(['--browser-timeout=-1'], {}), /positive number of seconds/);
  });

  optionTest('Lynx preferences cannot be set through the command line or main settings', () => {
    const names = [
      'show-cursor', 'number-links-on-left', 'number-fields-on-left',
      'textfields-need-activation', 'keypad-mode', 'search-case',
    ];
    for (const name of names) {
      assert.throws(() => parseArgs([`--${name}`], {}), /Unknown option/, name);
      assert.throws(() => parseArgs([`--${name}=on`], {}), /Unknown option/, name);
    }
  });

  optionTest('the front end is validated with its own vocabulary', () => {
    assert.equal(frontEndName('lynx'), 'lynx');
    assert.equal(frontEndName('LYNX'), 'lynx');
    assert.equal(frontEndName('edb'), 'edb');
    assert.equal(frontEndName(undefined), 'default');
    assert.throws(() => frontEndName('emacs'), /Unknown front end/);
  });
}

for (const implementation of optionImplementations({
  parseArgs: jsParseArgs,
  parseEdbArgs: jsParseEdbArgs,
  frontEndName: jsFrontEndName,
})) {
  defineOptionTests(implementation);
}

// The edbrowse bridge is exported so the reader can dispatch to it rather than
// starting a second copy of itself. This is a JavaScript module-boundary check,
// not option-parser behavior.
test('the edbrowse bridge is exported', () => {
  assert.equal(typeof runEdb, 'function');
});

test('only the Lynx front end asks Lynx for effective bindings', () => {
  const dir = tempDir('tawb-lynx-import-');
  let calls = 0;
  const importLynx = (options) => {
    calls += 1;
    assert.deepEqual(options, { executable: '/opt/lynx', config: '/config/lynx.cfg' });
    return { available: true, bindings: { 'confirm-quit': ['x'] }, unsupported: ['SHELL'] };
  };
  const lynx = keymapForOptions({
    frontEnd: 'lynx', lynxExecutable: '/opt/lynx', lynxConfig: '/config/lynx.cfg',
  }, {
    importLynx, keysFile: path.join(dir, 'keys-lynx.json'), hasKeys: () => false,
    readLynx: () => ({}), writeLynx: () => {},
  });
  assert.equal(lynx.actionFor('x'), 'confirm-quit');
  assert.deepEqual(lynx.unsupported, ['SHELL']);

  const ordinary = keymapForOptions({ frontEnd: 'default' }, { importLynx });
  assert.equal(ordinary.actionFor('q'), 'quit');
  assert.equal(calls, 1, 'the ordinary front end must not run Lynx');
});

test('a malformed settings file names itself in the error', () => {
  const dir = tempDir('tawb-settings-bad-');
  const file = path.join(dir, 'settings');
  fs.writeFileSync(file, '--profile "unfinished\n');
  assert.throws(() => readSettings({ file }), new RegExp(`Cannot read settings from ${file}`));
});
