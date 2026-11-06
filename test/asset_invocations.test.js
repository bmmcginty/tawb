'use strict';

// This is an inventory test, not proof that the recorded contract reached a
// browser. Protocol transcript tests consume these seams incrementally; this
// gate prevents a generated page asset from having no documented caller,
// target, arguments, retry policy, ownership, or cleanup policy in either
// runtime.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'crystal/assets');
const inventory = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'asset-invocations.json'), 'utf8',
));
const CONTRACT_FIELDS = ['callers', 'symbol', 'target', 'arguments', 'retry', 'ownership', 'cleanup'];

function generatedAssets() {
  return fs.readdirSync(ASSET_DIR).filter((name) => name.endsWith('.js')).sort();
}

test('every generated page asset has one invocation contract', () => {
  assert.equal(inventory.version, 1);
  assert.ok(inventory.description.includes('protocol-transcript'));
  const recorded = inventory.assets.map(({ asset }) => asset);
  assert.equal(recorded.length, new Set(recorded).size, 'asset invocation contracts must be unique');
  assert.deepEqual(recorded.slice().sort(), generatedAssets());
});

test('asset invocation contracts name both runtime seams completely', () => {
  for (const entry of inventory.assets) {
    for (const runtime of ['javascript', 'crystal']) {
      const contract = entry[runtime];
      assert.ok(contract, `${entry.asset} has no ${runtime} invocation contract`);
      assert.deepEqual(Object.keys(contract).sort(), CONTRACT_FIELDS.slice().sort(),
        `${entry.asset}.${runtime} has an unknown or missing contract field`);
      assert.ok(Array.isArray(contract.callers) && contract.callers.length > 0,
        `${entry.asset}.${runtime} has no caller`);
      assert.equal(contract.callers.length, new Set(contract.callers).size,
        `${entry.asset}.${runtime} repeats a caller`);
      for (const field of CONTRACT_FIELDS.slice(1)) {
        assert.equal(typeof contract[field], 'string', `${entry.asset}.${runtime}.${field} is not text`);
        assert.ok(contract[field].trim(), `${entry.asset}.${runtime}.${field} is empty`);
      }
      for (const caller of contract.callers) {
        const fullPath = path.join(ROOT, caller);
        assert.ok(fs.existsSync(fullPath), `${entry.asset} names missing caller ${caller}`);
        const source = fs.readFileSync(fullPath, 'utf8');
        assert.ok(source.includes(contract.symbol),
          `${entry.asset}.${runtime} caller ${caller} does not name ${contract.symbol}`);
      }
    }
  }
});
