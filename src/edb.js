#!/usr/bin/env node
'use strict';

const { openDriver } = require('./driver');
const { startEdbServer } = require('./edb_server');
const { log, timed, enableLog } = require('./log');
const { readSettings } = require('./settings');
const {
  BROWSER_OPTIONS, EDB_OPTIONS, HELP_OPTION, parseCommandLine,
  resolveBrowserOptions, resolveEdbOptions,
} = require('./options');

// The edbrowse side of tweb: a browser, and an http origin that serves it.
//
// Same browser as the reader — started normally, attached to, never launched
// by an automation harness — for the same reason: a browser that fails bot
// checks is not a degraded reader, it is a broken one. What differs is who
// does the reading. Here edbrowse renders the html and owns the screen, and
// this process is only the thing that knows how to drive a real browser.
//
//     npm run edb
//     npm run edb -- --browser firefox
//     tawb --front-end edb
//
// It prints the addresses to use, writes them to ~/.local/share/tawb/
// edb.json for the entry-point plugin to find, and then stays out of the way
// until you stop it.

function parseArgs(argv, env = process.env) {
  const { values, url } = parseCommandLine(argv, {
    options: { ...BROWSER_OPTIONS, ...EDB_OPTIONS, ...HELP_OPTION }, env,
  });
  return {
    ...resolveBrowserOptions(values, env),
    ...resolveEdbOptions(values),
    url,
    help: values.help ?? false,
  };
}

// The bridge itself, exported so `tawb --front-end edb` runs exactly this and
// not a second copy of it. `args` is what parseArgs resolved.
async function runEdb(args) {
  const logPath = args.log ? enableLog({ directory: args.logDir }) : null;
  log('edb.start', { engine: args.engine, logPath });

  // One way to get a browser, used twice: once now, and again whenever the
  // reader closes the one they were reading. Nothing about this server
  // outlives a browser, so the second time has to be the same as the first —
  // an ordinary browser, started or rejoined exactly as before, never an
  // automated one.
  const open = () => openDriver({
    engine: args.engine,
    connect: args.connect,
    profile: args.profile,
    keepBrowser: args.keepBrowser,
    browserTimeoutMs: args.browserTimeoutMs,
    log,
  });

  const driver = await timed('browser.start', { engine: args.engine }, open);

  const server = await startEdbServer({
    driver,
    reopen: () => timed('browser.restart', { engine: args.engine }, open),
    port: args.port,
  });

  let first = null;
  if (args.url) {
    const page = await driver.newTab();
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    first = server.tabUrl(server.tabs.numberFor(page));
  }

  process.stdout.write(`tweb is serving ${args.engine} for edbrowse.\n\n`);
  process.stdout.write(`  tabs:   ${server.url}\n`);
  if (first) process.stdout.write(`  page:   ${first}\n`);
  process.stdout.write(`  open:   <t <address>        in edbrowse, once the plugin is\n`);
  process.stdout.write(`                              installed — see edbrowse-plugin/\n`);
  process.stdout.write(`\nStop with ctrl-c; the browser stays as you left it.\n`);

  const shutdown = async (code) => {
    await server.close().catch(() => {});
    await server.driver.close().catch(() => {});
    process.exit(code);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { shutdown(0).catch(() => process.exit(0)); });
  }
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      console.error(err);
      log('edb.crash', { event, error: String(err && err.message ? err.message : err).slice(0, 300) });
      shutdown(1).catch(() => process.exit(1));
    });
  }
}

const USAGE = [
  'Usage: edb [options] [address]',
  '',
  'Run the edbrowse bridge: a browser and an http origin that serves it.',
  '',
  '  --browser <name>              chromium or firefox',
  '  --connect <port|url>          attach to a browser already running',
  '  --profile <dir>               the browser profile to use',
  '  --keep-browser                leave the browser running after quitting',
  '  --browser-timeout <seconds>   how long to wait for the browser to start',
  '  --port <number>               the port to listen on',
  '  --log                         write a diagnostic log',
  '  --log-dir <dir>               where to write it (TAWB_LOG_DIR)',
  '  -h, --help                    show this help and exit',
  '',
].join('\n');

async function main() {
  const args = parseArgs([...readSettings(), ...process.argv.slice(2)]);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  await runEdb(args);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs, runEdb };
