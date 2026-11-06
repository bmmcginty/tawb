'use strict';

// This is an inventory gate, not a behavioral-completeness claim. It makes a
// new runtime module, conformance operation, or embedded page asset fail the
// ordinary test suite until its current parity status is classified.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'parity-manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const entries = manifest.entries;
const STATUSES = new Set([
  'uncovered', 'scripted-only', 'single-engine', 'single-surface', 'covered',
  'intentional-difference', 'retired',
]);
const KINDS = new Set(['asset', 'module', 'operation', 'surface']);
const ARRAY_FIELDS = [
  'javascript', 'crystal', 'surfaces', 'engines', 'views', 'fixtures', 'levels',
  'tests', 'differences',
];

function filesUnder(directory, extension) {
  return fs.readdirSync(path.join(ROOT, directory))
    .filter((name) => name.endsWith(extension))
    .map((name) => path.posix.join(directory, name))
    .sort();
}

function dispatchedOperations() {
  const source = fs.readFileSync(
    path.join(ROOT, 'crystal/src/tawb/conformance.cr'), 'utf8',
  ).split('\n');
  const start = source.findIndex((line) => line.includes('def self.dispatch('));
  assert.ok(start >= 0, 'conformance.cr has no dispatch method');
  const end = source.findIndex((line, index) => index > start
    && /^    (private )?def self\./.test(line));
  assert.ok(end > start, 'the conformance dispatch method has no end');
  const operations = [];
  for (const line of source.slice(start, end)) {
    const clause = line.match(/^\s*when\s+(.*)$/);
    if (!clause) continue;
    for (const name of clause[1].matchAll(/"([^"]+)"/g)) operations.push(name[1]);
  }
  return operations.sort();
}

function valuesFor(kind, field) {
  return entries.filter((entry) => entry.kind === kind).flatMap((entry) => entry[field] || []);
}

function assertExactInventory(label, actual, recorded) {
  assert.deepEqual([...new Set(recorded)].sort(), actual,
    `${label} changed without a parity-manifest classification`);
  assert.equal(recorded.length, new Set(recorded).size,
    `${label} must belong to exactly one manifest entry`);
}

test('the parity manifest has valid, conservative entries', () => {
  assert.equal(manifest.version, 1);
  assert.ok(Array.isArray(entries) && entries.length > 0);
  const ids = new Set();
  for (const entry of entries) {
    assert.match(entry.id, /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
    assert.equal(ids.has(entry.id), false, `duplicate parity id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(KINDS.has(entry.kind), `${entry.id} has unknown kind ${entry.kind}`);
    assert.ok(STATUSES.has(entry.status), `${entry.id} has unknown status ${entry.status}`);
    for (const field of ARRAY_FIELDS) {
      assert.ok(Array.isArray(entry[field]), `${entry.id}.${field} must be an array`);
      if (field !== 'differences') {
        assert.equal(entry[field].length, new Set(entry[field]).size,
          `${entry.id}.${field} contains duplicates`);
      }
    }
    for (const file of [...entry.javascript, ...entry.crystal, ...entry.tests]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${entry.id} names missing ${file}`);
    }
    if (entry.kind === 'operation') {
      assert.ok(Array.isArray(entry.operations) && entry.operations.length > 0,
        `${entry.id} has no operations`);
      assert.ok(entry.tests.length > 0, `${entry.id} has no exercising test`);
    } else {
      assert.equal(Object.hasOwn(entry, 'operations'), false,
        `${entry.id} is not an operation entry`);
    }
    if (entry.status === 'covered') {
      assert.ok(entry.tests.length > 0, `${entry.id} claims coverage without a test`);
      assert.ok(entry.levels.length > 0, `${entry.id} claims coverage without a test level`);
    }
    if (entry.status === 'intentional-difference') {
      assert.ok(entry.differences.length > 0, `${entry.id} has no difference record`);
      for (const difference of entry.differences) {
        for (const field of ['owner', 'rationale', 'impact', 'expiry']) {
          assert.equal(typeof difference[field], 'string', `${entry.id} difference lacks ${field}`);
          assert.ok(difference[field].trim(), `${entry.id} difference has empty ${field}`);
        }
      }
    } else {
      assert.deepEqual(entry.differences, [], `${entry.id} has an unregistered difference`);
    }
  }
});

test('every JavaScript and Crystal module is classified exactly once', () => {
  assertExactInventory('JavaScript modules', filesUnder('src', '.js'), valuesFor('module', 'javascript'));
  const crystal = [
    ...filesUnder('crystal/src/tawb', '.cr'),
    'crystal/src/tawb.cr',
  ].sort();
  assertExactInventory('Crystal modules', crystal, valuesFor('module', 'crystal'));
});

test('every conformance operation is classified exactly once', () => {
  assertExactInventory(
    'conformance operations', dispatchedOperations(), valuesFor('operation', 'operations'),
  );
});

test('every embedded page asset is classified exactly once', () => {
  assertExactInventory(
    'embedded page assets', filesUnder('crystal/assets', '.js'), valuesFor('asset', 'crystal'),
  );
});

test('parity ids named by tests exist in the manifest', () => {
  const ids = new Set(entries.map((entry) => entry.id));
  const unknown = new Set();
  for (const directory of ['test', 'test/browser']) {
    for (const file of filesUnder(directory, '.js')) {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of source.matchAll(/parity-id:\s*([a-z0-9]+(?:[.-][a-z0-9]+)*)/g)) {
        if (!ids.has(match[1])) unknown.add(match[1]);
      }
    }
  }
  assert.deepEqual([...unknown].sort(), []);
});
