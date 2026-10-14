'use strict';

// The Crystal comparison surface has to stay complete, and nothing else checks
// that it does.
//
// The port is trusted because the same assertions run against both runtimes:
// JavaScript in process, Crystal through `--conformance`, compared under
// `tools/test_crystal.sh`. That trust rests on two properties:
//
//   1. every `--conformance` operation the binary dispatches is named by a
//      test, so a behavior cannot sit in the table uncompared;
//   2. every module under `src/` is either reached by a test or listed below
//      with the reason it is not, so a new module cannot appear without a
//      decision about how it is covered.
//
// A new src module or a new conformance operation therefore has to be covered
// or classified, which is what keeps "what are we still missing" a question
// that has an answer. This is a static check: it reads the tree, launches
// nothing, and runs in the ordinary `npm test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFORMANCE = path.join(ROOT, 'crystal', 'src', 'tawb', 'conformance.cr');
const IMPLEMENTATIONS = path.join(__dirname, 'crystal_impl.js');
const SELF = path.basename(__filename);
const TEST_DIRS = ['test', path.join('test', 'browser')];

// src modules no test requires by name, and the reason that is not a hole in
// the comparison.
const UNIMPORTED = new Map([
  ['browser',
    'the browser launch adapter: reached through openDriver in the browser '
    + 'tests and compared by the launch and browser-dump differentials'],
  ['dom',
    'page-side HTML-mode helpers, carried for the views rather than imported '
    + 'by a test by name; the views differential compares what they render'],
  ['standalone',
    'the Node entry shim that dispatches the private broker argument; the '
    + 'Crystal equivalent is the private-argument branch in cli.cr'],
]);

function testFiles() {
  const files = [];
  for (const dir of TEST_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(path.join(ROOT, dir, name));
    }
  }
  return files;
}

// Everything a test file says, with this file left out so it cannot satisfy
// its own checks by naming what it is looking for.
function testText() {
  return testFiles()
    .filter((file) => path.basename(file) !== SELF)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

// The operations the conformance dispatcher answers. Only the dispatcher's own
// `when` clauses are read: the step operations inside each scenario are a
// different vocabulary and answer only within one payload.
function dispatchedOperations() {
  const lines = fs.readFileSync(CONFORMANCE, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.includes('def self.dispatch('));
  assert.ok(start >= 0, `${CONFORMANCE} has no dispatch method`);
  const end = lines.findIndex((line, index) => index > start
    && /^    (private )?def self\./.test(line));
  assert.ok(end > start, 'the dispatch method has no end');
  const operations = new Set();
  for (const line of lines.slice(start, end)) {
    const clause = line.match(/^\s*when\s+(.*)$/);
    if (!clause) continue;
    // One clause may name several operations: when "a", "b".
    for (const name of clause[1].matchAll(/"([^"]+)"/g)) operations.add(name[1]);
  }
  return operations;
}

// The operation names a test actually reaches for: through the conformance
// wrapper, or by spawning the binary for a raw operation it does not wrap.
function referencedOperations(text) {
  const referenced = new Set();
  for (const match of text.matchAll(/(?:call|callAsync)\(\s*['"]([a-z0-9_.]+)['"]/g)) {
    referenced.add(match[1]);
  }
  for (const match of text.matchAll(/--conformance['"],\s*['"]([a-z0-9_.]+)['"]/g)) {
    referenced.add(match[1]);
  }
  return referenced;
}

// The names `test/crystal_impl.js` publishes as implementation pairs.
function implementationFactories() {
  const source = fs.readFileSync(IMPLEMENTATIONS, 'utf8');
  const opened = source.indexOf('module.exports = {');
  assert.ok(opened >= 0, 'crystal_impl.js has no exports block');
  const block = source.slice(opened, source.indexOf('};', opened));
  const names = new Set();
  for (const match of block.matchAll(/\b([a-zA-Z][a-zA-Z0-9]*(?:Implementations|Commands))\b/g)) {
    names.add(match[1]);
  }
  return names;
}

// Whether a test names an operation, as a word rather than as a substring of
// something longer. The name may be quoted or, as in the raw-input probe, part
// of a shell command the test builds.
function mentions(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_.])${escaped}($|[^A-Za-z0-9_.])`).test(text);
}

const text = testText();

test('every conformance operation is exercised by a test', () => {
  const operations = dispatchedOperations();
  const untested = [...operations].filter((name) => !mentions(text, name)).sort();
  assert.deepEqual(untested, [],
    'these --conformance operations no test names, so nothing compares them '
    + `against the JavaScript original: ${untested.join(', ')}`);
});

test('every operation a test reaches for is one the dispatcher answers', () => {
  const operations = dispatchedOperations();
  const stale = [...referencedOperations(text)].filter((name) => !operations.has(name)).sort();
  assert.deepEqual(stale, [],
    `these operations are called by a test but no longer dispatched: ${stale.join(', ')}`);
});

test('every implementation pair is used by a test', () => {
  const factories = implementationFactories();
  const unused = [...factories].filter((name) => !text.includes(name)).sort();
  assert.deepEqual(unused, [],
    `these comparison pairs are exported but no test runs them: ${unused.join(', ')}`);
});

test('every src module is exercised by a test or classified', () => {
  const unclassified = [];
  for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (!name.endsWith('.js')) continue;
    const module = name.slice(0, -3);
    const imported = new RegExp(
      `require\\(['"](?:\\.\\./)+src/${module}(?:\\.js)?['"]\\)`).test(text);
    if (!imported && !UNIMPORTED.has(module)) unclassified.push(module);
  }
  assert.deepEqual(unclassified.sort(), [],
    'these src modules no test reaches and no classification explains: '
    + `${unclassified.sort().join(', ')}. Cover them, or add them to UNIMPORTED `
    + 'with the reason they are not a comparison gap.');
});
