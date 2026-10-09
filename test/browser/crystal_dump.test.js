'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../tmpdir');
const cdp = require('../../src/cdp');
const { processesUsing } = require('../../src/proc');

const ROOT = path.join(__dirname, '..', '..');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';

function runAsync(command, args, options) {
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

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('the static Crystal dump matches JavaScript on a real Chromium page', { skip: !enabled }, () => {
  const root = tempDir('tawb-crystal-dump-');
  const page = path.join(root, 'page.html');
  fs.writeFileSync(page, `<!doctype html><html><body>
    <h1>Heading</h1><p>Hello <a href="https://example.test/">Docs</a> after</p>
    <iframe title="Details" srcdoc="<h2>Inside</h2><p>Child words</p>"></iframe>
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
  assert.equal(crystal.stdout, '# Heading\nHello\n{Docs}\nafter\n<frame: Details>\n## Inside\nChild words\n[*Save]\n');

  fs.mkdirSync(path.join(baseEnv.XDG_CONFIG_HOME, 'tawb'), { recursive: true });
  fs.writeFileSync(path.join(baseEnv.XDG_CONFIG_HOME, 'tawb', 'settings.lynx.json'), JSON.stringify({
    version: 1,
    lynx: { keypadMode: 'LINKS_AND_FIELDS_ARE_NUMBERED' },
  }));
  const javascriptLynx = run(process.execPath,
    ['src/index.js', '--front-end', 'lynx', '--dump', page], 'js-lynx-data');
  const crystalLynx = run(path.join(ROOT, 'dist', 'tawb-crystal'),
    ['--front-end', 'lynx', '--dump', page], 'crystal-lynx-data');
  assert.equal(javascriptLynx.status, 0, javascriptLynx.stderr);
  assert.equal(crystalLynx.status, 0, crystalLynx.stderr);
  assert.equal(crystalLynx.stdout, javascriptLynx.stdout);
  assert.match(crystalLynx.stdout, /^\s+Heading/m);
  assert.match(crystalLynx.stdout, /^\s+Hello \[1\]Docs after/m);
  assert.match(crystalLynx.stdout, /^\s+\[2\]Save/m);
});

test('the native Firefox dump matches JavaScript on a real Firefox page', { skip: !enabled }, () => {
  const root = tempDir('tawb-crystal-firefox-dump-');
  const page = path.join(root, 'page.html');
  fs.writeFileSync(page, `<!doctype html><html><body>
    <h1>Heading</h1><p>Hello <a href="https://example.test/">Docs</a> after</p>
    <iframe title="Details" srcdoc="<h2>Inside</h2><p>Child words</p>"></iframe>
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
    timeout: 120000,
  });

  const javascript = run(process.execPath, [
    'src/index.js', '--dump', '--browser', 'firefox', page,
  ], 'js-data');
  const crystal = run(path.join(ROOT, 'dist', 'tawb-crystal'), [
    '--dump', '--browser', 'firefox', page,
  ], 'crystal-data');
  assert.equal(javascript.status, 0, javascript.stderr);
  assert.equal(crystal.status, 0, crystal.stderr);
  assert.equal(crystal.stderr, '');
  assert.equal(crystal.stdout, javascript.stdout);
  assert.equal(crystal.stdout,
    '# Heading\nHello\n{Docs}\nafter\n<frame: Details>\n## Inside\nChild words\n[*Save]\n');

  const javascriptLynx = run(process.execPath, [
    'src/index.js', '--front-end', 'lynx', '--dump', '--browser', 'firefox', page,
  ], 'js-lynx-data');
  const crystalLynx = run(path.join(ROOT, 'dist', 'tawb-crystal'), [
    '--front-end', 'lynx', '--dump', '--browser', 'firefox', page,
  ], 'crystal-lynx-data');
  assert.equal(javascriptLynx.status, 0, javascriptLynx.stderr);
  assert.equal(crystalLynx.status, 0, crystalLynx.stderr);
  assert.equal(crystalLynx.stdout, javascriptLynx.stdout);
});

test('the native dump reads a closed shadow root through CDP', { skip: !enabled }, () => {
  const root = tempDir('tawb-crystal-shadow-');
  const page = path.join(root, 'page.html');
  fs.writeFileSync(page, `<!doctype html><div id="host"></div><script>
    document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed shadow action</button>';
  </script>`);
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const run = (command, args, dataName) => spawnSync(command, args, {
    cwd: ROOT,
    env: { ...env, XDG_DATA_HOME: path.join(root, dataName) },
    encoding: 'utf8',
    timeout: 90000,
  });
  const javascript = run(process.execPath, ['src/index.js', '--dump', page], 'js-data');
  const crystal = run(path.join(ROOT, 'dist', 'tawb-crystal'), ['--dump', page], 'crystal-data');
  assert.equal(javascript.status, 0, javascript.stderr);
  assert.equal(crystal.status, 0, crystal.stderr);
  assert.equal(crystal.stdout, javascript.stdout);
  assert.equal(crystal.stdout, '[*Closed shadow action]\n');
});

