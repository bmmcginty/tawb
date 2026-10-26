'use strict';

// The file chooser a desktop portal would have answered, differenced between
// the JavaScript original and the Crystal port.
//
// Only the parts a client can see are compared here, and they are the parts
// that matter most: the request path a caller computes for itself before it
// calls, the URI a chosen name comes back as, and what the options a caller
// sends are taken to mean. A client that is handed a different request path
// waits for a signal that never arrives, which from the outside is a chooser
// that never appears — the failure this whole thing exists to prevent.

const test = require('node:test');
const assert = require('node:assert');

const { portalImplementations } = require('./crystal_impl');

const implementations = portalImplementations();
const skip = implementations.length < 2
  ? 'the Crystal runtime is not enabled (TAWB_TEST_CRYSTAL=1 with a built binary)'
  : false;

function compare(name, method, ...args) {
  const answers = implementations.map((implementation) => implementation[method](...args));
  for (const [index, other] of answers.slice(1).entries()) {
    assert.deepEqual(
      other, answers[0], `${implementations[index + 1].name} ${name} differs from JavaScript`,
    );
  }
  return answers[0];
}

test('the request path is built the way the client builds it', { skip }, () => {
  // A unique name loses its leading colon and every dot becomes an underscore,
  // because a D-Bus object path has no colons in it.
  assert.equal(
    compare('request path', 'requestPath', ':1.42', 'firefox_123_456'),
    '/org/freedesktop/portal/desktop/request/1_42/firefox_123_456',
  );
  assert.equal(
    compare('request path with dots', 'requestPath', ':1.42.99', 'tok'),
    '/org/freedesktop/portal/desktop/request/1_42_99/tok',
  );
});

test('a chosen name comes back as a file URI', { skip }, () => {
  assert.equal(compare('file uri', 'fileUri', '/home/reader/Downloads'),
    'file:///home/reader/Downloads');
  // A space is the ordinary case, and an unescaped one is a name the browser
  // cannot open.
  assert.equal(compare('file uri with a space', 'fileUri', '/home/reader/My Documents/a b.txt'),
    'file:///home/reader/My%20Documents/a%20b.txt');
  // A percent sign in a name has to survive being escaped, or it becomes an
  // escape for something else.
  assert.equal(compare('file uri with a percent', 'fileUri', '/tmp/100%.txt'),
    'file:///tmp/100%25.txt');
  assert.equal(compare('file uri with unicode', 'fileUri', '/tmp/café.txt'),
    'file:///tmp/caf%C3%A9.txt');
});

test('the options a caller sends are read the same way', { skip }, () => {
  assert.deepEqual(compare('directory options', 'readOptions', {
    directory: true,
    multiple: true,
    handle_token: 'tok',
    current_folder: '/home/reader',
  }, false), {
    directory: true,
    multiple: true,
    handle_token: 'tok',
    current_folder: '/home/reader',
    current_name: '',
  });
});

test('saving is never multiple and never a folder', { skip }, () => {
  // The portal's options are advisory; the interface already says what the
  // caller wants, and a SaveFile that claimed `directory` would be asking for
  // something the interface cannot mean.
  assert.deepEqual(compare('saving options', 'readOptions', {
    directory: true,
    multiple: true,
    current_name: 'report.pdf',
  }, true), {
    directory: false,
    multiple: false,
    handle_token: '',
    current_folder: '',
    current_name: 'report.pdf',
  });
});

test('a current folder arrives with the trailing nul stripped', { skip }, () => {
  const read = compare('current folder', 'readOptions', {
    current_folder: '/tmp/x',
  }, false);
  assert.equal(read.current_folder, '/tmp/x');
});
