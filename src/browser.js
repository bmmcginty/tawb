'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cdpBrowser = require('./cdp_browser');
const {
  readEndpointRecord, writeEndpointRecord, endpointReady, runningEndpoint, portOfEndpoint, freePort,
} = require('./endpoint');
const {
  killProcessGroup, requireBrowserUser, watchChildStartup, browserStartupError,
} = require('./proc');
const { recordBrowser, sweepStrandedBrowsers } = require('./registry');

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

function defaultProfileDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tawb', 'profile');
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

// A real system browser, which is the one with the user's own profile
// ecosystem — their logins, their extensions, their history. There is no
// fallback to a browser downloaded for automation: such a build is nobody's
// everyday browser, and the whole point here is to be using one.
function findBrowserExecutable() {
  for (const name of CANDIDATE_BROWSERS) {
    const found = which(name);
    if (found) return { executable: found, name };
  }
  return null;
}

// The virtual screen is given a desktop's dimensions. xvfb-run defaults to
// 640x480, and a 640x480 screen is not a small window, it is a different web:
// pages serve their narrow layout, sticky bars cover most of what is left,
// and a control in the middle of the page can end up with a cookie banner
// permanently on top of it. 1280x1024 is an ordinary desktop and costs
// nothing but virtual pixels.
const SCREEN = '1280x1024x24';

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
  return { command: xvfb, args: ['-a', '-s', `-screen 0 ${SCREEN}`, executable, ...args] };
}

// A browser already using this profile is one we must join rather than
// compete with. Chrome enforces one instance per profile directory, so a
// second launch simply hands its arguments to the running instance and
// exits — leaving nothing listening on a new debugging port, which is why
// starting a second session used to hang until the startup timeout expired.
const findRunningBrowser = runningEndpoint;

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

  requireBrowserUser(found.name);
  fs.mkdirSync(profileDir, { recursive: true });

  // Before starting another one, take down any left behind by sessions that
  // are no longer running. This is where a browser orphaned by a crash — or
  // by the out-of-memory kill that a pile of them causes — is finally reaped.
  sweepStrandedBrowsers({ log });

  const running = await findRunningBrowser(profileDir);
  if (running) {
    log('browser.rejoin', { port: running, profileDir });
    const browser = await cdpBrowser.connect(`http://127.0.0.1:${running}`);
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

  // Detached, so the browser leads a process group of its own. That is the
  // only handle that reaches all of it: with no display the command above is
  // xvfb-run, and the browser is that shell's child rather than ours.
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const startup = watchChildStartup(child);
  child.unref();

  // Stop waiting when the process exits, but do not guess why. A profile clash
  // is only one possible quick exit; the browser's own stderr is the evidence.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (await endpointReady(port)) { ready = true; break; }
    if (startup.closed) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    killProcessGroup(child.pid);
    throw browserStartupError({
      name: found.name,
      executable: found.executable,
      profileDir,
      port,
      timeoutMs: STARTUP_TIMEOUT_MS,
      state: startup,
    });
  }
  startup.unref();

  writeEndpointRecord(profileDir, { port, pid: child.pid, startedAt: Date.now() });
  recordBrowser({ pid: child.pid, port, profileDir, engine: 'chromium' });

  const browser = await cdpBrowser.connect(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser started but exposed no context');

  return { browser, context, child, owned: true, port, executable: found.executable };
}

async function connectToBrowser(endpoint) {
  const browser = await cdpBrowser.connect(endpoint);
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
};
