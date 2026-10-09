'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const enabled = process.env.TAWB_TEST_CRYSTAL === '1';
const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'dist', 'tawb-crystal');

function clientCall(url, text) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--conformance', 'transport.websocket_round_trip'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) return reject(new Error(stderr || stdout));
      resolve(JSON.parse(stdout).value);
    });
    child.stdin.end(JSON.stringify({ url, text }));
  });
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const masked = !!(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    at = 10;
  }
  const needed = at + (masked ? 4 : 0) + length;
  if (buffer.length < needed) return null;
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (mask) at += 4;
  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask) payload.forEach((byte, index) => { payload[index] = byte ^ mask[index % 4]; });
  return {
    opcode: buffer[0] & 0x0f,
    masked,
    payload,
    rest: buffer.subarray(needed),
  };
}

test('Crystal WebSocket text and control frames are masked', { skip: !enabled }, async () => {
  const frames = [];
  const server = net.createServer((socket) => {
    let handshaken = false;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const request = buffer.subarray(0, end + 4).toString('utf8');
        const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(request)[1].trim();
        const accept = crypto.createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        handshaken = true;
      }
      while (true) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        frames.push(frame);
        buffer = frame.rest;
        if (frame.opcode === 1) {
          const reply = Buffer.from(`echo:${frame.payload.toString('utf8')}`);
          socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await clientCall(`ws://127.0.0.1:${server.address().port}/socket`, 'hello');
    assert.equal(answer, 'echo:hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(frames[0].opcode, 1);
    assert.equal(frames[0].masked, true, 'client text frame was not masked');
    assert.equal(frames[0].payload.toString(), 'hello');
    assert.equal(frames[1].opcode, 8);
    assert.equal(frames[1].masked, true, 'client close frame was not masked');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
