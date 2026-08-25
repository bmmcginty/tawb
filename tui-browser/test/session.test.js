'use strict';

// Who is reading which tab, and in which browser.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-session-state-'));
process.env.XDG_DATA_HOME = state;

const { claimTab, claimedTargets, releaseTab, otherReadersOn, claimsPath } = require('../src/session');

const PORT = 45999;
const DEAD_PID = 0x7fffffff;

test.after(() => { fs.rmSync(state, { recursive: true, force: true }); });

test('a session that is alone in a browser knows it', () => {
  claimTab(PORT, 'tab-1');
  assert.equal(otherReadersOn(PORT), false, 'its own claim looked like somebody else');
  releaseTab(PORT);
});

test('a browser with another live reader in it is not ours to close', () => {
  claimTab(PORT, 'tab-1');
  const claims = JSON.parse(fs.readFileSync(claimsPath(PORT), 'utf8'));
  claims.push({ pid: process.ppid, targetId: 'tab-2', at: Date.now() });
  fs.writeFileSync(claimsPath(PORT), JSON.stringify(claims));

  assert.equal(otherReadersOn(PORT), true);
  assert.equal(claimedTargets(PORT).has('tab-2'), true, 'the other reader\'s tab looked free');
  assert.equal(claimedTargets(PORT).has('tab-1'), false, 'our own tab looked taken');
  releaseTab(PORT);
});

test('a claim from a reader that has died holds nothing', () => {
  fs.writeFileSync(claimsPath(PORT), JSON.stringify([
    { pid: DEAD_PID, targetId: 'tab-3', at: Date.now() },
  ]));
  assert.equal(otherReadersOn(PORT), false, 'a dead reader kept a browser alive');
  assert.equal(claimedTargets(PORT).has('tab-3'), false, 'a dead reader kept a tab');
});

test('a browser nothing was ever claimed in is nobody else\'s', () => {
  assert.equal(otherReadersOn(0), false);
  assert.equal(otherReadersOn(45123), false);
});
