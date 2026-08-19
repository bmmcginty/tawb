'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  writeEndpointRecord, readEndpointRecord, runningEndpoint, waitForEndpoint,
} = require('./endpoint');

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
// Marionette is then left running, on purpose, because it is the only way out
// of a problem BiDi has no answer for. Closing a BiDi connection does not end
// its session — Firefox only unregisters the connection — and a pure-BiDi
// session cannot be reattached to or ended from anywhere else, so a reader
// that dies without saying session.end strands the session and locks every
// later reader out until Firefox restarts. Marionette shares that single
// session slot, and its own connection handler deletes the session
// unconditionally when a connection closes. So connecting to Marionette and
// hanging up releases a stranded session, in milliseconds, with no restart.
//
// Local port exposure is out of scope for this project: anything that can
// reach Marionette can already reach the browser's own protocol port and
// drive it. What is in scope is the consequence for us — while Marionette
// listens, anything that connects to it and disconnects will drop our session
// too, which is one more reason to end it cleanly ourselves.
//
// Each instance gets its own Marionette port, written into the profile.
// Firefox's default is 2828 for every browser, so with two profiles running
// the second reader would clear the first browser's flag and knock out the
// first browser's session.

const CANDIDATES = ['firefox', 'firefox-esr', 'librewolf'];
const STARTUP_TIMEOUT_MS = 45000;

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

// Media has to be allowed to start without a user gesture, because there is
// no gesture to give.
//
// The reader activates a control through the DOM's own default action —
// element.click() — rather than by driving a mouse at coordinates, since a
// blind user has no viewport and legitimate targets sit off-screen. That
// click carries no user activation, so Firefox refuses to play the audio it
// starts: `NotAllowedError: The play method is not allowed by the user agent`
// on a Bandcamp album page, while Chrome played the same page.
//
// The gesture the browser is looking for did happen — the reader pressed
// Enter on the play button — it simply cannot be conveyed through the
// protocol. So the profile is configured the way a user who ticked Firefox's
// own "Allow Audio and Video" would have it, per profile and nothing to do
// with any page. `block-autoplay-until-in-foreground` matters too: the tab
// being read is not always the tab the browser has on screen, and playback
// that waits for the foreground never starts.
const MEDIA_PREFS = {
  'media.autoplay.default': 0,          // 0 allow, 1 block audible, 5 block all
  'media.autoplay.blocking_policy': 0,  // ask once per profile, not per gesture
  'media.block-autoplay-until-in-foreground': false,
};

// Firefox reads user.js at startup, so everything here has to be in the
// profile before launch. Ours are rewritten every time rather than appended
// to, so a stale port or a pref we have since changed does not survive.
function writeProfilePrefs(profileDir, prefs) {
  const target = path.join(profileDir, 'user.js');
  const ours = Object.keys(prefs);
  let kept = [];
  try {
    kept = fs.readFileSync(target, 'utf8').split('\n')
      .filter((line) => line.trim() && !ours.some((name) => line.includes(`"${name}"`)));
  } catch { /* no user.js yet */ }
  const written = ours.map((name) => `user_pref("${name}", ${JSON.stringify(prefs[name])});`);
  fs.writeFileSync(target, [...kept, ...written].join('\n') + '\n');
}

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

// Stops the browser announcing itself, and reports what it found.
//
// Marionette is left running afterwards: see the note at the top of this file.
// Disconnecting from it deletes the session it just created, which is also how
// the BiDi session that follows is able to start at all — the two share one
// slot.
async function clearAutomationFlag({ port, stopAfter = false } = {}) {
  return marionetteCommand(port, async (send) => {
    await send('WebDriver:NewSession', {});
    await send('Marionette:SetContext', { value: 'chrome' });
    const result = await send('WebDriver:ExecuteScript', { script: CLEAR_SCRIPT, args: [] });
    if (stopAfter) {
      send('WebDriver:ExecuteScript', {
        script: `const { Marionette } = ChromeUtils.importESModule(
          "chrome://remote/content/components/Marionette.sys.mjs"); Marionette.uninit(); return true;`,
        args: [],
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    return result && result.value;
  });
}

// Releases a WebDriver session that a dead reader left behind.
//
// No commands are sent and none are needed: Marionette deletes the session
// when a connection to it closes, whatever that connection did. Connecting and
// hanging up is the whole operation.
//
// This must only be used against a session whose owner is gone. Marionette
// cannot tell whose session it is deleting, so knocking while another reader
// is alive would take the page out from under them.
function releaseStrandedSession(port, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let settled = false;
    const finish = (released) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(released);
    };
    socket.setTimeout(timeout);
    // The handshake proves Marionette is really there before we count it.
    socket.on('data', () => { socket.end(); finish(true); });
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
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
    const record = readEndpointRecord(profileDir) || {};
    log('firefox.rejoin', { port: running, marionette: record.marionettePort || null, profileDir });
    return {
      child: null,
      port: running,
      marionettePort: record.marionettePort || null,
      endpoint: `ws://127.0.0.1:${running}/session`,
      executable: null,
      profileDir,
      cleared: null,
      rejoined: true,
    };
  }

  const port = await freePort();
  const marionettePort = await freePort();
  writeProfilePrefs(profileDir, { ...MEDIA_PREFS, 'marionette.port': marionettePort });

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
  log('firefox.spawn', { executable: found.executable, port, marionette: marionettePort, profileDir });

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

  writeEndpointRecord(profileDir, {
    port, marionettePort, pid: child.pid, startedAt: Date.now(),
  });

  let cleared = null;
  const clearStarted = Date.now();
  if (await waitForEndpoint(marionettePort, Date.now() + 15000)) {
    try {
      cleared = await clearAutomationFlag({ port: marionettePort });
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
    marionettePort,
    endpoint: `ws://127.0.0.1:${port}/session`,
    executable: found.executable,
    profileDir,
    cleared,
    rejoined: false,
  };
}

module.exports = {
  launchFirefox, clearAutomationFlag, releaseStrandedSession, findFirefox,
  defaultProfileDir, writeProfilePrefs, MEDIA_PREFS, ACTIVE_KEYS, CLEAR_SCRIPT,
};
