'use strict';

const fs = require('fs');
const path = require('path');

// Timing log. The UI owns the terminal, so diagnostics go to a file — one
// NDJSON record per event, with the elapsed milliseconds since the process
// started. Written synchronously-ish through a stream so the ordering is
// trustworthy when something hangs.
//
// Path comes from TWEB_LOG, defaulting to tweb.log next to the package.

const LOG_PATH = process.env.TWEB_LOG || path.join(__dirname, '..', 'tweb.log');

let stream = null;
const started = Date.now();

function open() {
  if (stream) return stream;
  try {
    stream = fs.createWriteStream(LOG_PATH, { flags: 'w' });
    stream.write(`# tui-browser log ${new Date().toISOString()}\n`);
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
