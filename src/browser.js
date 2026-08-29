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
  startupTimeoutMs, snapPackageName, snapCanReach, snapProfileDir,
} = require('./proc');
const { recordBrowser, sweepStrandedBrowsers } = require('./registry');
const { openAccessibilityBus } = require('./a11y_bus');

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

// What xvfb-run was told to do, kept so a failure can say whether the browser
// was given a real display or a virtual one.
let lastDisplayNote = null;

// The profile a browser we start keeps its logins in. A Snap-packaged browser
// cannot read the usual location — see the note on confinement in proc.js — so
// one gets a directory inside the snap's own data area instead.
function defaultProfileDir(executable = (findBrowserExecutable() || {}).executable) {
  const snap = snapPackageName(executable);
  if (snap) return snapProfileDir(snap, 'profile');
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
  if (process.env.DISPLAY) {
    lastDisplayNote = `Display: ${process.env.DISPLAY}`;
    return { command: executable, args };
  }
  const xvfb = which('xvfb-run');
  if (!xvfb) {
    throw new Error(
      'No DISPLAY is set and xvfb-run was not found. A browser with a display '
      + 'is required (headless browsers fail bot checks that a real one passes). '
      + 'Install xvfb, or run inside a graphical session.',
    );
  }
  lastDisplayNote = `Display: none, so the browser was run under ${xvfb}`;
  return { command: xvfb, args: ['-a', '-s', `-screen 0 ${SCREEN}`, executable, ...args] };
}

// A Snap-packaged browser can only reach a profile inside its own data area.
// Told to use one it cannot open, it does not fail: it puts a message in a
// window on a virtual screen nobody is looking at, and the launcher waits out
// its whole timeout for a port that will never open. Say so before launching.
function requireReachableProfile({ executable, name }, profileDir) {
  const snap = snapPackageName(executable);
  if (!snap || snapCanReach(profileDir)) return;
  throw new Error(
    `${name} at ${executable} runs the ${snap} snap, and a Snap cannot open ${profileDir}: `
    + 'its confinement allows only non-hidden directories under your home directory. '
    + `Use a profile it can reach, such as ${snapProfileDir(snap, 'profile')}, `
    + 'or install a packaged browser that is not confined.',
  );
}

// Chromium writes the port it really opened into the profile. If that file is
// there after a timeout, the browser started and chose a port, and the failure
// is between it and us rather than in the browser itself — which is a wholly
// different thing to go looking for.
function devToolsPortNote(profileDir, port) {
  let contents;
  try {
    contents = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return 'DevToolsActivePort: not written, so the browser never got as far as listening';
  }
  const opened = contents.split('\n')[0].trim();
  return opened === String(port)
    ? `DevToolsActivePort: ${opened}, so the browser did listen and only the connection failed`
    : `DevToolsActivePort: ${opened || 'empty'}, which is not the port ${port} it was given`;
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
  requireReachableProfile(found, profileDir);
  fs.mkdirSync(profileDir, { recursive: true });

  // Before starting another one, take down any left behind by sessions that
  // are no longer running. This is where a browser orphaned by a crash — or
  // by the out-of-memory kill that a pile of them causes — is finally reaped.
  sweepStrandedBrowsers({ log });

  // Somewhere for the browser to describe its own windows to, and the flag
  // that makes it describe them. A native dialog — an extension asking for
  // consent, a file picker — is not a document and is in neither protocol;
  // the browser's own accessibility interface is what has it. See atspi.js
  // for what that buys and a11y_bus.js for where the bus comes from.
  //
  // The flag is passed only when there is a bus to answer on, because
  // accessibility that nothing is reading is renderer work nobody wants.
  const a11y = await openAccessibilityBus({ log });
  if (!a11y.available) log('a11y.unavailable', { reason: a11y.reason });

  const running = await findRunningBrowser(profileDir);
  if (running) {
    log('browser.rejoin', { port: running, profileDir });
    const browser = await cdpBrowser.connect(`http://127.0.0.1:${running}`);
    const context = browser.contexts()[0];
    if (context) {
      // Not ours to shut down: another session may still be reading it. Its
      // accessibility, too, is whatever the session that started it set up —
      // which may be nothing, and is why the bus is handed over rather than
      // promised.
      return {
        browser, context, child: null, owned: false, port: running, rejoined: true, a11y,
      };
    }
    await browser.close().catch(() => {});
  }

  const port = await freePort();

  const browserArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    // `basic` is the cheapest of the three values this takes, and it is
    // enough: with it the browser's own windows are described, without it
    // AT-SPI shows the application and the window frame and nothing inside
    // either. Nothing else turns this on — not the environment variable, not
    // the bus property, not CDP's Accessibility.enable.
    ...(a11y.available ? ['--force-renderer-accessibility=basic'] : []),
    'about:blank',
  ];

  const { command, args } = buildCommand(found.executable, browserArgs);
  const displayNote = lastDisplayNote;
  log('browser.spawn', { executable: found.executable, name: found.name, port, profileDir });

  // Detached, so the browser leads a process group of its own. That is the
  // only handle that reaches all of it: with no display the command above is
  // xvfb-run, and the browser is that shell's child rather than ours.
  // Both output streams are captured: under xvfb-run the browser's stderr
  // arrives on stdout, so listening to stderr alone hears nothing.
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    // Only ever an addition: the bus this session started, for a machine that
    // had none. Where the desktop has one already this is empty and the
    // browser inherits the environment it would have had anyway.
    env: { ...process.env, ...a11y.env },
  });
  const startup = watchChildStartup(child);
  child.unref();

  // Stop waiting when the process exits, but do not guess why. A profile clash
  // is only one possible quick exit; the browser's own stderr is the evidence.
  const timeoutMs = startupTimeoutMs(STARTUP_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (await endpointReady(port)) { ready = true; break; }
    if (startup.closed) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    killProcessGroup(child.pid);
    await a11y.close();
    throw browserStartupError({
      name: found.name,
      executable: found.executable,
      profileDir,
      port,
      timeoutMs,
      state: startup,
      context: [displayNote, devToolsPortNote(profileDir, port)],
    });
  }
  startup.unref();

  writeEndpointRecord(profileDir, { port, pid: child.pid, startedAt: Date.now() });
  recordBrowser({ pid: child.pid, port, profileDir, engine: 'chromium' });

  const browser = await cdpBrowser.connect(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) throw new Error('Browser started but exposed no context');

  return { browser, context, child, owned: true, port, executable: found.executable, a11y };
}

async function connectToBrowser(endpoint, { log = () => {} } = {}) {
  const browser = await cdpBrowser.connect(endpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error(`No browser context available at ${endpoint}`);
  // A browser that was already running was started by somebody else, so
  // whether it describes its windows is their decision and not ours: the flag
  // is a startup one. The bus is still opened, because a desktop's browser is
  // routinely started with accessibility on and then this works anyway.
  const a11y = await openAccessibilityBus({ log });
  return {
    browser, context: contexts[0], child: null, owned: false, port: portOfEndpoint(endpoint), a11y,
  };
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
