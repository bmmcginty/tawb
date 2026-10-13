'use strict';

// Options a reader wrote down once, differenced between the JavaScript
// original and the Crystal port.
//
// The quoting rules are the interesting half. They are a shell's — quotes,
// escapes, and a comment that begins where an argument could — without a
// shell being run or a variable being expanded, and a reader who wrote
// `--search "https://example.com/?q=%s"` in the file is owed the same
// argument whichever implementation reads it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { settingsImplementations } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

const implementations = settingsImplementations(require('../src/settings'));

// Every shape worth agreeing about, including the ones that are errors.
const SPLITS = [
  ['--browser firefox', 'plain words'],
  ['--browser   firefox\n--keep-browser\n', 'newlines and runs of spaces'],
  ['', 'nothing at all'],
  ['   \n\t\n', 'nothing but whitespace'],
  ['# a comment on its own\n--browser firefox\n', 'a comment line'],
  ['--browser firefox # trailing comment\n', 'a comment after an argument'],
  ['--search "https://example.com/?q=%s"', 'a double-quoted argument'],
  ["--search 'https://example.com/?q=%s'", 'a single-quoted argument'],
  ['--profile "/home/a reader/My Profile"', 'a quoted path with spaces'],
  ['--profile /home/a\\ reader/profile', 'an escaped space'],
  ['--search "a#b"', 'a hash inside quotes, which is not a comment'],
  ['--search a#b', 'a hash inside a word, which is not a comment either'],
  ["--search 'a\\\\b'", 'a backslash inside single quotes, which is literal'],
  ['--search "a\\"b"', 'an escaped quote inside quotes'],
  ['--browser ""', 'an empty argument, which is still an argument'],
  ['--front-end=lynx', 'an option spelled with an equals sign'],
];

const BROKEN = [
  ['--search "unterminated', 'an unterminated double quote'],
  ["--search 'unterminated", 'an unterminated single quote'],
  ['--search a\\', 'an unfinished escape'],
];

test('the file is split into arguments the same way', () => {
  for (const [text, what] of SPLITS) {
    const answers = implementations.map((implementation) => ({
      name: implementation.name,
      words: implementation.split(text),
    }));
    for (const other of answers.slice(1)) {
      assert.deepEqual(other.words, answers[0].words, `${other.name} split ${what} differently`);
    }
  }
  // And the answers are the ones a reader would expect of a shell.
  const [first] = implementations;
  assert.deepEqual(first.split('--browser firefox'), ['--browser', 'firefox']);
  assert.deepEqual(first.split('# only a comment\n'), []);
  assert.deepEqual(first.split('--profile "/home/a reader/My Profile"'),
    ['--profile', '/home/a reader/My Profile']);
  assert.deepEqual(first.split('--profile /home/a\\ reader/profile'),
    ['--profile', '/home/a reader/profile']);
  assert.deepEqual(first.split('--search a#b'), ['--search', 'a#b']);
  assert.deepEqual(first.split('--browser ""'), ['--browser', '']);
});

test('a file that cannot be read is an error, not an empty answer', () => {
  // A reader who wrote a setting down is owed the news that it is not being
  // used, rather than a browser that quietly ignored it.
  for (const [text, what] of BROKEN) {
    for (const implementation of implementations) {
      assert.throws(() => implementation.split(text), `${implementation.name} accepted ${what}`);
    }
  }
});

test('the file is looked for where the desktop says it should be', () => {
  const cases = [
    [{ XDG_CONFIG_HOME: '/tmp/my-config' }, '/home/reader'],
    [{}, '/home/reader'],
  ];
  for (const [env, home] of cases) {
    const answers = implementations.map((implementation) => ({
      name: implementation.name,
      path: implementation.path(env, home),
    }));
    for (const other of answers.slice(1)) {
      assert.equal(other.path, answers[0].path, `${other.name} looked somewhere else`);
    }
  }
  assert.equal(implementations[0].path({ XDG_CONFIG_HOME: '/tmp/my-config' }, '/home/reader'),
    path.join('/tmp/my-config', 'tawb', 'settings'));
  assert.equal(implementations[0].path({}, '/home/reader'),
    path.join('/home/reader', '.config', 'tawb', 'settings'));
});

test('a file on disk is read, and a missing one is nothing', () => {
  const directory = tempDir('tawb-settings-crystal-');
  try {
    const file = path.join(directory, 'settings');
    fs.writeFileSync(file, '--browser firefox\n--keep-browser\n# and a comment\n');
    for (const implementation of implementations) {
      assert.deepEqual(
        implementation.read({ file }),
        ['--browser', 'firefox', '--keep-browser'],
        `${implementation.name} read the file differently`,
      );
    }
    // No file is no options, which is the ordinary case: most readers have
    // never written one.
    const missing = path.join(directory, 'nothing-here');
    for (const implementation of implementations) {
      assert.deepEqual(implementation.read({ file: missing }), [],
        `${implementation.name} made something of a file that is not there`);
    }
    // And the whole path is honoured, not just the file argument.
    const home = path.join(directory, 'home');
    fs.mkdirSync(path.join(home, '.config', 'tawb'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'tawb', 'settings'), '--front-end lynx\n');
    for (const implementation of implementations) {
      assert.deepEqual(implementation.read({ env: {}, home }), ['--front-end', 'lynx'],
        `${implementation.name} did not read the file under the home it was given`);
    }
  } finally {
    removeTempDir(directory);
  }
});
