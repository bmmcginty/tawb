#!/usr/bin/env node
'use strict';

const { openDriver, DEFAULT_ENGINE } = require('./driver');
const { normaliseEndpoint } = require('./browser');
const { startEdbServer } = require('./edb_server');
const { log, timed, LOG_PATH } = require('./log');

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
//
// It prints the addresses to use, writes them to ~/.local/share/tui-browser/
// edb.json for the entry-point plugin to find, and then stays out of the way
// until you stop it.

function parseArgs(argv) {
  const options = {
    engine: DEFAULT_ENGINE, connect: null, profile: null, keepBrowser: false,
    port: 0, url: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browser') { options.engine = argv[i + 1] || DEFAULT_ENGINE; i += 1; }
    else if (arg.startsWith('--browser=')) options.engine = arg.slice('--browser='.length);
    else if (arg === '--connect') { options.connect = normaliseEndpoint(argv[i + 1] || ''); i += 1; }
    else if (arg.startsWith('--connect=')) options.connect = normaliseEndpoint(arg.slice('--connect='.length));
    else if (arg === '--profile') { options.profile = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg === '--keep-browser') options.keepBrowser = true;
    else if (arg === '--port') { options.port = Number(argv[i + 1] || 0); i += 1; }
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (!arg.startsWith('-') && !options.url) options.url = arg;
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('edb.start', { engine: args.engine, logPath: LOG_PATH });

  const driver = await timed('browser.start', { engine: args.engine }, () => openDriver({
    engine: args.engine,
    connect: args.connect,
    profile: args.profile,
    keepBrowser: args.keepBrowser,
    log,
  }));

  const server = await startEdbServer({ driver, port: args.port });

  let first = null;
  if (args.url) {
    const page = await driver.newTab();
    await page.goto(args.url, { waitUntil: 'domcontentloaded' });
    first = server.tabUrl(server.tabs.numberFor(page));
  }

  process.stdout.write(`tweb is serving ${args.engine} for edbrowse.\n\n`);
  process.stdout.write(`  tabs:   ${server.url}\n`);
  if (first) process.stdout.write(`  page:   ${first}\n`);
  process.stdout.write(`  open:   b tweb://<url>      (with the plugin installed)\n`);
  process.stdout.write(`\nStop with ctrl-c; the browser stays as you left it.\n`);

  const shutdown = async (code) => {
    await server.close().catch(() => {});
    await driver.close().catch(() => {});
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { parseArgs };
