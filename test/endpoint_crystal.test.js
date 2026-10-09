'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const endpoint = require('../src/endpoint');
const { endpointImplementations } = require('./crystal_impl');
const { tempDir, removeTempDir } = require('./tmpdir');

for (const implementation of endpointImplementations(endpoint)) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('browser endpoint records round-trip without losing ownership fields', () => {
    const profile = tempDir('tweb-endpoint-');
    try {
      assert.equal(implementation.read(profile), null);
      const record = {
        port: 43210,
        marionettePort: 43211,
        libraryPort: 43212,
        pid: 1234,
        readerPid: null,
      };
      implementation.write(profile, record);
      assert.deepEqual(implementation.read(profile), record);
    } finally {
      removeTempDir(profile);
    }
  });

  check('a recorded endpoint is reusable only while its port answers', async () => {
    const profile = tempDir('tweb-endpoint-');
    const server = net.createServer(() => {});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      implementation.write(profile, { port });
      assert.equal(await implementation.running(profile), port);
      await new Promise((resolve) => server.close(resolve));
      assert.equal(await implementation.running(profile), null);
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      removeTempDir(profile);
    }
  });

  check('free ports and endpoint URL ports retain their deployment meaning', async () => {
    const port = await implementation.freePort();
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    assert.equal(implementation.portOf(`ws://127.0.0.1:${port}/session`), port);
    assert.equal(implementation.portOf(`http://127.0.0.1:${port}`), port);
    assert.equal(implementation.portOf('not an endpoint'), null);
  });
}
