'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { processAlive, killProcessGroup, processesUsing } = require('./proc');
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
// So every browser we start is written down here, beside the tab claims, and
// every launch sweeps the list first. An entry is only a hint, in the same way
// a tab claim is: it is believed as far as a live process group whose command
// line still names the profile it was recorded against.
//
// One file per browser, named by its port, rather than one file listing them
// all. Sessions start browsers concurrently — a test run starts several at
// once — and a shared list means read, modify, write, which is a lost update
// whenever two of them overlap. A lost entry here is a browser that can never
// be swept, which is the one thing this is for. Separate files never collide.

function stateDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tui-browser');
}

function registryDir() {
  return path.join(stateDir(), 'browsers');
}

function entryPath(port) {
  return path.join(registryDir(), `${port}.json`);
}

function readEntry(port) {
  try {
    const entry = JSON.parse(fs.readFileSync(entryPath(port), 'utf8'));
    return entry && entry.pid && entry.port ? entry : null;
  } catch {
    return null;
  }
}

function writeEntry(entry) {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(entryPath(entry.port), JSON.stringify(entry));
  } catch { /* a lost entry costs a sweep, not a crash */ }
}

function dropEntry(port) {
  try {
    fs.rmSync(entryPath(port), { force: true });
  } catch { /* nothing to drop */ }
}

function readRegistry() {
  let names;
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readEntry(path.basename(name, '.json')))
    .filter(Boolean);
}

// Replaces the whole set. Nothing in a session needs this — a session only
// ever writes its own browser's entry — but a test setting up a situation
// does.
function writeRegistry(entries) {
  for (const entry of readRegistry()) dropEntry(entry.port);
  for (const entry of entries) writeEntry(entry);
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
  writeEntry({
    pid, port, profileDir, engine, owner: process.pid, keep: false, at: Date.now(),
  });
}

// A browser we have taken down, or one that was never ours to take down.
function forgetBrowser(port) {
  if (!port) return;
  dropEntry(port);
}

// --keep-browser: left running on purpose, so never swept.
function markKept(port) {
  if (!port) return;
  const entry = readEntry(port);
  if (entry) writeEntry({ ...entry, keep: true });
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

  let swept = 0;
  for (const entry of entries) {
    if (!processAlive(entry.pid) || !stillOurBrowser(entry.pid, entry.profileDir)) {
      dropEntry(entry.port); // gone already, or the pid belongs to somebody else now
      continue;
    }
    if (entry.keep || processAlive(entry.owner) || otherReadersOn(entry.port)) continue;
    log('browser.stranded', {
      pid: entry.pid, port: entry.port, engine: entry.engine, profileDir: entry.profileDir,
    });
    killProcessGroup(entry.pid);
    dropEntry(entry.port);
    swept += 1;
  }
  return swept;
}

// ---------------------------------------------------------------------------
// Throwaway directories
//
// A directory made for one test run — every browser test file makes a profile,
// and several make a state or config directory too — is removed when that run
// finishes. A run that does not finish leaves it behind, and the system
// temporary directory here is a tmpfs, so an abandoned browser profile is not
// merely clutter: it is resident memory, held until somebody notices.
// Interrupted runs had accumulated 3.4GB of them.
//
// Nothing in the process can help, because the kill that strands them is the
// one that runs no cleanup. So they are swept by whoever comes next, on the
// same terms as a stranded browser: believed only as far as a process that is
// still alive.
//
// The owner's pid is written into the directory's own name rather than into a
// file inside it, so that what we hand back is an empty directory and stays
// one — a profile is somebody else's to fill, and one test here asserts on
// exactly what a directory ends up containing.
//
// Getting a pid wrong is safe in the only direction that matters. A number
// reused by some live process makes the directory look busy and it is left
// alone; there is no reading of it that deletes a directory whose owner is
// still running.

// tweb-<label>-<pid>-<six random characters>, which is what tempName builds
// and the only shape swept.
const TEMP_DIR_RE = /^tweb-[\w.-]*?-(\d+)-[^-]{6}$/;

// The prefix to hand mkdtemp, carrying this process's claim on what it makes.
function tempName(prefix) {
  return `${prefix}${process.pid}-`;
}

function ownerOfTempDir(name) {
  const found = TEMP_DIR_RE.exec(name);
  return found ? Number(found[1]) : null;
}

// Remove throwaway directories whose owner is gone. Returns how many went.
function sweepStaleProfiles({ dir = os.tmpdir(), log = () => {} } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }

  let swept = 0;
  for (const name of names) {
    const owner = ownerOfTempDir(name);
    if (owner === null || processAlive(owner)) continue;
    const candidate = path.join(dir, name);

    // The owner has gone but a browser it started may not have. That browser
    // is not somebody's session to protect: a throwaway profile is used by one
    // run, its name says which, and that run is over — nobody will ever rejoin
    // it. Often it cannot be reached any other way, because a test file that
    // points XDG_DATA_HOME at a directory of its own records the browser it
    // starts in a registry that goes when that directory goes.
    //
    // So it is taken down here, by the profile it is holding rather than by a
    // record of it. This is the only place that kills something it did not
    // find in the registry, and the two conditions above are what make that
    // safe: a reader's own profile is never named this way, and a name alone
    // is not enough — the process that made it has to be gone.
    for (const pid of processesUsing(candidate)) {
      log('tempdir.holder', { dir: candidate, pid });
      killProcessGroup(pid);
    }

    try {
      // Unlinking works whether or not those have finished exiting; the space
      // comes back as their handles close.
      fs.rmSync(candidate, { recursive: true, force: true });
      log('tempdir.stale', { dir: candidate, owner });
      swept += 1;
    } catch { /* gone already, or not ours to remove */ }
  }
  return swept;
}

// The throwaway directories currently on disk, for reporting.
function tempProfiles({ dir = os.tmpdir() } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.map((name) => {
    const owner = ownerOfTempDir(name);
    return owner === null
      ? null
      : { dir: path.join(dir, name), owner, alive: processAlive(owner) };
  }).filter(Boolean);
}

module.exports = {
  registryDir, entryPath, readRegistry, writeRegistry, recordBrowser, forgetBrowser,
  markKept, sweepStrandedBrowsers, stillOurBrowser,
  tempName, ownerOfTempDir, sweepStaleProfiles, tempProfiles,
};
