'use strict';

// The browsers tweb has running, and what to do about them.
//
//   npm run browsers            # what is running, and whose it is
//   npm run browsers -- --sweep # take down the ones nobody is using
//   npm run browsers -- --all   # take down every browser tweb started
//
// It also accounts for the throwaway profile directories a test run makes. On
// this machine the system temporary directory is a tmpfs, so a profile left by
// a run that was killed is held in memory until something removes it — which
// --sweep does, for the ones whose owner has gone.
//
// A browser outlives the session that started it on purpose: the next session
// rejoins it in 50ms instead of cold-starting in four seconds, and a second
// reader may be in it. The cost of that is a browser can be left behind — by a
// crash, or by the out-of-memory killer, which on a machine with no swap is
// what a pile of them eventually causes. Every launch sweeps automatically;
// this is for looking, and for sweeping without starting a browser to do it.
//
// A browser is stranded when the session that started it has gone, no other
// reader has claimed a tab in it, and it was not left running on purpose.
// Those are the ones --sweep takes. --all takes the rest too, so use it when
// you know no one is reading.

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const R = path.join(__dirname, '..', 'src');
const {
  readRegistry, forgetBrowser, sweepStrandedBrowsers, sweepStaleProfiles, tempProfiles,
} = require(path.join(R, 'registry.js'));
const { processAlive, killProcessGroup } = require(path.join(R, 'proc.js'));
const { readClaims } = require(path.join(R, 'session.js'));

// Resident memory of a whole process group, in MB — the number that matters
// when the question is why the machine ran out.
function groupMemoryMb(pid) {
  try {
    const out = execFileSync('ps', ['-eo', 'pgid=,rss='], { encoding: 'utf8' });
    let kb = 0;
    for (const line of out.split('\n')) {
      const [pgid, rss] = line.trim().split(/\s+/);
      if (Number(pgid) === pid) kb += Number(rss) || 0;
    }
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

function describe(entry) {
  const alive = processAlive(entry.pid);
  const readers = readClaims(entry.port).map((c) => c.pid);
  const ownerAlive = processAlive(entry.owner);
  const stranded = alive && !entry.keep && !ownerAlive && readers.length === 0;
  return { ...entry, alive, readers, ownerAlive, stranded, mb: alive ? groupMemoryMb(entry.pid) : null };
}

function why(b) {
  if (!b.alive) return 'gone — the record is stale';
  if (b.stranded) return 'STRANDED — nobody is using it';
  if (b.keep) return 'kept on purpose (--keep-browser)';
  if (b.ownerAlive) return `in use by session ${b.owner}`;
  if (b.readers.length) return `read by session${b.readers.length > 1 ? 's' : ''} ${b.readers.join(', ')}`;
  return 'in use';
}

function list() {
  const browsers = readRegistry().map(describe);
  if (!browsers.length) {
    console.log('No browsers recorded. Nothing tweb started is running.');
    return browsers;
  }
  for (const b of browsers) {
    const size = b.mb == null ? '' : ` ${String(b.mb).padStart(5)}MB`;
    console.log(`${String(b.engine || '?').padEnd(9)} port ${String(b.port).padEnd(6)} pid ${String(b.pid).padEnd(8)}${size}  ${why(b)}`);
    console.log(`${' '.repeat(10)}${b.profileDir}${fs.existsSync(b.profileDir) ? '' : ' (profile gone)'}`);
  }
  const stranded = browsers.filter((b) => b.stranded);
  const live = browsers.filter((b) => b.alive);
  const total = live.reduce((sum, b) => sum + (b.mb || 0), 0);
  console.log(`\n${live.length} running, ${total}MB in all; ${stranded.length} stranded.`);
  if (stranded.length) console.log('Run with --sweep to take the stranded ones down.');
  return browsers;
}

// Throwaway directories, which are memory here rather than disk.
function listProfiles() {
  const dirs = tempProfiles();
  const abandoned = dirs.filter((d) => !d.alive);
  if (!dirs.length) return abandoned;
  console.log(`\n${dirs.length} throwaway director${dirs.length === 1 ? 'y' : 'ies'}`
    + `, ${abandoned.length} abandoned:`);
  for (const d of abandoned) console.log(`  ${d.dir}  (owner ${d.owner} has gone)`);
  if (abandoned.length) console.log('Run with --sweep to remove them.');
  return abandoned;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--all')) {
    const browsers = readRegistry().map(describe);
    let killed = 0;
    for (const b of browsers) {
      if (b.alive) {
        console.log(`killing ${b.engine} on port ${b.port} (pid ${b.pid}) — ${why(b)}`);
        killProcessGroup(b.pid);
        killed += 1;
      }
      forgetBrowser(b.port);
    }
    console.log(`${killed} taken down.`);
    return;
  }
  if (args.includes('--sweep')) {
    const say = (event, data) => console.log(`${event} ${JSON.stringify(data)}`);
    const swept = sweepStrandedBrowsers({ log: say });
    console.log(`${swept} stranded browser${swept === 1 ? '' : 's'} taken down.`);
    // Browsers first: a profile is not free while one is still reading it.
    const removed = sweepStaleProfiles({ log: say });
    console.log(`${removed} abandoned director${removed === 1 ? 'y' : 'ies'} removed.`);
    list();
    listProfiles();
    return;
  }
  list();
  listProfiles();
}

main();
