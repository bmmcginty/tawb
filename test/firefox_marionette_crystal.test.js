'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const {
  clearAutomationFlag, releaseStrandedSession,
  CLEAR_SCRIPT, PIERCE_PARENT_SCRIPT, libraryParentScript,
} = require('../src/firefox');
const { marionetteImplementations } = require('./crystal_impl');
const { protocolTraceV1 } = require('./parity/protocol-trace-v1');

// parity-id: asset.firefox-clear
// parity-id: asset.firefox-pierce
// parity-id: asset.firefox-library

function packet(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`${payload.length}:`), payload]);
}

async function withMarionette(onCommand, run) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write(packet({ applicationType: 'gecko', marionetteProtocol: 3 }));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const colon = buffer.indexOf(0x3a);
        if (colon < 0) return;
        const length = Number(buffer.subarray(0, colon).toString());
        const start = colon + 1;
        if (buffer.length < start + length) return;
        const command = JSON.parse(buffer.subarray(start, start + length));
        buffer = buffer.subarray(start + length);
        const [, id] = command;
        try {
          socket.write(packet([1, id, null, onCommand(command)]));
        } catch (error) {
          socket.write(packet([1, id, { error: 'unknown error', message: error.message }, null]));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

for (const implementation of marionetteImplementations({
  clearAutomationFlag, releaseStrandedSession,
})) {
  test(`${implementation.name}: Marionette clears automation and installs persistent agents`, async () => {
    const commands = [];
    const result = await withMarionette((command) => {
      commands.push(command);
      const [, , name, params] = command;
      if (name !== 'WebDriver:ExecuteScript') return { value: {} };
      if (params.script.includes('const before = state()')) {
        return {
          value: {
            before: { 'RemoteAgent:Active': true },
            after: { 'RemoteAgent:Active': false },
          },
        };
      }
      if (params.script.includes('loadProcessScript')) return { value: true };
      if (params.script.includes('server.asyncListen')) return { value: 4567 };
      throw new Error('unexpected privileged script');
    }, (port) => implementation.clearAutomation(port));

    assert.deepEqual(commands.map(([, id, name]) => ({ id, name })), [
      { id: 1, name: 'WebDriver:NewSession' },
      { id: 2, name: 'Marionette:SetContext' },
      { id: 3, name: 'WebDriver:ExecuteScript' },
      { id: 4, name: 'WebDriver:ExecuteScript' },
      { id: 5, name: 'WebDriver:ExecuteScript' },
    ]);
    assert.deepEqual(commands[1][3], { value: 'chrome' });
    const traces = protocolTraceV1(commands.slice(2).map(([, , operation, params]) => ({
      operation,
      source: params.script,
      target: { context: 'chrome', process: 'parent' },
      arguments: params.args,
      result: null,
      error: null,
      handles: [],
    })));
    assert.deepEqual(traces.map(({ operation, source, target, arguments: args }) => ({
      operation, source, target, arguments: args,
    })), [CLEAR_SCRIPT, PIERCE_PARENT_SCRIPT, libraryParentScript()].map((source) => ({
      operation: 'WebDriver:ExecuteScript',
      source,
      target: { context: 'chrome', process: 'parent' },
      arguments: [],
    })));
    assert.deepEqual(result, {
      before: { 'RemoteAgent:Active': true },
      after: { 'RemoteAgent:Active': false },
      libraryPort: 4567,
    });
  });

  test(`${implementation.name}: Marionette releases a stranded session without sending commands`, async () => {
    const commands = [];
    const released = await withMarionette((command) => {
      commands.push(command);
      return {};
    }, (port) => implementation.releaseStranded(port));

    assert.equal(released, true);
    assert.deepEqual(commands, []);
  });
}
