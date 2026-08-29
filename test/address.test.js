'use strict';

// What the reader typed, turned into somewhere to go.
//
// The interesting cases are the ones either side of the line between an
// address and a search, because getting that line wrong in either direction
// is worse than useless: a host treated as words sends the reader to a search
// engine for a page they named exactly, and words treated as a host send them
// to a name that does not resolve.

const test = require('node:test');
const assert = require('node:assert');

const { resolveAddress, searchUrl, DEFAULT_SEARCH } = require('../src/address');

test('an address with a scheme is taken exactly as it was typed', () => {
  for (const typed of ['https://example.com/a?b=c', 'http://a.test/', 'about:blank',
    'file:///tmp/page.html', 'mailto:someone@example.com', 'view-source:https://a.test/']) {
    assert.deepEqual(resolveAddress(typed), { url: typed, searched: false });
  }
});

test('a bare host gets https, because that is the web now', () => {
  assert.equal(resolveAddress('wikipedia.org').url, 'https://wikipedia.org');
  assert.equal(resolveAddress('en.wikipedia.org/wiki/Braille').url,
    'https://en.wikipedia.org/wiki/Braille');
  assert.equal(resolveAddress('example.com:8443/x').url, 'https://example.com:8443/x');
});

test('what has no certificate gets http', () => {
  // Loopback, a name on the local network, and a bare address: a browser
  // sends all three over http, since none of them normally has a certificate.
  assert.equal(resolveAddress('localhost:8080').url, 'http://localhost:8080');
  assert.equal(resolveAddress('127.0.0.1:3000/x').url, 'http://127.0.0.1:3000/x');
  assert.equal(resolveAddress('printer.local').url, 'http://printer.local');
  assert.equal(resolveAddress('192.168.1.5').url, 'http://192.168.1.5');
  // A host and a port and no dot at all is a development server, not a
  // scheme called "myhost".
  assert.equal(resolveAddress('myhost:3000').url, 'http://myhost:3000');
});

test('words are searched for, and the answer says that is what happened', () => {
  const searched = resolveAddress('braille dots');
  assert.equal(searched.searched, true);
  assert.equal(searched.words, 'braille dots');
  assert.equal(searched.url, 'https://duckduckgo.com/?q=braille%20dots');
  // One word with no dot in it is not a host either. A browser guesses the
  // same way, and guessing "http://braille" is how a url bar sends you
  // nowhere at all.
  assert.equal(resolveAddress('braille').searched, true);
});

test('nothing typed is nothing to open, not an empty search', () => {
  assert.deepEqual(resolveAddress(''), { error: 'nothing to open' });
  assert.deepEqual(resolveAddress('   '), { error: 'nothing to open' });
  assert.deepEqual(resolveAddress(null), { error: 'nothing to open' });
});

test('the search engine is the reader\'s to choose', () => {
  // A browser asks its own settings which one it is; neither protocol will
  // say, so it is said on the command line instead. `%s` is where the words
  // go, and a template without one has them appended.
  assert.equal(resolveAddress('braille', { search: 'https://s.test/find?q=%s&hl=en' }).url,
    'https://s.test/find?q=braille&hl=en');
  assert.equal(resolveAddress('a b', { search: 'https://s.test/?q=' }).url,
    'https://s.test/?q=a%20b');
  assert.equal(searchUrl('a&b'), DEFAULT_SEARCH.replace('%s', 'a%26b'));
});
