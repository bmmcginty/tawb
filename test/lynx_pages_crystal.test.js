'use strict';

// The internal Lynx pages' row builders, differenced between the JavaScript
// original and the Crystal port. Both read nothing but their arguments, so
// the page contents are pinned at the module boundary, where they can be
// read without a buffer or a terminal.

const test = require('node:test');
const assert = require('node:assert');

const { lynxPagesImplementations } = require('./crystal_impl');

const implementations = lynxPagesImplementations(require('../src/lynx_pages'));

for (const implementation of implementations) {
  test(`${implementation.name}: HELP lists the commands and names unsupported imported functions`, () => {
    const plain = implementation.page('help', { unsupported: [] });
    assert.equal(plain[0], 'Lynx Help for TAWB');
    assert.ok(plain.includes('Left: return from this help page.'));
    assert.ok(!plain.some((row) => row.startsWith('Unavailable')));

    const imported = implementation.page('help', { unsupported: ['DIRED', 'DIRED_MENU'] });
    assert.equal(imported.at(-1), 'Unavailable Lynx functions: DIRED, DIRED_MENU');
    assert.equal(imported.at(-2), '');
  });

  test(`${implementation.name}: INFO describes the page, and the selected control when there is one`, () => {
    const plain = implementation.page('document_info', {
      title: 'The page', url: 'https://example.test/page', source: 'ax', size: 42, item: null,
    });
    assert.deepEqual(plain.map((row) => row.text), [
      'File that you are currently viewing',
      'Linkname: The page',
      'URL: https://example.test/page',
      'size: 42 lines',
      'mode: normal',
    ]);

    const selected = implementation.page('document_info', {
      title: '', url: 'about:blank', source: 'source', size: 1,
      item: { role: 'link', name: 'About', href: 'https://example.test/about' },
    });
    assert.deepEqual(selected.slice(5).map((row) => row.text), [
      'Link that you currently have selected',
      'Linkname: About',
      'URL: https://example.test/about',
    ]);
    assert.equal(selected[1].text, 'Linkname: (no title)');
    assert.equal(selected[4].text, 'mode: source');

    // A named control with no address is still worth describing.
    const nameless = implementation.page('document_info', {
      title: 't', url: 'u', source: 'ax', size: 0,
      item: { role: 'button', name: '' },
    });
    assert.deepEqual(nameless.slice(5).map((row) => row.text), [
      'Link that you currently have selected',
      'Linkname: (unnamed)',
    ]);
  });

  test(`${implementation.name}: VLINKS keeps names, addresses and the address Enter follows`, () => {
    const rows = implementation.page('visited', {
      visited: [
        { name: 'Beta', href: 'https://example.test/b' },
        { name: 'Alpha', href: 'https://example.test/a' },
      ],
    });
    assert.deepEqual(rows.map((row) => row.text), [
      'Beta — https://example.test/b',
      'Alpha — https://example.test/a',
    ]);
    assert.deepEqual(rows[0].entry, { title: 'Beta', url: 'https://example.test/b' });
    assert.deepEqual(implementation.page('visited', {}), []);
  });

  test(`${implementation.name}: HISTORY marks the current document and keeps the rest in order`, () => {
    const rows = implementation.page('session', {
      pageLog: [
        { url: 'https://example.test/now', title: 'Now' },
        { url: 'https://example.test/before', title: 'Before' },
      ],
    });
    assert.deepEqual(rows.map((row) => row.text), [
      'here: Now — https://example.test/now',
      'Before — https://example.test/before',
    ]);
    assert.deepEqual(implementation.page('session', {}), []);
  });

  test(`${implementation.name}: LIST keeps page order and the block Enter must activate`, () => {
    const first = { text: '{Alpha}', item: { role: 'link', name: 'Alpha', href: 'https://example.test/a' } };
    const second = { text: '{Beta}', item: { role: 'link', name: 'Beta', href: 'https://example.test/b' } };
    const blocks = [{ text: 'prose', item: { role: 'text', name: 'prose' } }, first, second];

    const plain = implementation.page('link_list', { blocks, lines: [], addresses: false, numbered: false });
    assert.deepEqual(plain.map((row) => row.text), ['1. Alpha', '2. Beta']);
    assert.deepEqual(plain[0].entry.block, first);

    const numbered = implementation.page('link_list', {
      blocks,
      lines: [
        { blockIndex: 0, text: 'prose' },
        { blockIndex: 1, text: 'Alpha', displayNumber: 7 },
        { blockIndex: 2, text: 'Beta', displayNumber: 8 },
      ],
      addresses: false,
      numbered: true,
    });
    assert.deepEqual(numbered.map((row) => row.text), ['[7] Alpha', '[8] Beta']);

    const addresses = implementation.page('link_list', { blocks, lines: [], addresses: true, numbered: false });
    assert.deepEqual(addresses.map((row) => row.text), [
      '1. https://example.test/a', '2. https://example.test/b',
    ]);
  });

  test(`${implementation.name}: LIST skips non-links and links with nowhere to go`, () => {
    const blocks = [
      { text: '{Alpha}', item: { role: 'link', name: 'Alpha', href: 'https://example.test/a' } },
      { text: '{Bare}', item: { role: 'link', name: 'Bare' } },
      { text: 'text', item: { role: 'text', name: 'text' } },
      { text: '{Beta}', item: { role: 'link', name: 'Beta', href: 'https://example.test/b' } },
    ];
    const rows = implementation.page('link_list', { blocks, lines: [], addresses: false, numbered: false });
    assert.deepEqual(rows.map((row) => row.text), ['1. Alpha', '2. Beta']);
  });

  test(`${implementation.name}: DWIMHELP describes a control or says there is nothing to describe`, () => {
    assert.equal(implementation.page('describe', { item: null }), null);
    assert.equal(
      implementation.page('describe', {
        item: { role: 'link', name: 'About', href: 'https://example.test/a' },
      }),
      'About — link — goes to https://example.test/a. Enter activates it.');
    assert.equal(
      implementation.page('describe', { item: { role: 'textbox', name: 'Email' } }),
      'Email — textbox. Typing enters it; Enter submits.');
    assert.equal(
      implementation.page('describe', {
        item: { role: 'button', name: 'Menu', expanded: false, disabled: true },
      }),
      'Menu — button — collapsed — disabled. Enter activates it.');
    assert.equal(
      implementation.page('describe', { item: { role: 'checkbox', name: 'News', checked: true } }),
      'News — checkbox — checked. Enter activates it.');
  });

  test(`${implementation.name}: the trace page is the last 500 non-blank lines`, () => {
    const text = `${Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')}\n\n`;
    const rows = implementation.page('trace', { text });
    assert.equal(rows.length, 500);
    assert.equal(rows[0].text, 'line 100');
    assert.equal(rows.at(-1).text, 'line 599');
  });
}
