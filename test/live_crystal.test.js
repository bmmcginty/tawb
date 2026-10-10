'use strict';

// The live-update decision is buffer policy, not browser mechanism. Hold the
// Crystal port against the JavaScript original at every boundary that decides
// whether a page may replace the buffer under someone who is reading it.

const test = require('node:test');
const assert = require('node:assert');
const live = require('../src/live');
const { liveImplementations } = require('./crystal_impl');

const implementations = liveImplementations(live);

for (const implementation of implementations) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('a new live state starts clean and enabled', () => {
    assert.deepEqual(implementation.createLiveState(), {
      enabled: true,
      dirty: false,
      refreshing: false,
      mutations: 0,
      notifies: 0,
      refreshes: 0,
      lastRefreshMs: 0,
      lastInputMs: 0,
      lastPulseMs: 0,
      print: null,
      href: null,
      navigated: false,
      snapshotCostMs: 0,
      ticker: null,
      queue: [],
    });
  });

  check('disabled, clean, and in-flight buffers do not refresh', () => {
    const base = { ...implementation.createLiveState(), dirty: true };
    assert.equal(implementation.refreshDue({ ...base, enabled: false }, 10000), false);
    assert.equal(implementation.refreshDue({ ...base, dirty: false }, 10000), false);
    assert.equal(implementation.refreshDue({ ...base, refreshing: true }, 10000), false);
  });

  check('input freezes replacement until the whole grace period has elapsed', () => {
    const state = {
      ...implementation.createLiveState(), dirty: true,
      lastInputMs: 8000, lastRefreshMs: 0,
    };
    assert.equal(implementation.refreshDue(state, 10499), false);
    assert.equal(implementation.refreshDue(state, 10500), true);
  });

  check('the measured snapshot cost sets the refresh duty cycle', () => {
    const state = {
      ...implementation.createLiveState(), dirty: true,
      snapshotCostMs: 1300, lastInputMs: 0, lastRefreshMs: 4000,
    };
    assert.equal(implementation.refreshDue(state, 10499), false);
    assert.equal(implementation.refreshDue(state, 10500), true);
  });

  check('an unknown snapshot cost uses the conservative fallback', () => {
    const state = {
      ...implementation.createLiveState(), dirty: true,
      snapshotCostMs: 0, lastInputMs: 0, lastRefreshMs: 10000,
    };
    assert.equal(implementation.refreshDue(state, 11999), false);
    assert.equal(implementation.refreshDue(state, 12000), true);
  });

  check('navigation bypasses both the reading freeze and throttle', () => {
    const state = {
      ...implementation.createLiveState(), dirty: true, navigated: true,
      lastInputMs: 9999, lastRefreshMs: 9999, snapshotCostMs: 5000,
    };
    assert.equal(implementation.refreshDue(state, 10000), true);
  });

  check('mutation batches preserve announcements and only safe text patches', () => {
    const patch = { from: '10:00', to: '10:01' };
    const observed = implementation.scenario([
      { op: 'classify', payload: null },
      { op: 'notifies' },
      { op: 'classify', payload: {
        announcements: [{ politeness: 'polite', text: 'Three results' }],
        pureText: true, patches: [patch], mutations: 2,
      } },
      { op: 'refreshing', value: true },
      { op: 'classify', payload: { pureText: true, patches: [patch], mutations: 1 } },
      { op: 'enabled', value: false },
      { op: 'classify', payload: {
        announcements: [{ politeness: 'assertive', text: 'Error' }], mutations: 3,
      } },
      { op: 'notifies' },
    ]);
    assert.deepEqual(observed, [
      { announcements: [], patches: null },
      0,
      {
        announcements: [{ politeness: 'polite', text: 'Three results' }],
        patches: [patch], mutations: 2,
      },
      null,
      { announcements: [], patches: null, mutations: 1 },
      null,
      { announcements: [], patches: null },
      3,
    ]);
  });

  check('the reading signal uses the same grace boundary', () => {
    assert.deepEqual(implementation.scenario([
      { op: 'mark_input', now: 1000 },
      { op: 'reading', now: 3499 },
      { op: 'reading', now: 3500 },
    ]), [null, true, false]);
  });
}

if (implementations.length > 1) {
  test('both runtimes agree on live refresh policy', () => {
    const states = [
      { dirty: true, lastInputMs: 9000, lastRefreshMs: 0, snapshotCostMs: 0 },
      { dirty: true, lastInputMs: 0, lastRefreshMs: 9000, snapshotCostMs: 100 },
      { dirty: true, navigated: true, lastInputMs: 9999, lastRefreshMs: 9999 },
      { dirty: false, navigated: true },
    ];
    for (const partial of states) {
      const base = { ...implementations[0].createLiveState(), ...partial };
      assert.equal(implementations[1].refreshDue(base, 10000),
        implementations[0].refreshDue(base, 10000));
    }
  });
}
