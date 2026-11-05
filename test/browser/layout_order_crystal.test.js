'use strict';

// The purchase-card fixture through both real-browser runtimes.
//
//     TAWB_TEST_CRYSTAL_BROWSER=1 node --test test/browser/layout_order_crystal.test.js
//
// The JavaScript and native cores must see the same geometry, move the same
// blocks for each diagnostic order, and resolve the moved Add to cart button
// back to its own element. Both engines are exercised here rather than left
// to whichever TWEB_TEST_BROWSER names, because the point is parity between
// the runtimes against a browser, not one runtime's view of one engine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const { callAsync } = require('../crystal_impl');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const URL = `file://${path.join(__dirname, 'walmart_layout.html')}`;
const SOURCES = ['render', 'ax'];
const ORDERS = ['default', 'container', 'rectangle'];
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function portFrom(profile) {
  for (const name of ['tawb-endpoint.json', '.tawb-devtools-port', 'DevToolsActivePort']) {
    const file = path.join(profile, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (name === 'DevToolsActivePort') return Number(text.split('\n')[0]);
    try {
      return Number(JSON.parse(text).port);
    } catch {
      return Number(text);
    }
  }
  throw new Error(`no endpoint record under ${profile}`);
}

function killProfile(profile) {
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function kept(block) {
  const item = block.item || {};
  const index = item.renderIndex !== undefined ? item.renderIndex
    : item.domIndex !== undefined ? item.domIndex
      : item.axIndex !== undefined ? item.axIndex : null;
  return {
    text: block.text,
    role: item.role === undefined ? null : item.role,
    name: item.name === undefined ? null : item.name,
    index: index === undefined ? null : index,
    framed: !!item.frame,
  };
}

async function javascriptLayout(engine, profile) {
  const driver = await openDriver({ engine, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    const observations = [];
    for (const source of SOURCES) {
      for (const order of ORDERS) {
        const core = new Core({ driver, page, source, sources: [source], layoutOrder: order });
        const blocks = await core.rescan({ page });
        await page.evaluate(() => { window.presses = 0; });
        const target = blocks.find((block) => block.text.includes('Add to cart'));
        if (target) await core.activate(target.item, page);
        observations.push({
          source,
          order,
          blocks: blocks.map(kept),
          activated: !!target,
          presses: await page.evaluate(() => window.presses || 0),
        });
      }
    }
    return observations;
  } finally {
    await driver.close().catch(() => {});
  }
}

for (const engine of ['chromium', 'firefox']) {
  test(`the purchase card and its button agree between runtimes through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-layout-${engine}-`);
      const native = path.join(root, 'native');
      const other = path.join(root, 'javascript');
      const env = {
        ...process.env,
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
      };
      fs.mkdirSync(env.HOME, { recursive: true });
      try {
        // The native reader launches and keeps the browser it reads with, so
        // the native core can be asked the same questions afterwards.
        const launched = await run(BINARY, [
          '--dump', '--keep-browser', '--browser', engine, '--profile', native, URL,
        ], { cwd: ROOT, env });
        assert.equal(launched.status, 0, launched.stderr);

        // Chromium is reached at its own endpoint. Firefox allows one protocol
        // session per browser, so the conformance operation joins the broker
        // that is already holding the kept browser, named by its profile.
        const endpoint = engine === 'firefox' ? '' : `http://127.0.0.1:${portFrom(native)}`;
        const nativeLayout = await callAsync('core.layout_scenario', {
          endpoint, engine, url: URL, profile: native,
          sources: SOURCES, orders: ORDERS, activate: 'Add to cart',
        }, { timeoutMs: 120000 });
        const javascript = await runWithRetry(() => javascriptLayout(engine, other));

        assert.deepEqual(nativeLayout, javascript,
          `the diagnostic layout differs between the runtimes through ${engine}`);
        for (const observation of nativeLayout) {
          assert.equal(observation.activated, true,
            `${observation.source}/${observation.order} lost the Add to cart button`);
          assert.equal(observation.presses, 1,
            `${observation.source}/${observation.order} did not activate its own button`);
        }
      } finally {
        killProfile(native);
        killProfile(other);
        removeTempDir(root);
      }
    });
}

// A profile directory being removed and recreated between the dump and the
// reader can leave Chromium's endpoint file a moment stale. Retry the
// JavaScript half only, so a slow browser start does not read as a difference.
async function runWithRetry(runOnce, attempts = 2) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await runOnce();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw last;
}
