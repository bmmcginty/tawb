'use strict';

// How the command line becomes the options that describe a browser session.
//
// The full-screen reader and the edbrowse front end are different programs
// driving the same browser, so the options they share are resolved in one
// place rather than parsed twice. Each entry point adds its own options to the
// shared table and reads the fields it needs from the result.
//
// This is more than tokenizing: the environment supplies some defaults and a
// couple of values are transformed — a connect address, a timeout given in
// seconds. The module is named for what it resolves, not merely for the parse.

const { parseArgs } = require('node:util');

const { normaliseEndpoint } = require('./browser');
const { DEFAULT_ENGINE } = require('./driver');

// What a browser session needs, whichever front end is driving it.
const BROWSER_OPTIONS = {
  connect: { type: 'string' },
  profile: { type: 'string' },
  browser: { type: 'string' },
  'keep-browser': { type: 'boolean' },
  log: { type: 'boolean' },
  'log-dir': { type: 'string' },
  'browser-timeout': { type: 'string' },
};

// --browser-timeout takes seconds, like TAWB_BROWSER_TIMEOUT, and is kept as
// milliseconds because that is the unit the browser launch waits in.
function browserTimeoutMs(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--browser-timeout needs a positive number of seconds, not ${value}`);
  }
  return Math.round(seconds * 1000);
}

// Parse with the standard parser and the strict rules the table describes: an
// unknown option or a missing value is an error, a bare -- still lets a
// positional start with a dash, and a boolean may be spelled --no-x.
function parseCommandLine(argv, { options, env = process.env } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });
  return { values, url: positionals[0] || null };
}

// Every entry point takes --help. The text belongs to the entry point, since
// what the options mean depends on which program is running, so this is only
// the option the parser has to accept.
const HELP_OPTION = {
  help: { type: 'boolean', short: 'h' },
};

// What only the edbrowse front end has: the port its http origin listens on.
const EDB_OPTIONS = {
  port: { type: 'string' },
};

function portNumber(value) {
  if (value == null) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port needs a number between 0 and 65535, not ${value}`);
  }
  return port;
}

function resolveEdbOptions(values) {
  return { port: portNumber(values.port) };
}

// The shared half of the resolved options, in the shape both front ends read.
// A boolean is read with ?? rather than ||: --no-keep-browser is false, and a
// falling through to the default would turn the opt-out off.
function resolveBrowserOptions(values, env = process.env) {
  return {
    connect: values.connect ? normaliseEndpoint(values.connect) : null,
    profile: values.profile || null,
    engine: values.browser || DEFAULT_ENGINE,
    keepBrowser: values['keep-browser'] ?? false,
    log: values.log ?? false,
    logDir: values['log-dir'] || env.TAWB_LOG_DIR || null,
    browserTimeoutMs: browserTimeoutMs(values['browser-timeout']),
  };
}

module.exports = {
  BROWSER_OPTIONS, EDB_OPTIONS, HELP_OPTION, browserTimeoutMs, parseCommandLine,
  resolveBrowserOptions, resolveEdbOptions,
};
