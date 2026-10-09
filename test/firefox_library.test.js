'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { askFirefoxLibrary } = require('../src/firefox_library');
const { firefoxAgentImplementations } = require('./crystal_impl');

async function agent(answer) {
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      const colon = input.indexOf(0x3a);
      if (colon < 0) return;
      const size = Number(input.subarray(0, colon).toString());
      if (input.length < colon + 1 + size) return;
      const request = JSON.parse(input.subarray(colon + 1, colon + 1 + size));
      const response = Buffer.from(JSON.stringify(answer(request)));
      socket.end(`${response.length}:${response}`);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

for (const implementation of firefoxAgentImplementations({ askFirefoxLibrary })) {
  const check = (name, fn) => test(`${implementation.name}: ${name}`, fn);

  check('a Firefox parent-agent request uses length-prefixed JSON', async () => {
    const { server, port } = await agent((request) => ({ result: [request] }));
    try {
      const result = await implementation.ask(port, { kind: 'history', max: 42 });
      assert.deepEqual(result, [{ kind: 'history', max: 42 }]);
    } finally {
      server.close();
    }
  });

  check('a Firefox parent-agent error is reported', async () => {
    const { server, port } = await agent(() => ({ error: 'unknown list' }));
    try {
      await assert.rejects(
        () => implementation.ask(port, { kind: 'passwords' }), /unknown list/);
    } finally {
      server.close();
    }
  });

  check('an invalid Firefox parent-agent endpoint is refused before connecting', async () => {
    await assert.rejects(
      () => implementation.ask(null, { kind: 'history' }), /no library agent endpoint/);
  });
}
