'use strict';

const test = require('node:test');
const assert = require('node:assert');
const library = require('../src/library');
const { call } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);

test('native library entry descriptions match the shipping reader', { skip }, () => {
  const cases = [
    ['bookmarks', { title: '  Crystal   language ', url: 'https://crystal-lang.org/', folder: 'Tools' }],
    ['history', { title: 'Article', url: 'https://example.test/article', when: NOW - 3 * 3600000 }],
    ['downloads', { title: 'archive', url: 'https://example.test/archive.tar',
      state: 'complete', bytes: 1536, totalBytes: 1536, when: NOW - 65000 }],
    ['history', { title: 'https://example.test/' + 'x'.repeat(150),
      url: 'https://example.test/' + 'x'.repeat(150), when: NOW - 40 * 86400000 }],
  ];
  for (const [kind, entry] of cases) {
    assert.equal(call('library.entry_line', { kind, entry, now: NOW }),
      library.entryLine(kind, entry, NOW));
  }
});

test('native library age, size, address and filtering policy matches', { skip }, () => {
  for (const when of [null, NOW - 1000, NOW - 120000, NOW - 3600000,
    NOW - 3 * 86400000, NOW - 40 * 86400000]) {
    assert.equal(call('library.relative_age', { when, now: NOW }),
      library.relativeAge(when, NOW));
  }
  for (const [bytes, total] of [[0, 0], [42, null], [1536, 0], [0, 15 << 20]]) {
    assert.equal(call('library.size_text', { bytes, total }),
      library.sizeText(bytes, total));
  }
  const long = `https://example.test/path?${'tracking='.repeat(30)}`;
  assert.equal(call('library.short_address', { url: long }), library.shortAddress(long));
  for (const filter of ['', 'wiki braille', 'BRAILLE', 'missing']) {
    assert.equal(call('library.matches', {
      line: 'Braille — https://en.example/wiki/article', filter,
    }), library.matches('Braille — https://en.example/wiki/article', filter));
  }
});

test('native library ordering drops empty entries and caps newest records', { skip }, () => {
  const entries = [
    { title: 'empty' },
    { title: 'old', url: 'https://old.test/', when: 1 },
    { title: 'file', file: '/tmp/download', when: 3 },
    { title: 'new', url: 'https://new.test/', when: 4 },
  ];
  for (const kind of ['bookmarks', 'history', 'downloads']) {
    assert.deepEqual(call('library.order_entries', { kind, entries, max: 2 }),
      library.orderEntries(kind, entries, { max: 2 }));
  }
});
