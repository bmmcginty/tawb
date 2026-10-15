'use strict';

// The native Firefox dump, against a browser that is only a socket.
//
// Everything the reader does around the page — finding or starting the
// broker, starting the session, proving the automation announcement is gone,
// reading the page through the shared extractor, and leaving the browser the
// way it found it — is exercised here with the real executable. What a real
// Firefox renders for a real page is tested where there is a real Firefox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { acceptWebSocket, RETAIN_SESSION } = require('../src/broker');
const { callAsync } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

const ENDPOINT_FILE = 'tawb-endpoint.json';
const BROKER_FILE = 'tawb-broker.json';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitFor(predicate, timeout = 12000, every = 40) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

async function stopBroker(profile) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(path.join(profile, BROKER_FILE), 'utf8'));
    if (alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      await waitFor(() => !alive(pid), 5000);
    }
  } catch {
    // no broker to stop
  }
}

// A Firefox that speaks BiDi's shape, answers every command, and records what
// it was asked — so the test can see the session, the probe, the navigation,
// the extraction, and how the reader left.
async function fakeFirefox({ status = null, webdriver = false, vanishFirstCommand = false } = {}) {
  let peer = null;
  const commands = [];
  let connections = 0;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    connections += 1;
    const vanishing = vanishFirstCommand && connections === 1;
    peer = acceptWebSocket(req, socket, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      if (vanishing) {
        // The browser goes with the command still outstanding and no reply
        // coming. This is what a broker dying mid-command looks like from the
        // reader's side: the connection it was reading over closes under it.
        try { socket.end(); } catch { /* already gone */ }
        try { socket.destroy(); } catch { /* already gone */ }
        return;
      }
      let answer = null;
      switch (message.method) {
        case 'session.status':
          answer = status || { ready: true, message: '' };
          break;
        case 'session.new':
          answer = { sessionId: 'session-1', capabilities: { browserName: 'firefox' } };
          break;
        case 'script.evaluate':
          // Real BiDi wraps the value: {result: <remote value>, realm}.
          answer = {
            realm: 'realm-1',
            result: {
              type: 'object',
              value: [
                ['readyState', { type: 'string', value: 'complete' }],
                ['webdriver', { type: 'boolean', value: webdriver }],
              ],
            },
          };
          break;
        case 'browsingContext.navigate':
          answer = { navigation: 'navigation-1', url: message.params.url };
          break;
        case 'browsingContext.getTree':
          answer = message.params.root
            ? {
                contexts: [{
                  context: 'top-context',
                  url: 'https://example.test/final',
                  children: [],
                }],
              }
            : { contexts: [{ context: 'top-context', url: 'about:blank', children: [] }] };
          break;
        case 'script.callFunction':
          // Real BiDi wraps the value: {result: <remote value>, realm}.
          answer = {
            realm: 'realm-1',
            result: {
              type: 'array',
              value: [{
                type: 'object',
                value: [
                  ['role', { type: 'string', value: 'paragraph' }],
                  ['name', { type: 'string', value: 'Hello' }],
                ],
              }],
            },
          };
          break;
        default:
          answer = {};
      }
      peer.send(JSON.stringify({ id: message.id, type: 'success', result: answer }));
    }, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/session`,
    commands,
    close() { server.close(); },
  };
}

// Marionette, as far as a stranded-session release can tell the difference:
// a knock that is answered proves the session was released through it.
async function fakeMarionette() {
  const knocks = [];
  const sockets = new Set();
  const packet = (value) => Buffer.concat([
    Buffer.from(`${Buffer.byteLength(JSON.stringify(value))}:`), Buffer.from(JSON.stringify(value)),
  ]);
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.write(packet({ applicationType: 'gecko', marionetteProtocol: 3 }));
    knocks.push(1);
    socket.on('data', () => { socket.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    knocks: () => knocks.length,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function dump(profile, browser, options = {}) {
  return callAsync('firefox.dump_scenario', {
    upstream: browser.url,
    profile,
    marionette_port: options.marionettePort ?? null,
    library_port: options.libraryPort ?? null,
    owned: options.owned ?? false,
    keep_browser: options.keepBrowser ?? false,
    brokered: options.brokered ?? true,
    target: 'https://example.test/start',
    layout: options.layout ?? false,
  });
}

check('a brokered dump reads the page and leaves the browser to the next reader', async () => {
  const profile = tempDir('tweb-ff-dump-');
  const browser = await fakeFirefox();
  try {
    const result = await dump(profile, browser, { owned: true, keepBrowser: true });
    assert.equal(result.text, 'Hello\n');
    assert.equal(result.brokerSession, 'created');
    assert.equal(result.webdriver, false);

    const asked = browser.commands.map((c) => c.method);
    assert.equal(asked.filter((m) => m === 'session.new').length, 1);
    assert.ok(asked.includes('script.evaluate'),
      'the automation announcement was never asked from inside a page');
    assert.ok(asked.includes('browsingContext.navigate'));
    assert.ok(asked.filter((m) => m === 'script.callFunction').length >= 1, 'the page was never read');
    assert.equal(asked.includes(RETAIN_SESSION), false,
      'the broker exposed its private retain command to Firefox');
    assert.equal(asked.includes('session.end'), false,
      'a kept browser lost its one session when the reader left');
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, ENDPOINT_FILE), 'utf8')).readerPid,
      null, 'the reader left without saying the session was free again');
  } finally {
    await stopBroker(profile);
    browser.close();
    removeTempDir(profile);
  }
});

check('a rejoining dump replays the kept session instead of asking again', async () => {
  const profile = tempDir('tweb-ff-dump-rejoin-');
  const browser = await fakeFirefox();
  try {
    await dump(profile, browser, { owned: true, keepBrowser: true });
    const probesBefore = browser.commands.filter((c) => c.method === 'script.evaluate').length;
    const second = await dump(profile, browser, { owned: false, keepBrowser: true });

    assert.equal(second.brokerSession, 'replayed', 'the second reader asked Firefox for a second session');
    assert.equal(second.text, 'Hello\n');
    assert.equal(browser.commands.filter((c) => c.method === 'session.new').length, 1,
      'the rejoined reader replaced rather than reused the retained session');
    const probesAfter = browser.commands.filter((c) => c.method === 'script.evaluate').length;
    assert.equal(probesAfter - probesBefore, 1,
      'a replayed session cleared parent-process state again');
  } finally {
    await stopBroker(profile);
    browser.close();
    removeTempDir(profile);
  }
});

check('a reader whose broker vanishes mid-command retries against its replacement', async () => {
  const profile = tempDir('tweb-ff-dump-vanished-');
  // The first upstream connection answers nothing and then goes, so the
  // reader's session.new fails against a broker that is already leaving.
  const browser = await fakeFirefox({ vanishFirstCommand: true });
  try {
    const result = await dump(profile, browser, { owned: true, keepBrowser: true });
    assert.equal(result.text, 'Hello\n',
      'the reader did not recover from the broker that vanished under it');

    // Once against the broker that left, once against the broker that
    // replaced it. The retry is the reader starting a new broker, not the
    // same one answering late.
    assert.equal(browser.commands.filter((c) => c.method === 'session.new').length, 2,
      'the vanished broker was not replaced by a fresh session');
  } finally {
    await stopBroker(profile);
    browser.close();
    removeTempDir(profile);
  }
});

check('a browser left behind is ended through the broker, not kept in it', async () => {
  const profile = tempDir('tweb-ff-dump-close-');
  const browser = await fakeFirefox();
  try {
    const result = await dump(profile, browser, { owned: true, keepBrowser: false });
    assert.equal(result.text, 'Hello\n');
    assert.equal(browser.commands.some((c) => c.method === 'session.end'), true,
      'a browser the reader owned was left running with a held session');
    assert.equal(browser.commands.some((c) => c.method === RETAIN_SESSION), false,
      'a browser on its way out kept a session nobody will use');

    // The broker keeps no reason to exist once its reader has gone; it
    // leaves, and takes its record with it.
    const gone = await waitFor(() => !fs.existsSync(path.join(profile, BROKER_FILE)));
    assert.equal(gone, true, 'the broker outlived its last reader without a kept session');
  } finally {
    await stopBroker(profile);
    browser.close();
    removeTempDir(profile);
  }
});

check('a direct connection releases the session a dead reader left behind', async () => {
  const profile = tempDir('tweb-ff-dump-direct-');
  const browser = await fakeFirefox({ status: { ready: false, message: '' } });
  const marionette = await fakeMarionette();
  try {
    const result = await dump(profile, browser, {
      brokered: false, marionettePort: marionette.port,
    });

    assert.equal(result.text, 'Hello\n');
    assert.equal(marionette.knocks(), 1, 'Marionette was never asked to release the stranded session');
    const asked = browser.commands.map((c) => c.method);
    assert.equal(asked.includes('session.status'), true,
      'a direct connection never asked whether the session was free');
    assert.equal(asked.filter((m) => m === 'session.new').length, 1);
    assert.equal(asked.includes(RETAIN_SESSION), false,
      'a reader speaking to Firefox directly kept its session in a broker');

    const record = JSON.parse(fs.readFileSync(path.join(profile, ENDPOINT_FILE), 'utf8'));
    assert.equal(record.readerPid, null, 'the reader left without saying the session was free again');
  } finally {
    marionette.close();
    browser.close();
    removeTempDir(profile);
  }
});

check('a live reader holding the session is never knocked out', async () => {
  const profile = tempDir('tweb-ff-dump-live-');
  const browser = await fakeFirefox({ status: { ready: false, message: '' } });
  const marionette = await fakeMarionette();
  fs.writeFileSync(path.join(profile, ENDPOINT_FILE), JSON.stringify({
    port: 1, marionettePort: marionette.port, readerPid: process.pid,
  }));
  try {
    const error = await dump(profile, browser, {
      brokered: false, marionettePort: marionette.port,
    }).then(() => null, (err) => err);

    assert.ok(error, 'a busy browser was read anyway');
    assert.match(error.message, /Another reader \(process \d+\) is already using this Firefox/);
    assert.equal(marionette.knocks(), 0, 'a live reader lost its page');
    assert.equal(browser.commands.some((c) => c.method === 'session.new'), false,
      'the busy browser was asked for a second session');
  } finally {
    marionette.close();
    browser.close();
    removeTempDir(profile);
  }
});

check('a page that answers webdriver true is not read as if it were clean', async () => {
  const profile = tempDir('tweb-ff-dump-announced-');
  const browser = await fakeFirefox({ webdriver: true });
  try {
    const error = await dump(profile, browser, {
      brokered: false, owned: true, keepBrowser: false,
    }).then(() => null, (err) => err);

    assert.ok(error, 'an automated browser produced a dump');
    assert.match(error.message, /still announcing itself as automated/);
    assert.equal(browser.commands.some((c) => c.method === 'browsingContext.navigate'), false,
      'the page was read before the announcement was disproved');
  } finally {
    browser.close();
    removeTempDir(profile);
  }
});
