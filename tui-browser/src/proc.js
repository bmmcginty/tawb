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

module.exports = { processAlive, killProcessGroup, processesUsing, anyProcessUsing };
