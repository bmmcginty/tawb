'use strict';

// The native update path against a local release server. A real GitHub release
// would make these tests depend on the network and on whichever version is
// current, so the server here supplies the same JSON shape and asset redirect
// GitHub does. The binary under test is a copy, which lets it replace itself.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('./tmpdir');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const skip = enabled ? false : 'the Crystal runtime is not enabled';
const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'bin', 'tawb');
const machine = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim();
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const currentVersion = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  .stdout.trim().split(/\s+/)[0] || require('../package.json').version;
const nextVersion = currentVersion.replace(/\.(\d+)$/, (_, patch) => `.${Number(patch) + 1}`);
const currentTag = `v${currentVersion}`;
const nextTag = `v${nextVersion}`;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function releaseFor(tag, payload, { digest = null } = {}) {
  let origin = '';
  const server = http.createServer((request, response) => {
    if (request.url === '/latest') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tag_name: tag,
        html_url: `https://example.test/releases/tag/${tag}`,
        assets: [{
          name: `tawb-${tag}-linux-${machine}`,
          browser_download_url: `${origin}/asset`,
          digest: `sha256:${digest || sha256(payload)}`,
        }],
      }));
      return;
    }
    if (request.url === '/asset') {
      response.writeHead(302, { Location: '/real-asset' });
      response.end();
      return;
    }
    if (request.url === '/real-asset') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': payload.length,
      });
      response.end(payload);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, api: `${origin}/latest` });
    });
  });
}

function copyBinary(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(binary, destination);
  fs.chmodSync(destination, 0o755);
}

function run(found, executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--update'], {
      env: { ...process.env, TAWB_UPDATE_API: found.api },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('update check timed out'));
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function tempFiles(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

test('the update check works out whether a newer release exists', { skip }, async (t) => {
  const root = tempDir('tawb-update-current-');
  t.after(() => removeTempDir(root));
  const found = await releaseFor(currentTag, Buffer.from('same release\n'));
  t.after(() => new Promise((resolve) => found.server.close(resolve)));

  const executable = path.join(root, 'tawb');
  copyBinary(executable);
  const result = await run(found, executable);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^Latest release: ${currentTag}$`, 'm'));
  assert.match(result.stdout, new RegExp(`Running binary: ${executable} \\(writable\\)`));
  assert.match(result.stdout, /No update available/);
});

test('an update follows the asset redirect and replaces the symlink destination',
  { skip }, async (t) => {
    const root = tempDir('tawb-update-install-');
    t.after(() => removeTempDir(root));
    const replacement = Buffer.from('replacement binary\n');
    const found = await releaseFor(nextTag, replacement);
    t.after(() => new Promise((resolve) => found.server.close(resolve)));

    const destination = path.join(root, 'real', 'tawb');
    const link = path.join(root, 'bin', 'tawb');
    copyBinary(destination);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync('../real/tawb', link);

    const result = await run(found, link);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Update available: ${nextVersion}`));
    assert.ok(result.stdout.includes(`Updated ${destination} to ${nextVersion}`), result.stdout);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink is left alone');
    assert.deepEqual(fs.readFileSync(destination), replacement);
    assert.equal(fs.statSync(destination).mode & 0o777, 0o755, 'mode is preserved');
    assert.deepEqual(tempFiles(path.dirname(destination)), []);
  });

test('a read-only binary still reports the update, then fails without changing it',
  { skip: skip || (asRoot ? 'root can write read-only paths' : false) }, async (t) => {
    const root = tempDir('tawb-update-readonly-');
    t.after(() => removeTempDir(root));
    const found = await releaseFor(nextTag, Buffer.from('not installed\n'));
    t.after(() => new Promise((resolve) => found.server.close(resolve)));

    const executable = path.join(root, 'tawb');
    copyBinary(executable);
    const before = fs.readFileSync(executable);
    fs.chmodSync(executable, 0o555);

    const result = await run(found, executable);

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, new RegExp(`Update available: ${nextVersion}`));
    assert.match(result.stdout, /\(not writable\)/);
    assert.match(result.stderr, /cannot update .*not writable/);
    assert.deepEqual(fs.readFileSync(executable), before);
    assert.deepEqual(tempFiles(root), []);
  });

test('a bad digest fails and leaves neither the old binary changed nor a temp file',
  { skip }, async (t) => {
    const root = tempDir('tawb-update-digest-');
    t.after(() => removeTempDir(root));
    const found = await releaseFor(nextTag, Buffer.from('wrong digest\n'), {
      digest: '0'.repeat(64),
    });
    t.after(() => new Promise((resolve) => found.server.close(resolve)));

    const executable = path.join(root, 'tawb');
    copyBinary(executable);
    const before = fs.readFileSync(executable);

    const result = await run(found, executable);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256/);
    assert.deepEqual(fs.readFileSync(executable), before);
    assert.deepEqual(tempFiles(root), []);
  });
