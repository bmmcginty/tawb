'use strict';

// Chromium's own bookmarks and history, against a real browser, differenced
// between the JavaScript driver and the Crystal port.
//
// There is nothing to stub that would prove anything here: what the reader's
// bookmark and history screens amount to is entirely the browser answering,
// and the way it is asked is to open the page that owns each list and call the
// interface that page publishes. Whether that still works is a question only a
// real Chromium can settle, and whether both runtimes get the same answer out
// of it is what this asks.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const { callAsync } = require('../crystal_impl');
const { openDriver } = require('../../src/driver');
const {
  readChromiumLibrary, saveChromiumBookmark, removeChromiumBookmark,
} = require('../../src/library_chromium');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'dist', 'tawb-crystal');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

const PAGE = '<!doctype html><html><head><title>Filed page</title></head>'
  + '<body><h1>Filed heading</h1></body></html>';

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

// Only the parts of an answer that mean the same thing twice: a bookmark id
// and a timestamp are the browser's own and differ between two runs.
function kept(entry) {
  if (!entry) return null;
  const out = {};
  for (const name of ['title', 'url', 'folder', 'existed']) {
    if (entry[name] !== undefined) out[name] = entry[name];
  }
  return out;
}

// The same questions the Crystal conformance op asks, through the library the
// JavaScript reader uses.
async function javascriptScenario(endpoint, url, title) {
  const driver = await openDriver({ engine: 'chromium', connect: endpoint });
  const context = driver.context;
  try {
    const saved = await saveChromiumBookmark(context, { url, title });
    const again = await saveChromiumBookmark(context, { url, title });
    const bookmarks = await readChromiumLibrary(context, 'bookmarks');
    const history = await readChromiumLibrary(context, 'history');
    const downloads = await readChromiumLibrary(context, 'downloads');
    const mine = bookmarks.filter((entry) => entry.url === url);
    const removal = mine.length
      ? await removeChromiumBookmark(context, mine[0])
      : null;
    const after = await readChromiumLibrary(context, 'bookmarks');
    return {
      saved: kept(saved),
      again: kept(again),
      bookmarks: mine.map(kept),
      history: history.filter((entry) => entry.url === url).map(kept),
      downloads: downloads.length,
      removed: !!(removal && removal.removed),
      left: after.filter((entry) => entry.url === url).length,
    };
  } finally {
    await driver.close({ keepBrowser: true }).catch(() => {});
  }
}

test('both runtimes file, read and remove a bookmark through Chromium\'s own pages',
  { skip }, async () => {
    const root = tempDir('tawb-crystal-library-');
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
      // Visiting the page is what puts it in the browser's history, and the
      // reader doing it is what keeps this about one browser.
      const launched = await run(BINARY, [
        '--dump', '--keep-browser', '--profile', profile, url,
      ], { cwd: ROOT, env });
      assert.equal(launched.status, 0, launched.stderr);
      const endpoint = `http://127.0.0.1:${portFrom(profile)}`;

      const crystal = await callAsync('cdp.library_scenario',
        { endpoint, url, title: 'Filed page' }, { timeoutMs: 120000 });
      const javascript = await javascriptScenario(endpoint, url, 'Filed page');

      assert.deepEqual(crystal.saved, javascript.saved);
      assert.equal(crystal.saved.existed, false, 'the first filing is a new bookmark');
      assert.equal(crystal.saved.title, 'Filed page');
      assert.ok(crystal.saved.folder, 'and it says which folder it went in');

      assert.deepEqual(crystal.again, javascript.again);
      assert.equal(crystal.again.existed, true,
        'a browser does not make a second bookmark of a page already bookmarked');

      assert.deepEqual(crystal.bookmarks, javascript.bookmarks);
      assert.equal(crystal.bookmarks.length, 1);
      assert.equal(crystal.bookmarks[0].url, url);

      assert.deepEqual(crystal.history, javascript.history);
      assert.equal(crystal.history.length, 1, 'the page the reader visited is in history');

      assert.deepEqual(crystal.downloads, javascript.downloads,
        'and the downloads page answers, even with nothing to answer with');

      assert.deepEqual(crystal.removed, javascript.removed);
      assert.equal(crystal.removed, true);
      assert.deepEqual(crystal.left, javascript.left);
      assert.equal(crystal.left, 0, 'and the removed bookmark is gone');
    } finally {
      killProfile(profile);
      removeTempDir(root);
    }
  });
