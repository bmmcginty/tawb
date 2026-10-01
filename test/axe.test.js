'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs } = require('../tools/axe');

test('the axe runner accepts a browser, rule tags, and multiple pages', () => {
  assert.deepEqual(
    parseArgs(['--browser', 'firefox', '--tags=wcag2a,wcag2aa', 'https://a.test/', 'https://b.test/']),
    {
      engine: 'firefox', tags: ['wcag2a', 'wcag2aa'],
      urls: ['https://a.test/', 'https://b.test/'],
    },
  );
});

test('the axe runner requires a page to audit', () => {
  assert.throws(() => parseArgs([]), /At least one URL is required/);
  assert.throws(() => parseArgs(['--browser', 'webkit', 'https://example.com']), /Unknown browser/);
  assert.throws(() => parseArgs(['--rules', 'image-alt']), /Unrecognized argument --rules/);
});
