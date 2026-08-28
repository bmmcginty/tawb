'use strict';

const fs = require('fs');

// Whether a process id recorded earlier still belongs to a running process.
//
// Signal 0 performs the permission and existence checks without delivering
// anything. EPERM means the process is there and simply is not ours, which
// still counts as running — only ESRCH means it is gone.
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Take down a browser and everything it brought with it.
//
// A browser is not one process. Chromium is a main process, a zygote, a GPU
// process and a renderer per site; Firefox is much the same. And on a machine
// with no display neither is what we actually spawn — buildCommand wraps them
// in xvfb-run, a shell script that starts an X server beside the browser and
// then runs the browser as an ordinary foreground child.
//
// That wrapper is why signalling the process we spawned is not enough. A shell
// waiting on a foreground command does not pass a signal on to it, so the
// SIGTERM meant for the browser kills the script instead: the browser and its
// X server carry on with no parent, the next session cannot find them because
// their port was never recorded as free, and it starts another pair beside
// them. Repeated often enough on a machine with no swap, that is an
// out-of-memory kill.
//
// Spawning detached puts the whole lot — wrapper, X server, browser, renderers
// — in one process group led by the child we hold, and a negative pid signals
// the group. It is the only handle that reaches every part of a browser.
function killProcessGroup(pid, signal = 'SIGTERM') {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    // Not a group leader after all — spawned without detached, or already
    // reaped. The process itself is still worth the signal.
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Which running processes still refer to this path on their command line.
//
// The safety net for deleting a directory nobody should still be in. A
// browser names its profile directory in its arguments and so does the
// xvfb-run wrapping it, so a profile still being read by a browser that
// outlived the process which made it is visible here — which is the one case
// where a directory whose owner has gone is still not free.
//
// Best effort by construction: /proc entries come and go while it is read,
// and a process belonging to another user cannot be read at all. Every such
// failure is treated as "not using it", because the caller's other checks
// have to stand on their own anyway.
function processesUsing(target) {
  if (!target) return [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return []; // no /proc: nothing can be proved either way
  }
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    if (entry === String(process.pid)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
    } catch {
      continue; // exited between the listing and the read, or not ours
    }
    if (cmdline.includes(target)) found.push(Number(entry));
  }
  return found;
}

function anyProcessUsing(target) {
  return processesUsing(target).length > 0;
}

// Browsers deliberately refuse to use their sandbox as root. Chromium's own
// suggestion is --no-sandbox, but silently taking it would turn a confusing
// startup failure into an unsafe browser. Say what to do before launching it.
function requireBrowserUser(name, getuid = process.getuid) {
  if (typeof getuid !== 'function' || getuid() !== 0) return;
  throw new Error(
    `TAWB will not launch ${name} as root because its security sandbox cannot run safely that way. `
    + 'Run TAWB from a normal user account; --no-sandbox is intentionally not used.',
  );
}

// Keep the browser's own explanation of a startup failure. This used to be
// discarded, after which every quick exit was guessed to be a profile clash —
// including Chromium's very explicit refusal to run as root.
//
// Both streams are kept, not just stderr, because on a machine with no display
// the process we spawn is xvfb-run — and Debian's xvfb-run runs its command as
// `"$@" 2>&1`, folding everything the browser says into stdout. Watching
// stderr alone there is watching a stream that is empty by construction, which
// is why headless Ubuntu reported timeouts with no browser output at all.
//
// The streams are drained for the child's lifetime so a noisy browser cannot
// block on a full pipe, but only their bounded tail is retained.
function watchChildStartup(child, limit = 8192) {
  const state = {
    exited: false, closed: false, code: null, signal: null, error: null, output: '',
  };
  const streams = [child.stdout, child.stderr].filter(Boolean);
  for (const stream of streams) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      state.output = (state.output + chunk).slice(-limit);
    });
  }
  // Keep the pipes referenced until startup finishes, or Node can leave before
  // their final data events. Once the browser is ready it may outlive the
  // reader, so the launcher releases these handles explicitly.
  state.unref = () => {
    for (const stream of streams) {
      if (typeof stream.unref === 'function') stream.unref();
    }
  };
  child.once('error', (err) => { state.error = err; state.exited = true; });
  child.once('exit', (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
  });
  // exit can precede the last data event. Read the diagnosis only once close
  // says all of the child's stdio has been drained.
  child.once('close', () => { state.closed = true; });
  return state;
}

function compactDiagnostic(value, limit = 1200) {
  return String(value || '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-limit);
}

function browserStartupError({
  name, executable, profileDir, port, timeoutMs, state, context = [],
}) {
  let reason;
  if (state.error) reason = `could not be started: ${state.error.message}`;
  else if (state.exited && state.signal) reason = `was killed by ${state.signal} before it was ready`;
  else if (state.exited) reason = `exited with status ${state.code ?? 'unknown'} before it was ready`;
  else reason = `did not open debugging port ${port} within ${timeoutMs / 1000}s`;

  const diagnostic = compactDiagnostic(state.output);
  const details = [`Executable: ${executable}`, `Profile: ${profileDir}`, ...context.filter(Boolean)];
  return new Error(
    `${name} ${reason}. ${details.join('. ')}.`
    + (diagnostic ? ` Browser said: ${diagnostic}` : ' The browser said nothing.'),
  );
}

module.exports = {
  processAlive, killProcessGroup, processesUsing, anyProcessUsing,
  requireBrowserUser, watchChildStartup, compactDiagnostic, browserStartupError,
};
