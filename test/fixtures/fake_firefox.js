#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');

const args = process.argv.slice(2);
const remoteArg = args.find((arg) => arg.startsWith('--remote-debugging-port='));
const profileAt = args.indexOf('-profile');
const profile = profileAt >= 0 ? args[profileAt + 1] : null;
const remotePort = Number((remoteArg || '').split('=')[1]);
const userJs = profile ? fs.readFileSync(`${profile}/user.js`, 'utf8') : '';
const marionettePort = Number(/user_pref\("marionette\.port",\s*(\d+)\)/.exec(userJs)?.[1]);

function packet(value) {
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from(`${payload.length}:`), payload]);
}

const remote = net.createServer((socket) => socket.end());
const marionette = net.createServer((socket) => {
  socket.write(packet({ applicationType: 'gecko', marionetteProtocol: 3 }));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const colon = buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon));
      const start = colon + 1;
      if (buffer.length < start + length) return;
      const [, id, name, params] = JSON.parse(buffer.subarray(start, start + length));
      buffer = buffer.subarray(start + length);
      let result = { value: {} };
      if (name === 'WebDriver:ExecuteScript' && params.script.includes('const before = state()')) {
        result = { value: { before: {}, after: {} } };
      } else if (name === 'WebDriver:ExecuteScript' && params.script.includes('server.asyncListen')) {
        result = { value: 4567 };
      }
      socket.write(packet([1, id, null, result]));
    }
  });
});

Promise.all([
  new Promise((resolve) => remote.listen(remotePort, '127.0.0.1', resolve)),
  new Promise((resolve) => marionette.listen(marionettePort, '127.0.0.1', resolve)),
]).then(() => {
  if (process.env.FAKE_FIREFOX_LOG) {
    fs.writeFileSync(process.env.FAKE_FIREFOX_LOG, JSON.stringify({
      args, remotePort, marionettePort, profile,
    }));
  }
});

function stop() {
  remote.close();
  marionette.close();
  setTimeout(() => process.exit(0), 10);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
setInterval(() => {}, 1000);
