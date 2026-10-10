'use strict';

// The live-update decision is buffer policy, not browser mechanism. Hold the
// Crystal port against the JavaScript original at every boundary that decides
// whether a page may replace the buffer under someone who is reading it.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const live = require('../src/live');
const { acceptWebSocket } = require('../src/broker');
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

  test('Crystal installs, drains, pulses, and re-arms live page observers', async () => {
    const crystal = implementations.find((implementation) => implementation.watcherScenario);
    const server = http.createServer();
    const sockets = new Set();
    const traffic = [];
    let pulse = 0;
    const remote = (value) => {
      if (value === undefined) return { type: 'undefined' };
      if (value === null) return { type: 'null' };
      if (typeof value === 'boolean') return { type: 'boolean', value };
      if (typeof value === 'number') return { type: 'number', value };
      if (typeof value === 'string') return { type: 'string', value };
      if (Array.isArray(value)) return { type: 'array', value: value.map(remote) };
      return { type: 'object', value: Object.entries(value).map(([key, item]) => [key, remote(item)]) };
    };
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      let peer;
      peer = acceptWebSocket(request, socket, (text) => {
        const message = JSON.parse(text);
        const { method, params = {} } = message;
        traffic.push({ method, context: params.target?.context || null });
        let result = {};
        if (method === 'browsingContext.getTree') {
          result = { contexts: [{ context: 'main', url: 'https://example.test/', children: [
            { context: 'child', url: 'https://frame.test/', children: [] },
          ] }] };
        } else if (method === 'script.callFunction') {
          const declaration = params.functionDeclaration;
          if (declaration.includes("Symbol.for('tweb.queue')")) {
            result = { result: remote(params.target.context === 'main'
              ? [{ announcements: [], mutations: 1, patches: [], pureText: false }]
              : [{ announcements: [{ politeness: 'polite', text: 'ready' }], mutations: 1 }]) };
          } else if (declaration.includes('observing:')) {
            pulse += 1;
            result = { result: remote({
              observing: pulse > 1,
              href: pulse > 1 ? 'https://example.test/next' : 'https://example.test/',
              print: `${pulse}|page`,
            }) };
          } else {
            result = { result: remote(undefined) };
          }
        }
        peer.send(JSON.stringify({ id: message.id, type: 'success', result }));
      }, () => {});
      if (head.length) peer.consume(head);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const observed = await crystal.watcherScenario(`ws://127.0.0.1:${port}/session`, [
        { op: 'install' },
        { op: 'arm_rendered', contexts: ['child'] },
        { op: 'collect' },
        { op: 'pulse', now: 1000 },
        { op: 'pulse', now: 1500 },
        { op: 'pulse', now: 2000 },
        { op: 'state' },
      ]);
      assert.deepEqual(observed.slice(0, 6), [
        { boundNow: true, armed: 1, frames: 2 },
        1,
        [
          { announcements: [], mutations: 1, patches: [], pureText: false },
          { announcements: [{ politeness: 'polite', text: 'ready' }], mutations: 1 },
        ],
        { changed: false, navigated: false, rearmed: true },
        null,
        { changed: true, navigated: true, rearmed: false },
      ]);
      assert.equal(observed[6].dirty, true);
      assert.equal(observed[6].navigated, true);
      assert.deepEqual(traffic.map(({ method }) => method), [
        'script.addPreloadScript', 'script.callFunction', 'browsingContext.getTree',
        'script.callFunction', 'browsingContext.getTree', 'script.callFunction',
        'script.callFunction', 'script.callFunction', 'script.callFunction',
        'script.callFunction',
      ]);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
