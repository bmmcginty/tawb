'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

// Getting hold of a browser to read.
//
// Launching one through Playwright is not equivalent to using one. A
// Playwright-launched browser carries automation instrumentation — the
// --enable-automation family of flags, navigator.webdriver set to true — and
// sites respond to that. Measured against pastebin.com's Cloudflare
// challenge, which the site puts in front of /login and /search:
//
//   Playwright-launched, headless   challenge never clears
//   Playwright-launched, headed     challenge never clears
//   Chromium started normally       clears in ~4s, earns cf_clearance
//
// So we never launch a browser through Playwright. We start an ordinary
// browser ourselves, with no automation flags, and attach to it over the
// DevTools protocol — which reports navigator.webdriver === false, because
// it genuinely is an ordinary browser that happens to be observed.
//
// This is also why nothing here spoofs a User-Agent or patches Client Hints.
// A real browser sends correct, self-consistent headers by construction; the
// only reason to forge them was to disguise a headless one, and we no longer
// run a headless one.

const CANDIDATE_BROWSERS = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
];

const STARTUP_TIMEOUT_MS = 25000;
// Where we record the debugging port of a browser we started, so a later
// session can find it again.
const ENDPOINT_FILE = 'tui-browser-endpoint.json';

function defaultProfileDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tui-browser', 'profile');
}

function which(command) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// A real system browser is preferred — it is the one with the user's own
// profile ecosystem. Playwright's bundled Chromium is a genuine browser too,
// and works fine when started ourselves, so it serves as the last resort.
function findBrowserExecutable() {
  for (const name of CANDIDATE_BROWSERS) {
    const found = which(name);
    if (found) return { executable: found, name };
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return { executable: bundled, name: 'playwright-chromium' };
  } catch { /* no bundled build */ }
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

function endpointReady(port) {
  return new Promise((resolve) => {
    const request = net.connect(port, '127.0.0.1');
    request.setTimeout(1000);
    request.on('connect', () => { request.destroy(); resolve(true); });
    request.on('error', () => resolve(false));
    request.on('timeout', () => { request.destroy(); resolve(false); });
  });
}

async function waitForEndpoint(port, deadline) {
  while (Date.now() < deadline) {
    if (await endpointReady(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// The challenge above is only cleared by a browser with a display; a headless
// one fails it even when started normally. With no DISPLAY we therefore run
// under Xvfb, which is a real browser rendering to a virtual screen rather
// than a different mode of operation.
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

function endpointRecordPath(profileDir) {
  return path.join(profileDir, ENDPOINT_FILE);
}

function readEndpointRecord(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(endpointRecordPath(profileDir), 'utf8'));
  } catch {
    return null;
  }
}

function writeEndpointRecord(profileDir, record) {
  try {
    fs.writeFileSync(endpointRecordPath(profileDir), JSON.stringify(record));
  } catch { /* the browser still works without it */ }
}

// A browser already using this profile is one we must join rather than
// compete with. Chrome enforces one instance per profile directory, so a
// second launch simply hands its arguments to the running instance and
// exits — leaving nothing listening on a new debugging port, which is why
// starting a second session used to hang until the startup timeout expired.
async function findRunningBrowser(profileDir) {
  const record = readEndpointRecord(profileDir);
  if (!record || !record.port) return null;
  if (!(await endpointReady(record.port))) return null;
  return record.port;
}

// Starts an ordinary browser and attaches to it, or rejoins one already
// running on this profile. The profile persists between runs, so logins and
// cookies survive — which is most of what makes the web usable.
async function launchOwnBrowser({ profileDir = defaultProfileDir(), log = () => {} } = {}) {
  const found = findBrowserExecutable();
  if (!found) {
    throw new Error(
      `No browser found. Looked for: ${CANDIDATE_BROWSERS.join(', ')}. `
      + 'Install Chrome or Chromium, or use --connect to attach to one already running.',
    );
  }

  fs.mkdirSync(profileDir, { recursive: true });

  const running = await findRunningBrowser(profileDir);
  if (running) {
    log('browser.rejoin', { port: running, profileDir });
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${running}`);
    const context = browser.contexts()[0];
    if (context) {
      // Not ours to shut down: another session may still be reading it.
      return { browser, context, child: null, owned: false, port: running, rejoined: true };
    }
    await browser.close().catch(() => {});
  }

  const port = await freePort();

  const browserArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];

  const { command, args } = buildCommand(found.executable, browserArgs);
  log('browser.spawn', { executable: found.executable, name: found.name, port, profileDir });

  const child = spawn(command, args, { stdio: 'ignore', detached: false });
  child.on('error', () => { /* surfaced by the readiness check below */ });

  // A browser that hands off to another instance exits straight away. Notice
  // that rather than waiting out the full timeout for a port that will never
  // open, and say what actually happened.
  let exitedEarly = false;
  child.on('exit', () => { exitedEarly = true; });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (await endpointReady(port)) { ready = true; break; }
    if (exitedEarly) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    try { child.kill(); } catch { /* already gone */ }
    throw new Error(exitedEarly
      ? `${found.name} exited immediately: another browser is already using ${profileDir}. `
        + 'Close it, or use --connect to attach to it.'
      : `${found.name} did not open a debugging port within ${STARTUP_TIMEOUT_MS / 1000}s`);
  }

  writeEndpointRecord(profileDir, { port, pid: child.pid, startedAt: Date.now() });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser started but exposed no context');

  return { browser, context, child, owned: true, port, executable: found.executable };
}

// The debugging port names the browser instance, which is what per-browser
// state (tab claims) is keyed by. It is in the endpoint we were handed.
function portOfEndpoint(endpoint) {
  try {
    const port = Number(new URL(endpoint).port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function connectToBrowser(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error(`No browser context available at ${endpoint}`);
  return { browser, context: contexts[0], child: null, owned: false, port: portOfEndpoint(endpoint) };
}

// Normalises the various things someone might reasonably pass: a port, a
// host:port, or a full URL.
function normaliseEndpoint(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return `http://127.0.0.1:${text}`;
  if (/^https?:\/\//.test(text)) return text;
  return `http://${text}`;
}

module.exports = {
  launchOwnBrowser, connectToBrowser, normaliseEndpoint, portOfEndpoint,
  findBrowserExecutable, defaultProfileDir, findRunningBrowser,
  readEndpointRecord, writeEndpointRecord,
};
