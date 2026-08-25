'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { processAlive, killProcessGroup } = require('./proc');
const { otherReadersOn } = require('./session');

// The browsers tweb has started, so that one it never got to close can be
// found and taken down later.
//
// Closing a driver kills the browser's whole process group, which is enough
// whenever a session gets to finish. A session that does not — killed
// outright, or by the out-of-memory killer, which is how this came up — leaves
// a browser running with no parent and no record of it anywhere a later
// session would look. The endpoint record in the profile directory names it,
// but only that profile's; nothing enumerates them, so nothing could ever
// clean up after a crash.
//
// So every browser we start is written down here, in one file beside the tab
// claims, and every launch sweeps the list first. An entry is only a hint, in
// the same way a tab claim is: it is believed as far as a live process group
// whose command line still names the profile it was recorded against.

function stateDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tui-browser');
}

function registryPath() {
  return path.join(stateDir(), 'browsers.json');
}

function readRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    return Array.isArray(raw) ? raw.filter((e) => e && e.pid && e.port) : [];
  } catch {
    return [];
  }
}

function writeRegistry(entries) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(registryPath(), JSON.stringify(entries));
  } catch { /* a lost entry costs a sweep, not a crash */ }
}

// Whether this process id is still the browser we recorded, rather than
// whatever inherited its number afterwards.
//
// This is the check that makes the sweep safe to run. Signalling a whole
// process group by a remembered pid is a large thing to be wrong about, and a
// pid is reused freely, so the group is only signalled when the process still
// carries the profile directory we started it with on its command line —
// which both the browser and the xvfb-run wrapping it do.
function stillOurBrowser(pid, profileDir) {
  if (!profileDir) return false;
  let cmdline;
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false; // gone, not ours to read, or a platform without /proc
  }
  return cmdline.split('\0').includes(`--user-data-dir=${profileDir}`)
    || cmdline.split('\0').includes(profileDir);
}

function recordBrowser({ pid, port, profileDir, engine }) {
  if (!pid || !port) return;
  const others = readRegistry().filter((e) => e.port !== port);
  others.push({
    pid, port, profileDir, engine, owner: process.pid, keep: false, at: Date.now(),
  });
  writeRegistry(others);
}

// A browser we have taken down, or one that was never ours to take down.
function forgetBrowser(port) {
  if (!port) return;
  writeRegistry(readRegistry().filter((e) => e.port !== port));
}

// --keep-browser: left running on purpose, so never swept.
function markKept(port) {
  if (!port) return;
  writeRegistry(readRegistry().map((e) => (e.port === port ? { ...e, keep: true } : e)));
}

// Take down browsers left behind by sessions that are no longer running.
//
// A browser is stranded when the session that started it has gone without
// closing it, no other reader has claimed a tab in it, and it was not left
// running on purpose. Anything else is somebody's — a live session's browser,
// a browser a second reader joined, or one --keep-browser asked to stay — and
// is left alone.
function sweepStrandedBrowsers({ log = () => {} } = {}) {
  const entries = readRegistry();
  if (!entries.length) return 0;

  const kept = [];
  let swept = 0;
  for (const entry of entries) {
    if (!processAlive(entry.pid) || !stillOurBrowser(entry.pid, entry.profileDir)) {
      continue; // gone already, or the pid belongs to somebody else now
    }
    if (entry.keep || processAlive(entry.owner) || otherReadersOn(entry.port)) {
      kept.push(entry);
      continue;
    }
    log('browser.stranded', {
      pid: entry.pid, port: entry.port, engine: entry.engine, profileDir: entry.profileDir,
    });
    killProcessGroup(entry.pid);
    swept += 1;
  }

  if (swept || kept.length !== entries.length) writeRegistry(kept);
  return swept;
}

module.exports = {
  registryPath, readRegistry, writeRegistry, recordBrowser, forgetBrowser, markKept,
  sweepStrandedBrowsers, stillOurBrowser,
};
