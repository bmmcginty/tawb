'use strict';

// Throwaway directories for a test file, which clean up after themselves even
// when the run is killed outright.
//
// Every browser test file needs a profile of its own, and several test files
// need a state or config directory too. They are removed in test.after, which covers every run that
// finishes. A run that does not finish — Ctrl-C, or the out-of-memory killer,
// which is how this came up — runs no cleanup at all, and the system
// temporary directory here is a tmpfs, so each abandoned profile stays
// resident in memory. Interrupted runs had built up 3.4GB of them.
//
// Nothing can be done from inside the process that is being killed. So each
// directory carries the pid that made it in its own name, and the next run
// sweeps the ones whose owner has gone. Signals we can catch are handled too,
// because Ctrl-C is the common case and there is no reason to leave those
// until next time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tempName, sweepStaleProfiles, sweepStrandedBrowsers } = require('../src/registry');
const { anyProcessUsing } = require('../src/proc');

const mine = new Set();
let swept = false;
let hooked = false;

// Ours to remove, but not while a browser we started is still reading it —
// which is the ordinary case when a run is cut short, because the driver's
// close never ran. Anything skipped here keeps its owner in its name and is
// swept by the next run, once that browser has been reaped.
function removeMine() {
  for (const dir of mine) {
    if (anyProcessUsing(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* going anyway */ }
  }
  mine.clear();
}

// Node runs no exit handler for a signal nobody is listening for, so the
// listener is the whole point. It cleans up and then leaves by the same code
// the signal would have produced, rather than swallowing it.
//
// This is a courtesy, not the mechanism. Under the test runner a file's
// process is not guaranteed to get the signal at all — the runner may take it
// down first — so nothing depends on this having run. What a cut-short run
// leaves behind is cleaned by the next run's sweep, which is the part that is
// actually relied on.
function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', removeMine);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.on(signal, () => { removeMine(); process.exit(code); });
  }
}

// Blocking, because this runs while a test file is being loaded and there is
// nothing to await into.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Clear up after runs that did not finish. Browsers first, in that order and
// not the other: a profile is not free while a browser is still reading it,
// and the browser stranded by a kill is usually holding the very directory
// that the same kill stranded. Sweeping directories first would find them all
// busy and leave the lot for next time.
//
// The pause is for the kill to land — a process signalled is not yet a process
// gone — and is paid only on a run that actually found something to reap.
function sweepWhatTheLastRunLeft() {
  if (sweepStrandedBrowsers()) sleepSync(1500);
  sweepStaleProfiles();
}

// A directory that belongs to this test file. It is handed back empty and
// stays that way: what makes it sweepable is its name, not anything in it.
function tempDir(prefix) {
  if (!swept) {
    swept = true;
    sweepWhatTheLastRunLeft();
  }
  hook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tempName(prefix)));
  mine.add(dir);
  return dir;
}

// How long to wait for a browser to finish leaving a profile before giving up
// on removing that profile here. A browser that was signalled goes in well
// under a second; anything still there after this is a browser that was never
// signalled at all.
const RELEASE_MS = 5000;

// Removing a directory this file made, without waiting for the run to end.
//
// A browser that has been told to quit is not yet a browser that has quit.
// Chromium goes on writing its profile all through its shutdown, so removing
// the profile the moment the driver's close returns races those last writes:
// the walk empties a directory, the browser creates one more file inside it,
// and the final rmdir fails with ENOTEMPTY. That is the flake this waits out.
//
// The condition to wait on is the browser leaving the profile, because once no
// process names the profile there is nobody left to write into it. The retries
// are for the moment either side of that, where a write may already be in
// flight. The wait costs nothing in the ordinary case: the driver's close
// signalled the browser before this was called.
function removeTempDir(dir) {
  for (const deadline = Date.now() + RELEASE_MS;
    anyProcessUsing(dir) && Date.now() < deadline;) {
    sleepSync(50);
  }
  // Still occupied, which is not this function's business to end: a browser
  // another reader is in, or one --keep-browser asked to stay. The directory
  // keeps its owner in its name and is swept by the next run, once that
  // browser has been reaped.
  if (anyProcessUsing(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    return false;
  }
  mine.delete(dir);
  return true;
}

module.exports = { tempDir, removeTempDir };
