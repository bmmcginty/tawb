'use strict';

// The broker as a process: found or started, claimed once, and gone when its
// reason is. The multiplexer's message behaviour is pinned in
// test/broker_crystal.test.js; this pins how a reader finds a broker — the
// same binary, restarted in a private dispatch mode — and what that reader
// leaves behind.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { acceptWebSocket } = require('../src/broker');
const { call, callAsync } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const check = (name, fn) => test(`Crystal: ${name}`, { skip: !enabled }, fn);

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

async function stopBroker(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await waitFor(() => !alive(pid), 5000);
}

// A browser that speaks BiDi's shape and answers everything.
async function fakeBrowser() {
  let peer = null;
  const commands = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    peer = acceptWebSocket(req, socket, (text) => {
      const message = JSON.parse(text);
      commands.push(message);
      peer.send(JSON.stringify({ type: 'success', id: message.id, result: { echo: message.method } }));
    }, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}/session`,
    commands,
    drop() {
      try { peer.socket.end(); } catch { /* already gone */ }
      try { peer.socket.destroy(); } catch { /* already gone */ }
      server.close();
    },
    close() { server.close(); },
  };
}

async function reader(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  return {
    socket,
    messages,
    send(id, method, params = {}) { socket.send(JSON.stringify({ id, method, params })); },
    until(match, timeout = 5000) {
      const found = messages.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const hit = messages.find(match);
          if (hit) { clearInterval(timer); resolve(hit); }
          else if (Date.now() - started > timeout) {
            clearInterval(timer);
            reject(new Error('the broker never answered'));
          }
        }, 25);
      });
    },
    close() { socket.close(); },
  };
}

async function recordedPid(profile) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile, BROKER_FILE), 'utf8')).pid;
  } catch {
    return null;
  }
}

// A port that is certainly closed right now.
async function closedPort() {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

check('a broker record is claimed once, read back, and cleared', () => {
  const profile = tempDir('tweb-broker-record-');
  try {
    const record = { pid: process.pid, port: 47001, upstream: 'ws://127.0.0.1:1/session', at: 1 };
    assert.equal(call('broker.claim', { profile, record }), true);
    assert.equal(call('broker.claim', { profile, record: { ...record, pid: 2 } }), false,
      'a second starter took the browser from the first');
    assert.deepEqual(call('broker.read', { profile }), record);
    call('broker.clear', { profile });
    assert.equal(call('broker.read', { profile }), null);
  } finally {
    removeTempDir(profile);
  }
});

check('a reader joins the broker another reader started', async () => {
  const profile = tempDir('tweb-broker-join-');
  const browser = await fakeBrowser();
  try {
    const first = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    const second = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    assert.equal(second.port, first.port, 'the second reader started a second broker');
    assert.equal(second.pid, first.pid);
    assert.equal(second.url, `ws://127.0.0.1:${first.port}/session`);

    // The started broker is the same executable, serving readers as itself.
    const one = await reader(second.url);
    one.send(5, 'browsingContext.getTree');
    const reply = await one.until((m) => m.id === 5);
    assert.equal(reply.result.echo, 'browsingContext.getTree');
    one.close();
  } finally {
    const pid = await recordedPid(profile);
    if (pid) await stopBroker(pid);
    browser.close();
    removeTempDir(profile);
  }
});

check('two readers starting at once share one broker', async () => {
  const profile = tempDir('tweb-broker-race-');
  const browser = await fakeBrowser();
  try {
    const [one, two] = await Promise.all([
      callAsync('broker.ensure_scenario', { profile, upstream: browser.url }),
      callAsync('broker.ensure_scenario', { profile, upstream: browser.url }),
    ]);
    assert.equal(one.port, two.port, 'each starter ran a broker of its own');
    const pid = await recordedPid(profile);
    assert.notEqual(pid, null);
    assert.equal(alive(pid), true);
  } finally {
    const pid = await recordedPid(profile);
    if (pid) await stopBroker(pid);
    browser.close();
    removeTempDir(profile);
  }
});

check('a stale broker record is replaced by a working broker', async () => {
  const profile = tempDir('tweb-broker-stale-');
  const browser = await fakeBrowser();
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  try {
    const stale = await closedPort();
    fs.writeFileSync(path.join(profile, BROKER_FILE), JSON.stringify({
      pid: dead.pid, port: stale, upstream: browser.url, at: 1,
    }));
    const made = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    assert.notEqual(made.port, stale, 'the stale record was joined instead of replaced');
    const record = JSON.parse(fs.readFileSync(path.join(profile, BROKER_FILE), 'utf8'));
    assert.equal(record.pid, made.pid);
    assert.equal(alive(record.pid), true);
  } finally {
    const pid = await recordedPid(profile);
    if (pid) await stopBroker(pid);
    browser.close();
    removeTempDir(profile);
  }
});

check('an idle broker leaves with its record', async () => {
  const profile = tempDir('tweb-broker-idle-');
  const browser = await fakeBrowser();
  try {
    const made = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    const one = await reader(made.url);
    one.send(1, 'session.status');
    await one.until((m) => m.id === 1);
    one.close();
    const gone = await waitFor(() => !alive(made.pid));
    assert.equal(gone, true, 'the broker stayed running with nobody reading');
    assert.equal(fs.existsSync(path.join(profile, BROKER_FILE)), false,
      'the record outlived the broker that wrote it');
  } finally {
    await stopBroker(await recordedPid(profile));
    browser.close();
    removeTempDir(profile);
  }
});

check('a browser that goes takes the running broker with it', async () => {
  const profile = tempDir('tweb-browser-gone-');
  const browser = await fakeBrowser();
  try {
    const made = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    const one = await reader(made.url);
    one.send(1, 'browsingContext.getTree');
    await one.until((m) => m.id === 1);
    // The browser goes while a reader is still connected.
    browser.drop();
    const gone = await waitFor(() => !alive(made.pid));
    assert.equal(gone, true, 'the broker outlived the browser it could not serve');
    assert.equal(fs.existsSync(path.join(profile, BROKER_FILE)), false,
      'the next reader would be handed a broker that answers nothing');
  } finally {
    await stopBroker(await recordedPid(profile));
    browser.close();
    removeTempDir(profile);
  }
});

check('a reader arriving in the parting gap keeps the broker', async () => {
  const profile = tempDir('tweb-broker-reprieve-');
  const browser = await fakeBrowser();
  try {
    const made = await callAsync('broker.ensure_scenario', { profile, upstream: browser.url });
    const one = await reader(made.url);
    one.send(1, 'session.status');
    await one.until((m) => m.id === 1);
    one.close();
    const recordGone = await waitFor(
      () => !fs.existsSync(path.join(profile, BROKER_FILE)), 12000, 10,
    );
    assert.equal(recordGone, true, 'the broker never decided to leave');

    // Inside the 250ms before it acts on that decision, somebody arrives.
    const two = await reader(made.url);
    two.send(2, 'session.status');
    await two.until((m) => m.id === 2);
    const back = await waitFor(() => fs.existsSync(path.join(profile, BROKER_FILE)), 5000);
    assert.equal(back, true, 'the arriving reader was left with no broker to find');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(alive(made.pid), true, 'the broker left anyway');
  } finally {
    await stopBroker(await recordedPid(profile));
    browser.close();
    removeTempDir(profile);
  }
});
