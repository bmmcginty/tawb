'use strict';

// Reads one page in one browser and prints the lines, without a terminal.
//
//   npm run dump                          # the test page, AX view, Chromium
//   npm run dump -- --view render
//   npm run dump -- --browser firefox
//   npm run dump -- https://example.com
//
// compare.js answers "do the two engines agree"; this answers "what does one
// of them actually say", which is what you want while changing what it says.
// With no URL it serves tools/testpage.html and reads that, so there is
// always something to point it at.

const path = require('path');
const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver.js'));
const { snapshotFrameTree } = require(path.join(__dirname, '..', 'src', 'frames.js'));
const { start } = require(path.join(__dirname, 'serve.js'));

function parseArgs(argv) {
  const options = { url: null, view: 'ax', engine: 'chromium', settleMs: 1500, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--view') { options.view = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--view=')) options.view = arg.slice('--view='.length);
    else if (arg === '--browser') { options.engine = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--browser=')) options.engine = arg.slice('--browser='.length);
    else if (arg === '--settle') { options.settleMs = Number(argv[i + 1]); i += 1; }
    else if (arg === '--verbose') options.verbose = true;
    else if (!arg.startsWith('-') && !options.url) options.url = arg;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let server = null;
  let url = options.url;
  if (!url) {
    const served = await start(0);
    server = served.server;
    url = served.url;
    process.stderr.write(`serving the test page at ${url}\n`);
  }

  const driver = await openDriver({
    engine: options.engine,
    log: options.verbose ? (e, d) => process.stderr.write(`  ${e} ${JSON.stringify(d)}\n`) : () => {},
  });

  try {
    const page = driver.context.pages()[0] || await driver.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Modern pages arrive in pieces; give scripts a moment before reading.
    await new Promise((r) => setTimeout(r, options.settleMs));

    // The one fact worth printing above the lines: a browser announcing
    // itself as automated is a broken reader, whatever its output looks like.
    const webdriver = await page.evaluate(() => navigator.webdriver);
    process.stderr.write(`${options.engine}, ${options.view} view, navigator.webdriver=${webdriver}\n`);
    if (webdriver !== false) {
      process.stderr.write('  !! this browser is announcing itself as automated\n');
    }

    const blocks = await snapshotFrameTree(page, options.view, { driver });
    blocks.forEach((block, i) => console.log(`${String(i).padStart(4)}  ${block.text}`));
  } finally {
    await driver.close().catch(() => {});
    if (server) server.close();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
