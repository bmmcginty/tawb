'use strict';

// Prove that the shared CDP/BiDi evaluate path can inject and run axe-core.
// The command audits websites, not TAWB: this integration test keeps a future
// protocol or axe upgrade from turning that command into an empty report.

const test = require('node:test');
const assert = require('node:assert');

const { tempDir, removeTempDir } = require('../tmpdir');
const { openDriver } = require('../../src/driver');
const { auditPage } = require('../../tools/axe');

const ENGINE = process.env.TWEB_TEST_BROWSER || 'chromium';
const profile = tempDir('tweb-axe-');
let driver;

test.after(async () => {
  if (driver) await driver.close().catch(() => {});
  removeTempDir(profile);
});

test('axe-core audits the rendered page through the selected browser driver', async () => {
  driver = await openDriver({ engine: ENGINE, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  const html = `<!doctype html><html lang="en"><head><title>Axe fixture</title></head>
    <body><main><h1>Fixture</h1><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></main></body></html>`;
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);

  const report = await auditPage(page, { tags: ['wcag2a', 'wcag2aa'] });
  assert.match(report.testEngine.version, /^4\./);
  assert.ok(report.violations.some((violation) => violation.id === 'image-alt'));
  assert.ok(report.violations.find((violation) => violation.id === 'image-alt').nodes.length > 0);
});
