'use strict';

// The tab inventory against a real Chromium, differenced between the
// JavaScript driver and the Crystal port.
//
// Nothing about this can be settled without a browser: what a listing
// contains is the browser's own answer, and it contains more than tabs —
// extension background pages, the browser's own interface windows, targets
// that are still being created. Which of those a reader is offered, and
// whether a tab it opened and closed leaves the list, is what this asks.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const { call } = require('../crystal_impl');
const { openDriver } = require('../../src/driver');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

const PAGE = '<!doctype html><html><head><title>Fixture page</title></head>'
  + '<body><h1>Fixture heading</h1></body></html>';

// The browser's own record of where it is listening, written by whichever
// runtime launched it.
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

// The same questions the Crystal conformance op asks, through the driver the
// JavaScript reader uses.
async function javascriptScenario(endpoint, url) {
  const driver = await openDriver({ engine: 'chromium', connect: endpoint });
  try {
    const before = driver.context.pages().length;
    const opened = await driver.context.newPage();
    await opened.goto(url, { waitUntil: 'domcontentloaded' });
    const after = driver.context.pages();
    const title = await opened.title();
    const target = await driver.targetIdFor(opened);
    await driver.context.closePage(opened);
    const remaining = driver.context.pages();
    const idFor = async (page) => driver.targetIdFor(page);
    const afterIds = await Promise.all(after.map(idFor));
    const remainingIds = await Promise.all(remaining.map(idFor));
    return {
      before,
      after: after.length,
      remaining: remaining.length,
      title,
      url: after.map((page) => page.url()),
      targeted: afterIds.includes(target),
      gone: !remainingIds.includes(target),
    };
  } finally {
    await driver.close({ keepBrowser: true }).catch(() => {});
  }
}

test('both runtimes see the same tabs, and the same tab opening and closing',
  { skip }, async () => {
    const root = tempDir('tawb-crystal-tabs-');
    const profile = path.join(root, 'profile');
    const page = path.join(root, 'page.html');
    fs.writeFileSync(page, PAGE);
    const url = `file://${page}`;
    const env = {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
    };
    fs.mkdirSync(env.HOME, { recursive: true });

    try {
      // The browser is launched by the reader itself and kept, so both
      // runtimes are asking the same browser the same questions.
      const launched = spawnSync(BINARY, [
        '--dump', '--keep-browser', '--profile', profile, url,
      ], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
      assert.equal(launched.status, 0, launched.stderr);
      const endpoint = `http://127.0.0.1:${portFrom(profile)}`;

      const crystal = call('cdp.tabs_scenario', { endpoint, url });
      const javascript = await javascriptScenario(endpoint, url);

      assert.deepEqual(crystal, javascript);
      assert.equal(crystal.after, crystal.before + 1, 'the opened tab is in the list');
      assert.equal(crystal.remaining, crystal.before, 'and the closed one is not');
      assert.equal(crystal.title, 'Fixture page', 'read through the tab that was opened');
      assert.equal(crystal.targeted, true);
      assert.equal(crystal.gone, true);
    } finally {
      killProfile(profile);
      removeTempDir(root);
    }
  });
