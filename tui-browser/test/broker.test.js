'use strict';

// The broker, against a browser that is only a socket.
//
// Everything here is about what the broker does with messages, so the browser
// on the other end is a WebSocket that records what it was sent and answers
// what the test tells it to. What a real Firefox does with those messages is
// tested in test/browser/tabs.test.js, where there is a real Firefox.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { startBroker, acceptWebSocket } = require('../src/broker');

// A browser that speaks BiDi's shape and nothing else.
async function fakeBrowser() {
  const commands = [];
  let peer = null;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    peer = acceptWebSocket(req, socket, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      // Every command is answered, so the reader is never left waiting.
      peer.send(JSON.stringify({ type: 'success', id: message.id, result: { echo: message.method } }));
    }, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/session`,
    commands,
    // An event, which carries no id and belongs to whoever subscribed.
    emit(event) { peer.send(JSON.stringify(event)); },
    close() { server.close(); },
  };
}

// A reader: a WebSocket that sends commands and remembers what came back.
async function reader(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiters = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    messages.push(message);
    for (const [index, waiter] of waiters.entries()) {
      if (waiter.match(message)) { waiters.splice(index, 1); waiter.resolve(message); break; }
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return {
    socket,
    messages,
    send(id, method, params = {}) { socket.send(JSON.stringify({ id, method, params })); },
    // Waits for the first message this reader receives that matches.
    until(match) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    close() { socket.close(); },
  };
}

async function brokerOn(browser, options = {}) {
  const broker = startBroker({ upstream: browser.url, port: 0, ...options });
  const port = await broker.listening;
  return { broker, url: `ws://127.0.0.1:${port}/session` };
}

test('a reply comes back wearing the id the reader sent', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  const two = await reader(url);
  try {
    one.send(7, 'browsingContext.getTree');
    two.send(7, 'script.evaluate');
    const first = await one.until((m) => m.id === 7);
    const second = await two.until((m) => m.id === 7);

    assert.equal(first.result.echo, 'browsingContext.getTree', 'a reader got another reader\'s reply');
    assert.equal(second.result.echo, 'script.evaluate');
    const ids = browser.commands.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, 'two readers using id 7 collided on the way out');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('the browser is asked for a session once, however many readers ask', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  try {
    one.send(1, 'session.status');
    const status = await one.until((m) => m.id === 1);
    assert.deepEqual(status.result, { ready: true, message: '' }, 'a joining reader was told to go away');

    one.send(2, 'session.new');
    await one.until((m) => m.id === 2);
    const two = await reader(url);
    two.send(2, 'session.new');
    await two.until((m) => m.id === 2);

    const asked = browser.commands.filter((c) => c.method === 'session.new');
    assert.equal(asked.length, 1, 'the second reader asked Firefox for a second session');
    assert.equal(browser.commands.some((c) => c.method === 'session.status'), false,
      'session.status was forwarded, and Firefox would have said no');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('one reader leaving does not end the session the others are sharing', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  const two = await reader(url);
  try {
    one.send(3, 'session.end');
    await one.until((m) => m.id === 3);
    assert.equal(browser.commands.some((c) => c.method === 'session.end'), false,
      'a leaving reader took the session from the one still reading');

    two.close();
    await new Promise((r) => setTimeout(r, 100));
    one.send(4, 'session.end');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(browser.commands.some((c) => c.method === 'session.end'), true,
      'the last reader out left the session behind');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('a reader arriving after the last one left gets a session, not a stale yes', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  try {
    one.send(1, 'session.new');
    await one.until((m) => m.id === 1);
    one.send(2, 'session.end');
    await new Promise((r) => setTimeout(r, 100));
    one.close();
    await new Promise((r) => setTimeout(r, 50));

    const two = await reader(url);
    two.send(1, 'session.new');
    await two.until((m) => m.id === 1);
    const asked = browser.commands.filter((c) => c.method === 'session.new');
    assert.equal(asked.length, 2, 'the new reader was handed the session that had just ended');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('an event reaches the readers that asked for it, and no others', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const listening = await reader(url);
  const quiet = await reader(url);
  try {
    listening.send(1, 'session.subscribe', { events: ['browsingContext.load'] });
    await listening.until((m) => m.id === 1);
    browser.emit({ method: 'browsingContext.load', params: { context: 'tab-1' } });
    await listening.until((m) => m.method === 'browsingContext.load');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(quiet.messages.some((m) => m.method === 'browsingContext.load'), false,
      'a reader was told about an event it never asked for');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('a password challenge goes to the reader who is at the keyboard', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  const two = await reader(url);
  try {
    for (const who of [one, two]) {
      who.send(1, 'session.subscribe', { events: ['network.authRequired'] });
      await who.until((m) => m.id === 1);
    }
    // Reader one asked for something more recently than reader two did.
    two.send(2, 'script.evaluate');
    await two.until((m) => m.id === 2);
    await new Promise((r) => setTimeout(r, 5));
    one.send(2, 'browsingContext.navigate');
    await one.until((m) => m.id === 2);

    browser.emit({ method: 'network.authRequired', params: { request: { request: 'req-1' } } });
    await one.until((m) => m.method === 'network.authRequired');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(two.messages.some((m) => m.method === 'network.authRequired'), false,
      'the same prompt was put in front of two readers');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('a challenge nobody is listening for is cancelled rather than left paused', async () => {
  const browser = await fakeBrowser();
  const { broker, url } = await brokerOn(browser);
  const one = await reader(url);
  try {
    one.send(1, 'browsingContext.getTree');
    await one.until((m) => m.id === 1);
    browser.emit({ method: 'network.authRequired', params: { request: { request: 'req-9' } } });
    await new Promise((r) => setTimeout(r, 150));
    const cancelled = browser.commands.find((c) => c.method === 'network.continueWithAuth');
    assert.ok(cancelled, 'the request was left paused with nobody to answer it');
    assert.deepEqual(cancelled.params, { request: 'req-9', action: 'cancel' });
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});

test('the broker gives up when the last reader has gone', async () => {
  const browser = await fakeBrowser();
  let idle = false;
  const { broker, url } = await brokerOn(browser, { idleMs: 50, onIdle: () => { idle = true; } });
  const one = await reader(url);
  try {
    one.send(1, 'browsingContext.getTree');
    await one.until((m) => m.id === 1);
    assert.equal(idle, false, 'it gave up while somebody was still reading');
    one.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(idle, true, 'it stayed running with nobody reading');
  } finally {
    await broker.close({ endSession: false });
    browser.close();
  }
});