test('the native dump includes an out-of-process iframe', { skip: !enabled }, async () => {
  const root = tempDir('tawb-crystal-cross-frame-');
  const childServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><p>Words from the other origin.</p>');
  });
  const parentServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><h1>Parent document</h1>
      <iframe title="foreign frame" src="http://localhost:${childServer.address().port}/"></iframe>`);
  });
  await listen(childServer);
  await listen(parentServer, '127.0.0.1');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  const url = `http://127.0.0.1:${parentServer.address().port}/`;
  try {
    const javascript = await runAsync(process.execPath, ['src/index.js', '--dump', url], {
      cwd: ROOT, env: { ...env, XDG_DATA_HOME: path.join(root, 'js-data') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const crystal = await runAsync(path.join(ROOT, 'dist', 'tawb-crystal'), ['--dump', url], {
      cwd: ROOT, env: { ...env, XDG_DATA_HOME: path.join(root, 'crystal-data') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(javascript.status, 0, javascript.stderr);
    assert.equal(crystal.status, 0, crystal.stderr);
    assert.equal(crystal.stdout, javascript.stdout);
    assert.match(crystal.stdout, /Words from the other origin\./);
  } finally {
    await Promise.all([closeServer(parentServer), closeServer(childServer)]);
  }
});

test('the native dump waits for the requested document DOM', { skip: !enabled }, async () => {
  const root = tempDir('tawb-crystal-navigation-');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.write('<!doctype html><p>Beginning</p>');
    setTimeout(() => response.end('<p>Delayed ending</p>'), 300);
  });
  await listen(server, '127.0.0.1');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  try {
    const result = await runAsync(path.join(ROOT, 'dist', 'tawb-crystal'), [
      '--dump', `http://127.0.0.1:${server.address().port}/`,
    ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Beginning\nDelayed ending\n');
  } finally {
    await closeServer(server);
  }
});

test('a kept Chromium is rejoined across the Crystal and JavaScript runtimes', { skip: !enabled }, async () => {
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
  const record = JSON.parse(fs.readFileSync(path.join(profile, 'tawb-endpoint.json'), 'utf8'));
  const endpoint = `http://127.0.0.1:${record.port}`;
  let connection;
  try {
    const javascript = spawnSync(process.execPath, [
      'src/index.js', '--dump', '--profile', profile, page,
    ], { cwd: ROOT, env, encoding: 'utf8', timeout: 90000 });
    assert.equal(javascript.status, 0, javascript.stderr);
    assert.equal(javascript.stdout, first.stdout);

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

test('a kept Firefox is rejoined across the Crystal and JavaScript runtimes', { skip: !enabled }, async () => {
  const root = tempDir('tawb-crystal-firefox-keep-');
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
    '--dump', '--browser', 'firefox', '--profile', profile, ...extra, page,
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const runJavascript = (...extra) => spawnSync(process.execPath, [
    'src/index.js', '--dump', '--browser', 'firefox', '--profile', profile, ...extra, page,
  ], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });

  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(path.join(profile, 'tawb-endpoint.json'), 'utf8'));
  } catch { /* read again after the keep below */ }

  // A kept Firefox has no CDP to close it with. The broker in the record was
  // detached into its own process group when the reader spawned it, and every
  // browser process still names the profile on its command line, so between
  // the group signal and the profile search nothing survives.
  const stopKept = () => {
    if (!record) return;
    try { process.kill(-record.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (const pid of processesUsing(profile)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  };

  try {
    const first = run('--keep-browser');
    assert.equal(first.status, 0, first.stderr);
    record = JSON.parse(fs.readFileSync(path.join(profile, 'tawb-endpoint.json'), 'utf8'));

    const javascript = runJavascript();
    assert.equal(javascript.status, 0, javascript.stderr);
    assert.equal(javascript.stdout, first.stdout);

    const second = run(executable);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.stdout, 'Still here\n');
  } finally {
    stopKept();
  }

  const deadline = Date.now() + 20000;
  while (processesUsing(profile).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  assert.deepEqual(processesUsing(profile), []);
});
