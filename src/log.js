'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { currentRevision } = require('./revision');

// Timing log. The UI owns the terminal, so diagnostics go to a file — one
// NDJSON record per event, timestamped from process start. Logging is opt-in:
// ordinary runs leave nothing behind, while --log enables one uniquely named
// file in the user's home directory.

let logPath = null;
let enabledAt = null;
let stream = null;
const started = Date.now();

function two(value) {
  return String(value).padStart(2, '0');
}

function timestamp(date) {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`
    + `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

function defaultLogPath({ now = new Date(), pid = process.pid, home = os.homedir() } = {}) {
  return path.join(home, `.tawb.${timestamp(now)}.${pid}.log`);
}

function enableLog(options = {}) {
  if (logPath) return logPath;
  enabledAt = options.now || new Date();
  logPath = defaultLogPath({ ...options, now: enabledAt });
  return logPath;
}

function getLogPath() {
  return logPath;
}

function open() {
  if (!logPath) return null;
  if (stream) return stream;
  try {
    // Open synchronously so an unwritable home disables diagnostics rather
    // than raising an asynchronous stream error that takes the reader down.
    const fd = fs.openSync(logPath, 'w', 0o600);
    stream = fs.createWriteStream(null, { fd });
    stream.on('error', () => { stream = null; });
    stream.write(
      `# tawb log ${enabledAt.toISOString()} pid ${process.pid} commit ${currentRevision()}\n`,
    );
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

// Times an async operation whether logging is enabled or not. Callers depend
// on this function for the operation itself, not merely for its measurement.
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
  if (!logPath) return;
  counters[name] = (counters[name] || 0) + amount;
}

function flushCounters(extra = {}) {
  if (!logPath) return;
  const snapshot = { ...counters, ...extra };
  for (const key of Object.keys(counters)) delete counters[key];
  if (Object.keys(snapshot).length) log('counters', snapshot);
}

function closeLog() {
  if (!stream) return Promise.resolve();
  const closing = stream;
  stream = null;
  return new Promise((resolve) => closing.end(resolve));
}

module.exports = {
  log, timed, count, flushCounters,
  enableLog, getLogPath, defaultLogPath, closeLog,
};
