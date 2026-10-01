'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseArgs, selectedSuites, isComparableExpectation } = require('../tools/wpt');

test('WPT can select the WAI-ARIA role suite as a conformance gate', () => {
  const options = parseArgs(['--suite', 'wai-aria', '--fail-on-mismatch']);
  assert.equal(options.suite, 'wai-aria');
  assert.equal(options.failOnMismatch, true);
  assert.deepEqual(selectedSuites(options.suite), ['wai-aria/role']);
});

test('the default WPT selection retains accessible-name and WAI-ARIA coverage', () => {
  assert.deepEqual(selectedSuites(parseArgs([]).suite), [
    'accname/name', 'accname/name/shadowdom', 'wai-aria/role',
  ]);
});

test('tentative WPT logging sentinels are not treated as literal expected roles', () => {
  assert.equal(isComparableExpectation('button'), true);
  assert.equal(isComparableExpectation('SPEC_AMBIGUOUS_LOG_VALUE'), false);
  assert.equal(isComparableExpectation(null), false);
});

test('an unknown WPT suite is refused', () => {
  assert.throws(() => parseArgs(['--suite=html']), /use all, accname, or wai-aria/);
});
