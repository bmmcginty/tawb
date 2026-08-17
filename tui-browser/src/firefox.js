'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeEndpointRecord, runningEndpoint, waitForEndpoint } = require('./endpoint');

// Getting hold of a Firefox that is not pretending to be a robot.
//
// The same rule applies here as for Chromium: we start an ordinary browser and
// observe it, because a browser that cannot clear a bot check is not a
// degraded reader, it is a broken one. Firefox makes that harder in exactly
// one way, and it is worth being precise about what that way is.
//
// Measured on Firefox 147, against a probe collecting the signals anti-bot
// scripts actually read — automation globals, document attributes, plugins,
// permissions state, hover and pointer media queries, window against screen
// geometry, WebGL strings, whether patched getters still report native code —
// an automated Firefox differs from an ordinary one in a single boolean:
//
//   navigator.webdriver: false -> true
//
// Nothing else. Not one other field. And that boolean has one source: the
// parent process publishes a shared-data key when the remote agent starts
// listening, and `navigator.webdriver` in a content process reads it back.
// It is published exactly once, at startup — not per session — which is why
// clearing it once holds.
//
// So we clear it, through privileged JavaScript in the parent process, using
// Marionette's chrome context. Nothing in any page is touched: no getter is
// redefined, no toString is patched, so there is no tampering for a site to
// notice. The browser simply stops announcing something about itself.
//
// There is a real cost, and it is the flag below that grants it:
// --remote-allow-system-access lets anything reaching the Marionette port run
// privileged code in a browser holding the user's logins. The port is on
// loopback and Marionette is shut down as soon as the flag is cleared, which
// also happens to set its own announcement false on the way out.

const CANDIDATES = ['firefox', 'firefox-esr', 'librewolf'];
const STARTUP_TIMEOUT_MS = 45000;
const MARIONETTE_PORT = 2828;

// Both agents publish their own key, and either one being true is enough to
// give the browser away.
const ACTIVE_KEYS = ['RemoteAgent:Active', 'Marionette:Active'];

const CLEAR_SCRIPT = `
  const keys = ${JSON.stringify(ACTIVE_KEYS)};
  const before = keys.map((k) => Services.ppmm.sharedData.get(k) ?? false);
  for (const k of keys) Services.ppmm.sharedData.set(k, false);
  Services.ppmm.sharedData.flush();
  return { before, after: keys.map((k) => Services.ppmm.sharedData.get(k) ?? false) };
`;

function defaultProfileDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tui-browser', 'firefox-profile');
}

function which(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function findFirefox() {
  for (const name of CANDIDATES) {
    const found = which(name);
    if (found) return { executable: found, name };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

// A headless browser fails the checks a real one passes, so with no display we
// run under Xvfb — a real browser drawing to a virtual screen.
function buildCommand(executable, args) {
  if (process.env.DISPLAY) return { command: executable, args };
  const xvfb = which('xvfb-run');
  if (!xvfb) {
    throw new Error(
      'No DISPLAY is set and xvfb-run was not found. A browser with a display '
      + 'is required (headless browsers fail bot checks that a real one passes). '
      + 'Install xvfb, or run inside a graphical session.',
    );
  }
  return { command: xvfb, args: ['-a', executable, ...args] };
}

// ---------------------------------------------------------------------------
// Marionette, used for one thing only.
//
// Its wire format is a length-prefixed JSON array: `<bytes>:[type, id, name,
// params]`. We need three commands and then we are done with it.
// ---------------------------------------------------------------------------

function marionetteCommand(port, commands, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.end();
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Marionette did not answer in time')), timeout);
    const send = (name, params = {}) => {
      const id = nextId++;
      const payload = JSON.stringify([0, id, name, params]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(0x3a);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        if (!Number.isFinite(length)) return finish(new Error('unreadable Marionette framing'));
        const start = colon + 1;
        if (buffer.length < start + length) return;
        let message;
        try {
          message = JSON.parse(buffer.subarray(start, start + length).toString());
        } catch {
          return finish(new Error('unreadable Marionette message'));
        }
        buffer = buffer.subarray(start + length);
        if (!Array.isArray(message)) continue; // the handshake
        const [, id, error, result] = message;
        const waiter = pending.get(id);
        if (!waiter) continue;
        pending.delete(id);
        error ? waiter.rej(new Error(JSON.stringify(error).slice(0, 200))) : waiter.res(result);
      }
    });

    socket.on('error', (err) => finish(err));
    socket.on('connect', async () => {
      try {
        const value = await commands(send);
        clearTimeout(timer);
        finish(null, value);
      } catch (err) {
        clearTimeout(timer);
        finish(err);
      }
    });
  });
}

