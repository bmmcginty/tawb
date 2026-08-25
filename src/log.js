'use strict';

const fs = require('fs');
const path = require('path');

const { processAlive } = require('./proc');

// Timing log. The UI owns the terminal, so diagnostics go to a file — one
// NDJSON record per event, with the elapsed milliseconds since the process
// started. Written synchronously-ish through a stream so the ordering is
// trustworthy when something hangs.
//
// Path comes from TWEB_LOG, defaulting to tweb.log next to the package.

const DEFAULT_LOG = path.join(__dirname, '..', 'tweb.log');

// Two sessions must not share one log. The second would truncate the first's
// and then interleave with it, wrecking the one record you consult to find
// out why something felt slow — and wrecking it precisely when you are
// running two sessions, which is when timings are hardest to reason about.
//
// The header line names the process that opened the log, so a starting
// session can see whether the log it is about to overwrite belongs to a
// session still running. If it does, it writes tweb-<pid>.log alongside
// instead. The common case — one session at a time — still gets tweb.log.
function ownerOfLog(file) {
  let firstLine;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(200);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    firstLine = head.subarray(0, read).toString('utf8').split('\n')[0];
  } catch {
    return null; // no log yet, or none we can read
  }
  const match = /\bpid (\d+)\b/.exec(firstLine);
  return match ? Number(match[1]) : null;
}

function resolveLogPath() {
  if (process.env.TWEB_LOG) return process.env.TWEB_LOG;
  if (processAlive(ownerOfLog(DEFAULT_LOG))) {
    const parsed = path.parse(DEFAULT_LOG);
    return path.join(parsed.dir, `${parsed.name}-${process.pid}${parsed.ext}`);
  }
  return DEFAULT_LOG;
}

const LOG_PATH = resolveLogPath();

let stream = null;
const started = Date.now();

function open() {
  if (stream) return stream;
  try {
    stream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
    stream.write(`# tui-browser log ${new Date().toISOString()} pid ${process.pid}\n`);
  } catch {
    stream = null;
  }
  return stream;
}

function log(event, fields = {}) {
  const out = open();
  if (!out) return;
  const record = { t: Date.now() - started, event, ...fields };
  try {
    out.write(JSON.stringify(record) + '\n');
  } catch {
    // A broken log must never take the browser down.
  }
}

// Times an async operation and logs how long it took.
async function timed(event, fields, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    log(event, { ...fields, ms: Date.now() - t0 });
    return result;
  } catch (err) {
    log(event, { ...fields, ms: Date.now() - t0, error: String(err.message || err).slice(0, 200) });
    throw err;
  }
}

// Running totals, flushed periodically, for things too frequent to log one
// by one (mutation notifications especially).
const counters = Object.create(null);

function count(name, amount = 1) {
  counters[name] = (counters[name] || 0) + amount;
}

function flushCounters(extra = {}) {
  const snapshot = { ...counters, ...extra };
  for (const key of Object.keys(counters)) delete counters[key];
  if (Object.keys(snapshot).length) log('counters', snapshot);
}

module.exports = { log, timed, count, flushCounters, LOG_PATH };
