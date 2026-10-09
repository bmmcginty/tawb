'use strict';

// The Crystal broker, against a browser that is only a socket.
//
// test/broker.test.js pins the JavaScript multiplexer's behaviour; these run
// the same conversations against the native one. Each scenario is one
// conformance call: the broker and its readers live in the broker process,
// while the fake browser on the far side of the upstream URL is driven by the
// test — it answers every command and emits what each test asks it to. What a
// real Firefox does with those messages is tested where there is a real
// Firefox.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { acceptWebSocket, RETAIN_SESSION } = require('../src/broker');
const { call, callAsync } = require('./crystal_impl');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

check('the WebSocket handshake answers with the accept a browser would check', () => {
  const key = crypto.randomBytes(16).toString('base64');
  const accept = call('broker.handshake_accept', { key });
  const expected = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.equal(accept, expected);
});

// A browser that speaks BiDi's shape and nothing else.
async function fakeBrowser(onMessage) {
  let peer = null;
  const commands = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    peer = acceptWebSocket(req, socket, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      if (onMessage(message, peer) !== false) {
        peer.send(JSON.stringify({ type: 'success', id: message.id, result: { echo: message.method } }));
      }
    }, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/session`,
    commands,
    // The browser going away under the broker, which is not the same as
    // closing the listener: an accepted connection outlives that.
    drop() {
      try { peer.socket.end(); } catch { /* already gone */ }
      try { peer.socket.destroy(); } catch { /* already gone */ }
      server.close();
    },
    close() { server.close(); },
  };
}

async function runScenario(browser, steps, extra = {}) {
  return callAsync('broker.scenario', {
    upstream: browser.url,
    steps,
    idle_ms: 5000,
    grace_ms: 30000,
    ...extra,
  });
}

check('a reply comes back wearing the id the reader sent', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' }, { type: 'reader' },
      { type: 'send', reader: 0, id: 7, method: 'browsingContext.getTree' },
      { type: 'wait', reader: 0, id: 7 },
      { type: 'send', reader: 1, id: 7, method: 'script.evaluate' },
      { type: 'wait', reader: 1, id: 7 },
      { type: 'stop', end_session: false },
    ]);
    const first = result.readers[0].find((m) => m.id === 7);
    const second = result.readers[1].find((m) => m.id === 7);
    assert.equal(first.result.echo, 'browsingContext.getTree', "a reader got another reader's reply");
    assert.equal(second.result.echo, 'script.evaluate');
    const ids = browser.commands.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'two readers using id 7 collided on the way out');
  } finally {
    browser.close();
  }
});

check('the browser is asked for a session once, however many readers ask', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'session.status' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 0, id: 2, method: 'session.new' },
      { type: 'wait', reader: 0, id: 2 },
      { type: 'reader' },
      { type: 'send', reader: 1, id: 2, method: 'session.new' },
      { type: 'wait', reader: 1, id: 2 },
      { type: 'stop', end_session: false },
    ]);
    const status = result.readers[0].find((m) => m.id === 1);
    assert.deepEqual(status.result, { ready: true, message: '' }, 'a joining reader was told to go away');
    const created = result.readers[0].find((m) => m.id === 2);
    const replayed = result.readers[1].find((m) => m.id === 2);
    assert.equal(created.result.capabilities['tawb:brokerSession'], 'created');
    assert.equal(replayed.result.capabilities['tawb:brokerSession'], 'replayed');
    assert.equal(browser.commands.filter((c) => c.method === 'session.new').length, 1,
      'the second reader asked Firefox for a second session');
    assert.equal(browser.commands.some((c) => c.method === 'session.status'), false,
      'session.status was forwarded, and Firefox would have said no');
  } finally {
    browser.close();
  }
});

check('one reader leaving does not end the session the others are sharing', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' }, { type: 'reader' },
      { type: 'send', reader: 0, id: 3, method: 'session.end' },
      { type: 'wait', reader: 0, id: 3 },
      { type: 'close', reader: 1 },
      { type: 'sleep', ms: 200 },
      { type: 'send', reader: 0, id: 4, method: 'session.end' },
      { type: 'wait', reader: 0, id: 4 },
      { type: 'sleep', ms: 200 },
      { type: 'stop', end_session: false },
    ]);
    assert.ok(result.readers[0].some((m) => m.id === 3 && m.type === 'success'),
      'a leaving reader was left without an answer');
    assert.equal(browser.commands.filter((c) => c.method === 'session.end').length, 1,
      'every reader ended the shared session upstream');
  } finally {
    browser.close();
  }
});

check('a reader arriving after the last one left gets a session, not a stale yes', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'session.new' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 0, id: 2, method: 'session.end' },
      { type: 'wait', reader: 0, id: 2 },
      { type: 'close', reader: 0 },
      { type: 'sleep', ms: 200 },
      { type: 'reader' },
      { type: 'send', reader: 1, id: 1, method: 'session.new' },
      { type: 'wait', reader: 1, id: 1 },
      { type: 'stop', end_session: false },
    ]);
    assert.equal(browser.commands.filter((c) => c.method === 'session.new').length, 2,
      'the new reader was handed the session that had just ended');
  } finally {
    browser.close();
  }
});

check('an event reaches the readers that asked for it, and no others', async () => {
  const browser = await fakeBrowser((message, peer) => {
    if (message.method === 'session.subscribe'
        && message.params.events.includes('browsingContext.load')) {
      peer.send(JSON.stringify({ method: 'browsingContext.load', params: { context: 'tab-1' } }));
    }
    return true;
  });
  try {
    const result = await runScenario(browser, [
      { type: 'reader' }, { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'session.subscribe',
        params: { events: ['browsingContext.load'] } },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 1, id: 1, method: 'session.subscribe',
        params: { events: ['other.event'] } },
      { type: 'wait', reader: 1, id: 1 },
      { type: 'sleep', ms: 200 },
      { type: 'stop', end_session: false },
    ]);
    assert.ok(result.readers[0].some((m) => m.method === 'browsingContext.load'),
      'the subscribing reader never heard the event');
    assert.equal(result.readers[1].some((m) => m.method === 'browsingContext.load'), false,
      'a reader was told about an event it never asked for');
  } finally {
    browser.close();
  }
});

check('a password challenge goes to the reader who is at the keyboard', async () => {
  const browser = await fakeBrowser((message, peer) => {
    if (message.method === 'browsingContext.navigate') {
      peer.send(JSON.stringify({
        method: 'network.authRequired', params: { request: { request: 'req-1' } },
      }));
    }
    return true;
  });
  try {
    const result = await runScenario(browser, [
      { type: 'reader' }, { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'session.subscribe',
        params: { events: ['network.authRequired'] } },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 1, id: 1, method: 'session.subscribe',
        params: { events: ['network.authRequired'] } },
      { type: 'wait', reader: 1, id: 1 },
      // Reader one asked for something more recently than reader two did.
      { type: 'send', reader: 1, id: 2, method: 'script.evaluate' },
      { type: 'wait', reader: 1, id: 2 },
      { type: 'send', reader: 0, id: 2, method: 'browsingContext.navigate' },
      { type: 'wait', reader: 0, id: 2 },
      { type: 'sleep', ms: 200 },
      { type: 'stop', end_session: false },
    ]);
    assert.ok(result.readers[0].some((m) => m.method === 'network.authRequired'),
      'the reader at the keyboard never saw the challenge');
    assert.equal(result.readers[1].some((m) => m.method === 'network.authRequired'), false,
      'the same prompt was put in front of two readers');
  } finally {
    browser.close();
  }
});

check('a challenge nobody is listening for is cancelled rather than left paused', async () => {
  const browser = await fakeBrowser((message, peer) => {
    if (message.method === 'browsingContext.getTree') {
      peer.send(JSON.stringify({
        method: 'network.authRequired', params: { request: { request: 'req-9' } },
      }));
    }
    return true;
  });
  try {
    await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'browsingContext.getTree' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'sleep', ms: 300 },
      { type: 'stop', end_session: false },
    ]);
    const cancelled = browser.commands.find((c) => c.method === 'network.continueWithAuth');
    assert.ok(cancelled, 'the request was left paused with nobody to answer it');
    assert.deepEqual(cancelled.params, { request: 'req-9', action: 'cancel' });
  } finally {
    browser.close();
  }
});

check('a retained session waits in the broker for the next reader', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'session.new' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 0, id: 2, method: RETAIN_SESSION },
      { type: 'wait', reader: 0, id: 2 },
      { type: 'close', reader: 0 },
      { type: 'sleep', ms: 300 },
      { type: 'reasons' },
      { type: 'reader' },
      { type: 'send', reader: 1, id: 1, method: 'session.new' },
      { type: 'wait', reader: 1, id: 1 },
      { type: 'stop', end_session: false },
    ], { idle_ms: 50 });
    const kept = result.timeline.find((entry) => entry.reasons);
    assert.deepEqual(kept.reasons, [], 'the broker discarded a deliberately kept session');
    const replayed = result.readers[1].find((m) => m.id === 1);
    assert.equal(replayed.result.capabilities['tawb:brokerSession'], 'replayed');
    assert.equal(browser.commands.some((c) => c.method === RETAIN_SESSION), false,
      'the broker exposed its private command to Firefox');
    assert.equal(browser.commands.some((c) => c.method === 'session.end'), false,
      'retaining the session ended it upstream');
    assert.equal(browser.commands.filter((c) => c.method === 'session.new').length, 1,
      'the joining reader replaced rather than reused the retained session');
  } finally {
    browser.close();
  }
});

check('the broker gives up when the last reader has gone', async () => {
  const browser = await fakeBrowser(() => true);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'browsingContext.getTree' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'clients' },
      { type: 'close', reader: 0 },
      { type: 'sleep', ms: 300 },
      { type: 'reasons' },
      { type: 'stop', end_session: false },
    ], { idle_ms: 50 });
    const counted = result.timeline.find((entry) => entry.clients !== undefined);
    assert.equal(counted.clients, 1, 'it gave up while somebody was still reading');
    const observed = result.timeline.find((entry) => entry.reasons);
    assert.deepEqual(observed.reasons, ['idle'], 'it stayed running with nobody reading');
    assert.deepEqual(result.reasons, ['idle'], 'the last reader leaving is not an idle broker');
  } finally {
    browser.close();
  }
});

check('a browser that goes takes the broker with it, readers or no readers', async () => {
  // The distinction matters because the broker is given a reprieve when it is
  // only idle: a reader arriving in that moment cancels the departure. A
  // broker with no browser must not take that reprieve. It can serve nobody,
  // and staying to be found again hands the next reader a broker that answers
  // nothing — a session.new waiting out its whole timeout against a socket
  // that is never coming back.
  let browser = null;
  const handle = (message) => {
    if (message.method === 'script.evaluate') {
      // The browser goes while a reader is still connected, after that reader
      // has seen its previous reply.
      setTimeout(() => browser.drop(), 50);
      return false;
    }
    return true;
  };
  browser = await fakeBrowser(handle);
  try {
    const result = await runScenario(browser, [
      { type: 'reader' },
      { type: 'send', reader: 0, id: 1, method: 'browsingContext.getTree' },
      { type: 'wait', reader: 0, id: 1 },
      { type: 'send', reader: 0, id: 2, method: 'script.evaluate' },
      { type: 'sleep', ms: 500 },
      { type: 'reasons' },
      { type: 'stop', end_session: false },
    ], { idle_ms: 50000 });
    const observed = result.timeline.find((entry) => entry.reasons);
    assert.deepEqual(observed.reasons, ['browser-gone'],
      'losing the browser was reported as an ordinary idle broker');
  } finally {
    browser.close();
  }
});
