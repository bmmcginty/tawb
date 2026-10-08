'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../tmpdir');

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
});
