'use strict';

// Naming tabs, which is how two readers stay off each other's.
//
// A session records the tab it is reading, keyed by the browser it is reading
// it in, and a session joining that browser skips what is already taken. All
// of that rests on the driver being able to name a tab in a way that means
// the same thing in another process — a CDP target id on Chromium, a BiDi
// browsing-context id on Firefox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Claims live under the user's data directory. A test must not write to the
// real one, so this is set before session.js is asked for anything.
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-tabs-state-'));
process.env.XDG_DATA_HOME = state;

const { openDriver } = require('../../src/driver');
const { claimedTargets, claimsPath } = require('../../src/session');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tweb-tabs-'));

let driver;

test.after(async () => {
  // The claims these tests fabricate name a live process, and a browser with
  // another live reader in it is deliberately left running. Ours is nobody
  // else's, so the pretence is dropped before the driver is closed — without
  // this, every run of this file leaks a browser.
  if (driver) fs.rmSync(claimsPath(driver.port), { force: true });
  if (driver) await driver.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

test('every tab has a name of its own, and the browser has a port to key them by', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const first = driver.context.pages()[0] || await driver.context.newPage();
  const second = await driver.context.newPage();

  const firstId = await driver.targetIdFor(first);
  const secondId = await driver.targetIdFor(second);

  assert.ok(firstId, 'the first tab has no name');
  assert.ok(secondId, 'the second tab has no name');
  assert.notEqual(firstId, secondId, 'two tabs answered to the same name');
  assert.equal(await driver.targetIdFor(first), firstId, 'a tab was renamed between asks');
  assert.equal(typeof driver.port, 'number', 'the browser has no port to key claims by');
});

test('a tab a live session is reading is one a joining session skips', async () => {
  const first = driver.context.pages()[0];
  const held = await driver.targetIdFor(first);

  // What another reader's process would have left behind. Its pid has to be a
  // live one that is not ours, because a claim is believed only as far as the
  // process that wrote it.
  fs.mkdirSync(path.dirname(claimsPath(driver.port)), { recursive: true });
  fs.writeFileSync(claimsPath(driver.port), JSON.stringify([
    { pid: process.ppid, targetId: held, at: Date.now() },
  ]));

  const taken = claimedTargets(driver.port);
  assert.equal(taken.has(held), true, 'the tab another session is reading looked free');

  // And a claim whose process is gone is not believed at all.
  fs.writeFileSync(claimsPath(driver.port), JSON.stringify([
    { pid: 0x7fffffff, targetId: held, at: Date.now() },
  ]));
  assert.equal(claimedTargets(driver.port).has(held), false, 'a dead session still held a tab');
});

// Two readers in one browser, which is the whole point of naming tabs.
//
// On Chromium this has always worked: its protocol takes as many clients as
// ask. On Firefox it works through the broker, which holds the browser's one
// session and hands every reader the same one — so the same test runs on both
// and neither engine gets a special case here.
test('two readers share one browser and stay off each other\'s tabs', async () => {
  const second = await openDriver({ engine: ENGINE, profile, log: () => {} });
  try {
    assert.equal(second.port, driver.port, 'the second reader joined a different browser');

    const mine = driver.context.pages()[0];
    const held = await driver.targetIdFor(mine);

    // What the joining reader is told to leave alone, recorded as another live
    // session would record it.
    fs.writeFileSync(claimsPath(second.port), JSON.stringify([
      { pid: process.ppid, targetId: held, at: Date.now() },
    ]));
    const taken = claimedTargets(second.port);
    assert.equal(taken.has(held), true);

    // It opens its own instead, and the two readers drive their own tabs.
    const theirs = await second.context.newPage();
    const theirId = await second.targetIdFor(theirs);
    assert.equal(taken.has(theirId), false, 'the joining reader took a tab that was spoken for');

    await mine.goto('data:text/html,<title>mine</title><h1>mine</h1>', { waitUntil: 'load' });
    await theirs.goto('data:text/html,<title>theirs</title><h1>theirs</h1>', { waitUntil: 'load' });
    assert.equal(await mine.mainFrame().evaluate(() => document.title), 'mine');
    assert.equal(await theirs.mainFrame().evaluate(() => document.title), 'theirs');

    // And one leaving leaves the other reading.
    await second.close();
    assert.equal(await mine.mainFrame().evaluate(() => document.title), 'mine',
      'a reader lost its browser when another reader quit');
  } finally {
    await second.close().catch(() => {});
  }
});
