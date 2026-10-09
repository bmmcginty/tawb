'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { firefoxLaunchImplementations } = require('./crystal_impl');
const firefox = require('../src/firefox');
const { tempDir, removeTempDir } = require('./tmpdir');

const crystal = firefoxLaunchImplementations(firefox).find((entry) => entry.name === 'Crystal');

test('Crystal: Firefox launcher starts a headed browser and records its privileged endpoints', {
  skip: !crystal,
}, async () => {
  const root = tempDir('tweb-ff-launch-');
  const bin = path.join(root, 'bin');
  const profile = path.join(root, 'profile');
  const log = path.join(root, 'firefox.json');
  fs.mkdirSync(bin);
  fs.mkdirSync(profile);
  const fixture = path.join(__dirname, 'fixtures', 'fake_firefox.js');
  const executable = path.join(bin, 'firefox');
  fs.writeFileSync(executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o755 });

  try {
    const result = await crystal.launchScenario({
      profile,
      path: bin,
      display: ':99',
      timeoutMs: 5000,
      log,
    });
    assert.equal(result.owned, true);
    assert.equal(result.endpoint, `ws://127.0.0.1:${result.port}/session`);
    assert.ok(result.marionettePort > 0);
    assert.equal(result.libraryPort, 4567);
    assert.equal(result.record.port, result.port);
    assert.equal(result.record.marionettePort, result.marionettePort);
    assert.equal(result.record.libraryPort, 4567);
    assert.ok(result.record.pid > 0);

    const launched = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.equal(launched.remotePort, result.port);
    assert.equal(launched.marionettePort, result.marionettePort);
    assert.equal(launched.profile, profile);
    assert.deepEqual(launched.args, [
      '--no-remote',
      '-profile', profile,
      `--remote-debugging-port=${result.port}`,
      '--marionette',
      '--remote-allow-system-access',
      'about:blank',
    ]);
    assert.match(fs.readFileSync(path.join(profile, 'user.js'), 'utf8'),
      new RegExp(`user_pref\\("marionette\\.port", ${result.marionettePort}\\);`));
    assert.equal(fs.existsSync(path.join(profile, 'tawb-endpoint.json')), false);
  } finally {
    removeTempDir(root);
  }
});

test('Crystal: Firefox launcher rejoins a live profile without taking ownership', {
  skip: !crystal,
}, async () => {
  const profile = tempDir('tweb-ff-rejoin-');
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const record = {
    port, marionettePort: 41001, libraryPort: 41002, pid: process.pid,
  };
  fs.writeFileSync(path.join(profile, 'tawb-endpoint.json'), JSON.stringify(record));
  try {
    const result = await crystal.launchScenario({
      profile,
      path: '/path/with/no/firefox',
      display: ':99',
      timeoutMs: 1000,
      log: path.join(profile, 'unused.json'),
    });
    assert.deepEqual(result, {
      endpoint: `ws://127.0.0.1:${port}/session`,
      port,
      marionettePort: 41001,
      libraryPort: 41002,
      owned: false,
      record,
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(
      path.join(profile, 'tawb-endpoint.json'), 'utf8')),
    record);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeTempDir(profile);
  }
});
