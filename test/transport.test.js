'use strict';

// The WebSocket the protocol clients ride on, differenced between the
// platform's own client and the hand-written Crystal one.
//
// Everything above this layer is written as a sequence of request and reply
// frames, so a framing bug here looks like a protocol bug somewhere else. The
// Crystal client is the one that has to be verified, and the server in this
// file owns the framing: it can make one client read a length the other never
// produces, split a reply across frames, send a control frame mid-reply, or
// disappear. Both clients run the same server and have to report the same
// thing, byte for byte on the reply.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const net = require('node:net');

const { transportImplementations } = require('./crystal_impl');

const implementations = transportImplementations();

// One control frame per real connection, so the same run exercises both
// clients and the server script is the only difference between them.
const CASES = [
  { name: 'echoes a text frame', case: 'echo', ok: true, expected: 'echo:hello' },
  { name: 'reads a 16-bit length', case: 'length-126', ok: true, expected: 'a'.repeat(200) },
  { name: 'reads exactly 127 bytes, the length that is not an indicator', case: 'length-127-exact', ok: true, expected: 'c'.repeat(127) },
  { name: 'reads a 64-bit length', case: 'length-127', ok: true, expected: 'b'.repeat(70000) },
  { name: 'reassembles a fragmented reply', case: 'fragmented', ok: true, expected: 'one two three' },
  { name: 'answers a server ping and then reads the reply', case: 'ping', ok: true, expected: 'pong-ok' },
  { name: 'reports a server close instead of waiting', case: 'close-before-reply', ok: false },
  { name: 'reports an abrupt disconnection', case: 'abrupt', ok: false },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A client frame: the second byte's 7-bit field names the extended lengths at
// 126 and 127, and the mask is present.
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
  return { opcode: buffer[0] & 0x0f, final: !!(buffer[0] & 0x80), masked, payload, rest: buffer.subarray(needed) };
}

// A server frame: never masked, and free to use either extended form.
function serverFrame(opcode, payload, final = true) {
  const first = (final ? 0x80 : 0) | opcode;
  let header;
  if (payload.length < 126) {
    header = Buffer.from([first, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

// A WebSocket server that speaks one script, driven by the case name. It
// records every client frame it sees so the test can check what was on the
// wire, not only what the client reported.
function startServer(caseName) {
  const frames = [];
  const server = net.createServer((socket) => {
    let handshaken = false;
    let buffer = Buffer.alloc(0);
    const send = (opcode, payload, final = true) => { socket.write(serverFrame(opcode, payload, final)); };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const request = buffer.subarray(0, end + 4).toString('utf8');
        const key = /Sec-WebSocket-Key: ([^\r]+)/i.exec(request)[1].trim();
        const accept = crypto.createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
          + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        handshaken = true;
        if (caseName === 'ping') send(0x9, Buffer.from('hi'));
      }
      while (true) {
        const frame = parseFrame(buffer);
        if (!frame) break;
        buffer = frame.rest;
        frames.push(frame);
        if (frame.opcode === 0x8) {
          // Finish the close handshake so the client's own close completes and
          // the listening socket can be closed for real.
          try { send(0x8, Buffer.alloc(0)); } catch { /* already gone */ }
          socket.end();
          return;
        }
        if (frame.opcode === 0xa) {
          if (caseName === 'ping') send(0x1, Buffer.from('pong-ok'));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        switch (caseName) {
          case 'echo':
            send(0x1, Buffer.from(`echo:${frame.payload.toString('utf8')}`));
            break;
          case 'length-126':
            send(0x1, Buffer.from('a'.repeat(200)));
            break;
          case 'length-127-exact':
            send(0x1, Buffer.from('c'.repeat(127)));
            break;
          case 'length-127':
            send(0x1, Buffer.from('b'.repeat(70000)));
            break;
          case 'fragmented':
            send(0x1, Buffer.from('one '), false);
            send(0x0, Buffer.from('two '), false);
            send(0x0, Buffer.from('three'), true);
            break;
          case 'close-before-reply':
            send(0x8, Buffer.from([0x03, 0xe8]));
            break;
          case 'abrupt':
            socket.destroy();
            break;
          default:
            break;
        }
      }
    });
    socket.on('error', () => { /* the abrupt case destroys its own side */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, frames });
    });
  });
}

for (const entry of CASES) {
  test(`both WebSocket clients ${entry.name}`, async () => {
    const seen = [];
    for (const implementation of implementations) {
      const { server, port, frames } = await startServer(entry.case);
      try {
        const outcome = await implementation.roundTrip({
          url: `ws://127.0.0.1:${port}/socket`, text: 'hello',
        });
        // The client sends its close frame after it answers; give it a moment
        // to reach the server before the frames are read.
        await sleep(150);
        seen.push({ name: implementation.name, outcome, frames });
      } finally {
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections?.();
        await closed;
      }
    }

    for (const one of seen) {
      assert.equal(one.outcome.ok, entry.ok,
        `${one.name} answered ${JSON.stringify(one.outcome)} for ${entry.case}`);
      if (entry.ok) assert.equal(one.outcome.value, entry.expected,
        `${one.name} read the wrong bytes for ${entry.case}`);
    }
    // The two clients spell a failure differently, so the agreement that
    // matters is whether there was one and what the bytes were when there was
    // not.
    if (seen.length > 1) {
      assert.equal(seen[1].outcome.ok, seen[0].outcome.ok,
        `${seen[1].name} and ${seen[0].name} disagreed on whether ${entry.case} succeeded`);
    }

    // A client frame must be masked, and the client's own close frame must be
    // masked too; a server that read the length field wrong never gets here.
    for (const one of seen) {
      const text = one.frames.find((frame) => frame.opcode === 0x1);
      assert.ok(text, `${one.name} sent no text frame for ${entry.case}`);
      assert.equal(text.masked, true, `${one.name}'s text frame was not masked`);
      assert.equal(text.payload.toString('utf8'), 'hello');
      if (entry.case !== 'abrupt' && entry.case !== 'close-before-reply') {
        const close = one.frames.find((frame) => frame.opcode === 0x8);
        assert.ok(close, `${one.name} sent no close frame for ${entry.case}`);
        assert.equal(close.masked, true, `${one.name}'s close frame was not masked`);
      }
    }
  });
}
