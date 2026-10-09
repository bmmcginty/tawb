'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../tmpdir');
const cdp = require('../../src/cdp');

const ROOT = path.join(__dirname, '..', '..');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';

test('the static Crystal dump matches JavaScript on a real Chromium page', { skip: !enabled }, () => {
  const root = tempDir('tawb-crystal-dump-');
  const page = path.join(root, 'page.html');
  fs.writeFileSync(page, `<!doctype html><html><body>
    <h1>Heading</h1><p>Hello <a href="https://example.test/">Docs</a> after</p>
    <button>Save</button></body></html>`);

  const baseEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  fs.mkdirSync(baseEnv.HOME, { recursive: true });
  const run = (command, args, dataName) => spawnSync(command, args, {
    cwd: ROOT,
    env: { ...baseEnv, XDG_DATA_HOME: path.join(root, dataName) },
    encoding: 'utf8',
    timeout: 90000,
  });

  const javascript = run(process.execPath, ['src/index.js', '--dump', page], 'js-data');
  const crystal = run(path.join(ROOT, 'dist', 'tawb-crystal'), ['--dump', page], 'crystal-data');

  assert.equal(javascript.status, 0, javascript.stderr);
  assert.equal(crystal.status, 0, crystal.stderr);
  assert.equal(crystal.stderr, '');
  assert.equal(crystal.stdout, javascript.stdout);
  assert.equal(crystal.stdout, '# Heading\nHello\n{Docs}\nafter\n[*Save]\n');

  const firefox = run(path.join(ROOT, 'dist', 'tawb-crystal'), [
    '--dump', '--browser', 'firefox', page,
  ], 'crystal-firefox-data');
  assert.equal(firefox.status, 1);
  assert.match(firefox.stderr, /native Firefox dump is not ported/);
});

test('a kept native Chromium is rejoined through its profile', { skip: !enabled }, async () => {
  const root = tempDir('tawb-crystal-keep-');
  const profile = path.join(root, 'profile');
  const page = path.join(root, 'page.html');
  fs.writeFileSync(page, '<!doctype html><title>Kept</title><p>Still here</p>');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const executable = path.join(ROOT, 'dist', 'tawb-crystal');
  const run = (...extra) => spawnSync(executable, [
    '--dump', '--profile', profile, ...extra, page,
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 90000 });

  const first = run('--keep-browser');
  assert.equal(first.status, 0, first.stderr);
  const port = fs.readFileSync(path.join(profile, '.tawb-devtools-port'), 'utf8').trim();
  const endpoint = `http://127.0.0.1:${port}`;
  let connection;
  try {
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.stdout, 'Still here\n');
    connection = await cdp.connect(endpoint);
    await connection.browser.send('Browser.close');
  } finally {
    if (!connection) {
      try {
        connection = await cdp.connect(endpoint);
        await connection.browser.send('Browser.close');
      } catch { /* best-effort cleanup after an assertion failure */ }
    }
    if (connection) connection.close();
  }
});