// Shuts Marionette down without touching the browser. Its own uninit stops
// the server and publishes its flag as false on the way out, which is exactly
// the direction we want. Not `Marionette:Quit` — that is WebDriver's "quit the
// browser" command, and it takes Firefox with it.
const STOP_MARIONETTE_SCRIPT = `
  const { Marionette } = ChromeUtils.importESModule(
    "chrome://remote/content/components/Marionette.sys.mjs");
  Marionette.uninit();
  return true;
`;

// Stops the browser announcing itself, and reports what it found.
async function clearAutomationFlag({ port = MARIONETTE_PORT, stopAfter = true } = {}) {
  return marionetteCommand(port, async (send) => {
    await send('WebDriver:NewSession', {});
    await send('Marionette:SetContext', { value: 'chrome' });
    const result = await send('WebDriver:ExecuteScript', { script: CLEAR_SCRIPT, args: [] });

    if (stopAfter) {
      // Its privileged port is the one real cost of this approach, and it has
      // served its purpose. The reply may never arrive, because the server we
      // are talking to is the thing being stopped.
      send('WebDriver:ExecuteScript', { script: STOP_MARIONETTE_SCRIPT, args: [] })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    return result && result.value;
  });
}

// Starts an ordinary Firefox, silences the announcement, and returns where to
// attach. The caller verifies from inside a page before trusting any of it.
async function launchFirefox({
  profileDir = defaultProfileDir(), keepBrowser = false, log = () => {},
} = {}) {
  const found = findFirefox();
  if (!found) {
    throw new Error(
      `No Firefox found. Looked for: ${CANDIDATES.join(', ')}. `
      + 'Install Firefox, or use --browser chromium.',
    );
  }

  fs.mkdirSync(profileDir, { recursive: true });

  // A Firefox already serving this profile is one to join. Firefox allows one
  // instance per profile and refuses the second outright, so this is a
  // correctness fix as much as a speed one — and it is the whole of the
  // startup difference against Chromium, which has been quietly rejoining a
  // running browser in 50ms while Firefox cold-started every time.
  const running = await runningEndpoint(profileDir);
  if (running) {
    log('firefox.rejoin', { port: running, profileDir });
    return {
      child: null,
      port: running,
      endpoint: `ws://127.0.0.1:${running}/session`,
      executable: null,
      profileDir,
      cleared: null,
      rejoined: true,
    };
  }

  const port = await freePort();

  const args = [
    '--no-remote',
    '-profile', profileDir,
    `--remote-debugging-port=${port}`,
    '--marionette',
    // Required for the chrome-context clear below, and the reason Marionette
    // is shut down the moment it is done.
    '--remote-allow-system-access',
    'about:blank',
  ];

  const { command, args: spawnArgs } = buildCommand(found.executable, args);
  log('firefox.spawn', { executable: found.executable, port, marionette: MARIONETTE_PORT, profileDir });

  // Detached, so the browser is not taken down by the terminal session ending
  // or the reader crashing. It is still killed explicitly on a clean exit
  // unless --keep-browser asked for it to stay, in which case the next session
  // rejoins it instead of waiting four seconds for a cold start.
  const child = spawn(command, spawnArgs, { stdio: 'ignore', detached: true });
  child.unref();
  child.on('error', () => { /* surfaced by the readiness check */ });
  let exitedEarly = false;
  child.on('exit', () => { exitedEarly = true; });

  const spawnedAt = Date.now();
  const deadline = spawnedAt + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (await portOpen(port)) { ready = true; break; }
    if (exitedEarly) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const portMs = Date.now() - spawnedAt;
  if (!ready) {
    try { child.kill(); } catch { /* already gone */ }
    throw new Error(exitedEarly
      ? `${found.name} exited immediately: another Firefox may be using ${profileDir}.`
      : `${found.name} did not open a debugging port within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  writeEndpointRecord(profileDir, { port, pid: child.pid, startedAt: Date.now() });

  let cleared = null;
  const clearStarted = Date.now();
  if (await waitForEndpoint(MARIONETTE_PORT, Date.now() + 15000)) {
    try {
      cleared = await clearAutomationFlag();
      log('firefox.automation.cleared', { ...cleared, portMs, clearMs: Date.now() - clearStarted });
    } catch (err) {
      log('firefox.automation.error', { error: String(err.message || err).slice(0, 200) });
    }
  } else {
    log('firefox.automation.error', { error: 'Marionette never opened its port' });
  }

  return {
    child,
    port,
    endpoint: `ws://127.0.0.1:${port}/session`,
    executable: found.executable,
    profileDir,
    cleared,
    rejoined: false,
  };
}

module.exports = {
  launchFirefox, clearAutomationFlag, findFirefox, defaultProfileDir,
  ACTIVE_KEYS, CLEAR_SCRIPT, MARIONETTE_PORT,
};
