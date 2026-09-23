#!/usr/bin/env node
'use strict';

// One-shot Firefox startup report for machines that cannot be inspected
// interactively. It uses the ordinary TAWB launch path, a fresh profile, and
// writes every startup transition plus several document-lifetime probes to one
// diagnostic log.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDriver } = require('../src/driver');
const { enableLog, getLogPath, log, closeLog } = require('../src/log');

function parseArgs(argv, env = process.env) {
  const options = { logDir: env.TAWB_LOG_DIR || null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log-dir') { options.logDir = argv[i + 1] || null; i += 1; }
    else if (arg.startsWith('--log-dir=')) options.logDir = arg.slice('--log-dir='.length) || null;
  }
  return options;
}

async function pageState(page, phase) {
  try {
    const state = await page.evaluate((probePhase) => {
      const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
      return {
        phase: probePhase,
        url: location.href,
        readyState: document.readyState,
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        getter: descriptor && descriptor.get ? Function.prototype.toString.call(descriptor.get) : null,
      };
    }, phase);
    log('diagnose.firefox.page', state);
    return state;
  } catch (err) {
    const state = { phase, error: String(err && err.message ? err.message : err).slice(0, 500) };
    log('diagnose.firefox.page', state);
    return state;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-firefox-diagnose-'));
  enableLog({ directory: options.logDir });
  const report = { profileKind: 'fresh-temporary', probes: [] };
  let driver = null;
  let failed = null;

  log('diagnose.firefox.start', { profileKind: report.profileKind });
  try {
    driver = await openDriver({
      engine: 'firefox', profile, broker: true, diagnoseAutomation: true, log,
    });
    const existing = driver.context.pages()[0] || await driver.context.newPage();
    report.probes.push(await pageState(existing, 'existing-after-open'));

    const blank = await driver.context.newPage();
    report.probes.push(await pageState(blank, 'new-about-blank'));
    await blank.goto(
      'data:text/html;charset=utf-8,<title>TAWB Firefox diagnostic</title><p>diagnostic</p>',
      { waitUntil: 'domcontentloaded' },
    );
    report.probes.push(await pageState(blank, 'same-context-after-navigation'));
    await blank.close();

    const fresh = await driver.context.newPage();
    report.probes.push(await pageState(fresh, 'second-new-about-blank'));
    await fresh.close();
  } catch (err) {
    failed = err;
    report.error = String(err && err.stack ? err.stack : err).slice(0, 4000);
    log('diagnose.firefox.error', { error: report.error });
  } finally {
    if (driver) await driver.close().catch((err) => {
      log('diagnose.firefox.close-error', {
        error: String(err && err.message ? err.message : err).slice(0, 500),
      });
    });
    log('diagnose.firefox.report', report);
    fs.rmSync(profile, { recursive: true, force: true });
    await closeLog();
  }

  process.stdout.write(`Firefox diagnostic log: ${getLogPath()}\n`);
  if (failed) {
    process.stderr.write(`${String(failed.message || failed)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((err) => {
  process.stderr.write(`${String(err && err.stack ? err.stack : err)}\n`);
  process.exitCode = 1;
});

module.exports = { parseArgs, pageState };
