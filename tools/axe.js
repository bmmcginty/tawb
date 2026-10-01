#!/usr/bin/env node
'use strict';

// Audit a rendered page with axe-core inside the same ordinary browser TAWB
// drives. This reports authoring barriers in the page; it complements, rather
// than replaces, tests of TAWB's own accessibility extraction and controls.

const path = require('node:path');
const axe = require('axe-core');
const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver'));

const USAGE = 'Usage: npm run axe -- [--browser chromium|firefox] [--tags tag,tag] <url> [...]';

function parseArgs(argv) {
  const options = { engine: 'chromium', tags: [], urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browser') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`--browser needs a value. ${USAGE}`);
      options.engine = argv[++i];
    } else if (arg.startsWith('--browser=')) {
      options.engine = arg.slice('--browser='.length);
    } else if (arg === '--tags') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`--tags needs a value. ${USAGE}`);
      options.tags = argv[++i].split(',').filter(Boolean);
    } else if (arg.startsWith('--tags=')) {
      options.tags = arg.slice('--tags='.length).split(',').filter(Boolean);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unrecognized argument ${arg}. ${USAGE}`);
    } else {
      options.urls.push(arg);
    }
  }
  if (!['chromium', 'firefox'].includes(options.engine)) {
    throw new Error(`Unknown browser ${JSON.stringify(options.engine)}. ${USAGE}`);
  }
  if (!options.urls.length) throw new Error(`At least one URL is required. ${USAGE}`);
  return options;
}

async function auditPage(page, { tags = [] } = {}) {
  // Supplying the source as data to a function keeps this on the driver's
  // normal evaluate path for both CDP and BiDi. DevTools evaluation is not
  // blocked by a page's script-src policy, unlike adding an inline script tag.
  await page.evaluate((source) => { (0, eval)(source); }, axe.source); // eslint-disable-line no-eval
  return page.evaluate(async (runTags) => {
    const options = runTags.length ? { runOnly: { type: 'tag', values: runTags } } : {};
    const result = await globalThis.axe.run(document, options);
    return {
      testEngine: result.testEngine,
      passes: result.passes.length,
      incomplete: result.incomplete.length,
      inapplicable: result.inapplicable.length,
      violations: result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        helpUrl: violation.helpUrl,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
          html: node.html,
        })),
      })),
    };
  }, tags);
}

function printReport(url, report) {
  console.log(`\n${url}`);
  console.log(`  axe-core ${report.testEngine.version}: ${report.violations.length} violation(s), `
    + `${report.passes} pass(es), ${report.incomplete} needing review`);
  for (const violation of report.violations) {
    console.log(`  ${violation.impact || 'unknown'} ${violation.id}: ${violation.help}`);
    console.log(`    ${violation.helpUrl}`);
    for (const node of violation.nodes) {
      console.log(`    ${node.target.join(' ')}`);
      if (node.summary) console.log(`      ${node.summary.replace(/\s+/g, ' ').trim()}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const driver = await openDriver({ engine: options.engine, log: () => {} });
  let failed = false;
  try {
    const page = driver.context.pages()[0] || await driver.context.newPage();
    for (const url of options.urls) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      const report = await auditPage(page, { tags: options.tags });
      printReport(url, report);
      if (report.violations.length) failed = true;
    }
  } finally {
    await driver.close().catch(() => {});
  }
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${String(err && err.message ? err.message : err)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, auditPage, printReport };
