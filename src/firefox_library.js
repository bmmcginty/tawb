'use strict';

const net = require('net');

const REQUEST_TIMEOUT_MS = 10000;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;

// Ask the privileged agent living in Firefox's parent process. Its socket
// speaks the same length-prefixed JSON framing Firefox uses for DevTools:
// webpages cannot open raw TCP connections, and an HTTP or WebSocket request
// does not begin with a decimal length and a colon, so neither can be mistaken
// for a command.
function askFirefoxLibrary(port, request, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new Error('this Firefox has no library agent endpoint'));
  }

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let expected = null;
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error('Firefox library agent did not answer in time')),
      timeout,
    );

    socket.on('connect', () => {
      const body = Buffer.from(JSON.stringify(request), 'utf8');
      socket.write(`${body.length}:`);
      socket.write(body);
    });
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (expected == null) {
        const colon = buffer.indexOf(0x3a);
        if (colon < 0) {
          if (buffer.length > 12) finish(new Error('Firefox library agent sent invalid framing'));
          return;
        }
        const head = buffer.subarray(0, colon).toString('ascii');
        if (!/^\d+$/.test(head)) {
          finish(new Error('Firefox library agent sent invalid framing'));
          return;
        }
        expected = Number(head);
        if (!Number.isSafeInteger(expected) || expected < 0 || expected > MAX_REPLY_BYTES) {
          finish(new Error('Firefox library agent sent an oversized reply'));
          return;
        }
        buffer = buffer.subarray(colon + 1);
      }
      if (buffer.length < expected) return;
      let reply;
      try {
        reply = JSON.parse(buffer.subarray(0, expected).toString('utf8'));
      } catch {
        finish(new Error('Firefox library agent sent unreadable JSON'));
        return;
      }
      if (reply && reply.error) finish(new Error(String(reply.error)));
      else finish(null, reply ? reply.result : undefined);
    });
    socket.on('error', (err) => finish(new Error(
      `could not reach Firefox library agent: ${String(err.message || err)}`)));
    socket.on('end', () => {
      if (!settled) finish(new Error('Firefox library agent closed without answering'));
    });
  });
}

module.exports = { askFirefoxLibrary, REQUEST_TIMEOUT_MS, MAX_REPLY_BYTES };
