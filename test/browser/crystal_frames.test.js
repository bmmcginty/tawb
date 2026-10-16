'use strict';

// The documents of one tab, against a real Chromium, differenced between the
// JavaScript driver and the Crystal port.
//
// An out-of-process iframe is the case nothing can be stubbed for: the tab's
// own session does not answer for that document at all, so a client that
// does not find the target it was given keeps a document it can never run
// anything in — and every snapshot then pays that document's whole frame
// budget before giving up. What this asks is whether both runtimes find the
// same documents and can evaluate in each one.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const { callAsync } = require('../crystal_impl');
const { openDriver } = require('../../src/driver');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

// Spawned rather than spawnSync: the fixture servers are in this process, and
// a blocking wait would stop them answering the very page being asked for.
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

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, resolve));
}

function closeServer(server) {
  return server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
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

// The same questions the Crystal conformance op asks, through the driver the
// JavaScript reader uses.
async function javascriptScenario(endpoint, url) {
  const driver = await openDriver({ engine: 'chromium', connect: endpoint });
  const page = await driver.context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // The extraction is what attaches an out-of-process document's own
    // target, which is how its frame comes to claim a session.
    await driver.axItems(page.mainFrame(), {});
    const frames = page.frames();
    const titles = [];
    for (const frame of frames) {
      titles.push(await frame.evaluate(() => document.title)
        .catch((error) => `error: ${error.message}`));
    }
    return {
      count: frames.length,
      urls: frames.map((frame) => frame.url()),
      titles,
      children: page.mainFrame().childFrames().length,
      selectors: (await page.mainFrame().$$('iframe')).length,
    };
  } finally {
    await driver.context.closePage(page).catch(() => {});
    await driver.close({ keepBrowser: true }).catch(() => {});
  }
}

test('both runtimes find the same documents in a tab, including a foreign one',
  { skip }, async () => {
    const root = tempDir('tawb-crystal-frames-');
    const profile = path.join(root, 'profile');
    let childServer = null;
    let parentServer = null;
    try {
      childServer = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Frames inner</title><p>Inner words</p>');
      });
      // An unspecified host accepts localhost on either loopback family. The
      // parent uses 127.0.0.1, making localhost a different site and so an
      // out-of-process iframe in Chromium rather than merely another origin.
      await listen(childServer);
      const childPort = childServer.address().port;

      // Two documents, and the path matters: a server that answered the
      // parent document for every path would nest the page inside itself as
      // deep as the browser allows.
      parentServer = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (request.url === '/inner.html') {
          response.end('<!doctype html><title>Frames inner</title><p>Inner words</p>');
          return;
        }
        response.end(`<!doctype html><title>Frames outer</title><h1>Outer heading</h1>
          <iframe title="Same site" src="/inner.html"></iframe>
          <iframe title="Other site" src="http://localhost:${childPort}/"></iframe>`);
      });
      await listen(parentServer, '127.0.0.1');
      const url = `http://127.0.0.1:${parentServer.address().port}/`;

      const env = {
        ...process.env,
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
      };
      fs.mkdirSync(env.HOME, { recursive: true });
      const launched = await run(BINARY, [
        '--dump', '--keep-browser', '--profile', profile, url,
      ], { cwd: ROOT, env });
      assert.equal(launched.status, 0, launched.stderr);
      const endpoint = `http://127.0.0.1:${portFrom(profile)}`;

      // The Crystal side is a child process reading a page this process
      // serves, so it is awaited rather than waited for.
      const crystal = await callAsync('cdp.frames_scenario', { endpoint, url },
        { timeoutMs: 60000 });
      const javascript = await javascriptScenario(endpoint, url);

      assert.deepEqual(crystal, javascript);
      assert.equal(crystal.count, 3, 'the tab, the same-site frame, the foreign one');
      assert.deepEqual(crystal.titles, ['Frames outer', 'Frames inner', 'Frames inner'],
        'each document answers for itself, the foreign one through its own target');
      assert.equal(crystal.children, 2);
      assert.equal(crystal.selectors, 2);
    } finally {
      killProfile(profile);
      await closeServer(parentServer);
      await closeServer(childServer);
      removeTempDir(root);
    }
  });
