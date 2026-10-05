'use strict';

// The content coverage page is a checked-in fixture, so its shape is pinned
// without a browser. The browser suite proves each view reads it; this proves
// the page still carries a case for every category, so a section cannot be
// dropped or mistyped without the omission showing up in the fast run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { PAGES, pagePath, parseArgs } = require('../tools/serve');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'tools', 'content-coverage.html'), 'utf8');

const SECTIONS = Array.from({ length: 25 }, (unused, index) => `C${String(index + 1).padStart(2, '0')}`);

test('the coverage page carries one section for every category', () => {
  for (const id of SECTIONS) {
    assert.match(PAGE, new RegExp(`data-coverage="${id}"`), `missing section ${id}`);
  }
});

test('the coverage page exercises the supported HTML building blocks', () => {
  const needles = [
    '<h1', '<h2', '<h6', '<p>', '<a ', '<button', '<input', '<select', '<textarea',
    '<table', '<caption', '<thead', '<tbody', '<tfoot', '<th', '<td',
    '<ul', '<ol', '<li', '<dl', '<dt', '<dd', '<figure', '<figcaption',
    '<blockquote', '<pre', '<code', '<address', '<hr', '<img', '<svg',
    '<picture', '<canvas', '<video', '<audio', '<iframe', '<form',
    '<fieldset', '<legend', '<label', '<details', '<summary', '<dialog',
    '<template', '<progress', '<meter', '<output', 'contenteditable',
  ];
  for (const needle of needles) assert.ok(PAGE.includes(needle), `missing ${needle}`);
});

test('the coverage page exercises the supported ARIA roles and properties', () => {
  const roles = [
    'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell',
    'checkbox', 'combobox', 'complementary', 'contentinfo', 'definition', 'directory',
    'document', 'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading',
    'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math',
    'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
    'navigation', 'note', 'option', 'presentation', 'progressbar', 'radio',
    'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
    'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'suggestion',
    'switch', 'tab', 'table', 'tablist', 'tabpanel', 'timer', 'toolbar', 'tooltip',
    'tree', 'treegrid', 'treeitem',
  ];
  for (const role of roles) assert.ok(PAGE.includes(`role="${role}"`), `missing role=${role}`);
  const properties = [
    'aria-checked', 'aria-expanded', 'aria-pressed', 'aria-selected', 'aria-valuenow',
    'aria-live', 'aria-hidden', 'aria-label', 'aria-labelledby', 'aria-describedby',
    'aria-current', 'aria-disabled', 'aria-busy', 'aria-level', 'aria-haspopup',
  ];
  for (const property of properties) assert.ok(PAGE.includes(property), `missing ${property}`);
});

test('the coverage page exercises the hidden-content decisions', () => {
  for (const marker of [
    'hidden', 'inert', 'display: none', 'visibility: hidden', 'opacity: 0',
    'content-visibility: hidden', 'display: contents', 'visually-hidden', 'attachShadow',
  ]) {
    assert.ok(PAGE.includes(marker), `missing ${marker}`);
  }
});

test('the coverage page is self-contained', () => {
  // A subresource fetched over the network would make the page depend on a
  // server that may not be there and a site that may change. Ordinary links
  // are fine; they are never fetched to read the page.
  for (const match of PAGE.matchAll(/(?:\bsrc|\bposter)\s*=\s*["']([^"']+)["']/g)) {
    assert.ok(match[1].startsWith('data:'), `external subresource ${match[1]}`);
  }
  for (const match of PAGE.matchAll(/url\((["']?)([^"')]+)\1\)/g)) {
    assert.ok(match[2].startsWith('data:'), `external stylesheet url ${match[2]}`);
  }
});

test('serve names the coverage page and keeps the default test page', () => {
  assert.equal(pagePath('coverage'), PAGES.coverage);
  assert.equal(pagePath('testpage'), PAGES.testpage);
  assert.equal(pagePath(), PAGES.testpage);
  assert.equal(pagePath('/tmp/custom.html'), '/tmp/custom.html');
  assert.deepEqual(parseArgs(['8123']), { port: 8123, page: PAGES.testpage });
  assert.deepEqual(parseArgs(['--page', 'coverage']), { port: 0, page: PAGES.coverage });
  assert.deepEqual(parseArgs(['--page=coverage', '9000']), { port: 9000, page: PAGES.coverage });
});
