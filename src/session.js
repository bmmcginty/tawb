'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { processAlive } = require('./proc');

// Which tab each running session is reading.
//
// Rejoining a browser adopts the tab it is already showing. That is right for
// one session and wrong for a second: it would take over the page the first
// session is reading, and the two would then fight — a navigation in one
// yanks the other out of whatever it was in the middle of.
//
// So every session records the tab it holds, keyed by the debugging port of
// the browser it holds it in, and a joining session skips tabs that another
// session still has. A record is only as good as the process that wrote it:
// a session killed outright leaves its claim behind, so claims are believed
// only while their process is still alive rather than trusted outright.

function stateDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'tawb');
}

function claimsPath(port) {
  return path.join(stateDir(), `tabs-${port}.json`);
}

function readClaims(port) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(claimsPath(port), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((claim) => claim && claim.targetId && processAlive(claim.pid));
}

function writeClaims(port, claims) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(claimsPath(port), JSON.stringify(claims));
  } catch { /* a lost claim costs a tab collision, not a crash */ }
}

// The tabs other live sessions are reading.
function claimedTargets(port) {
  const mine = process.pid;
  return new Set(readClaims(port).filter((c) => c.pid !== mine).map((c) => c.targetId));
}

// Whether another live session is reading this browser.
//
// A browser this process started is not therefore this process's to shut
// down: the reader who launched it is its first user, not its owner, and by
// the time they quit there may be readers in it who never had a browser of
// their own to lose. The claims say who is still there, and they are believed
// exactly as far as the processes that wrote them.
function otherReadersOn(port) {
  if (!port) return false;
  return readClaims(port).some((claim) => claim.pid !== process.pid);
}

function claimTab(port, targetId) {
  if (!port || !targetId) return;
  const others = readClaims(port).filter((c) => c.pid !== process.pid);
  others.push({ pid: process.pid, targetId, at: Date.now() });
  writeClaims(port, others);
}

function releaseTab(port) {
  if (!port) return;
  writeClaims(port, readClaims(port).filter((c) => c.pid !== process.pid));
}

module.exports = {
  claimedTargets, claimTab, releaseTab, readClaims, claimsPath, otherReadersOn,
};
