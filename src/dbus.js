'use strict';

// D-Bus, spoken directly, because the accessibility bus is the only place a
// browser's own windows can be read.
//
// A native dialog — Chrome's "Add extension?", a file picker, a print sheet —
// is not a document. It is not in CDP, it is not in BiDi, and nothing in
// either protocol will ever describe it, because those protocols describe
// pages. What does describe it is the accessibility interface the browser
// already implements for screen readers, and on Linux that interface is
// AT-SPI: plain D-Bus method calls on a socket. See atspi.js for what is
// asked; this file is only how to ask it.
//
// Hand-written for the same reason cdp.js and bidi.js are. A dependency is a
// thing that has to be there — on every machine that installs this, and in
// every language it is ever rewritten in — and what we need of D-Bus is
// small: connect, authenticate, call a method, read the reply. The wire
// format is fixed and twenty years old.
//
// The parts of the format that matter here, since nothing about it is
// guessable from the code alone:
//
//   * Everything is aligned to the size of its own type, measured from the
//     start of the message. A string starts on a multiple of 4, an int64 on a
//     multiple of 8, and a struct on a multiple of 8 whatever is inside it.
//     Getting this wrong does not produce an error, it produces garbage.
//   * A message is a fixed 12-byte prologue, an array of header fields, a pad
//     to 8, and the body. The body's own length is in the prologue, which is
//     what makes a stream of messages separable.
//   * A signature says what the body holds: 's' a string, 'u' an unsigned
//     32-bit int, 'v' a variant, 'a(so)' an array of (string, object path)
//     pairs. Values are marshalled with no type information of their own, so
//     the signature is the only thing that makes the bytes readable.

const net = require('node:net');
const os = require('node:os');

const LITTLE_ENDIAN = 0x6c; // 'l'
const PROTOCOL_VERSION = 1;

const MESSAGE_METHOD_CALL = 1;
const MESSAGE_METHOD_RETURN = 2;
const MESSAGE_ERROR = 3;
const MESSAGE_SIGNAL = 4;

// Header field codes, in the order the specification numbers them.
const FIELD_PATH = 1;
const FIELD_INTERFACE = 2;
const FIELD_MEMBER = 3;
const FIELD_ERROR_NAME = 4;
const FIELD_REPLY_SERIAL = 5;
const FIELD_DESTINATION = 6;
const FIELD_SENDER = 7;
const FIELD_SIGNATURE = 8;

const DEFAULT_TIMEOUT_MS = 10000;

class DbusError extends Error {
  constructor(message, dbusName = null) {
    super(message);
    this.dbusName = dbusName;
  }
}

// How wide a value of each type has to start. Containers take the alignment
// of their kind rather than of their contents: a struct of one byte still
// starts on a multiple of 8.
const ALIGNMENT = {
  y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, h: 4, s: 4, o: 4, g: 1, v: 1, a: 4,
};

function alignmentOf(type) {
  const first = type[0];
  if (first === '(' || first === '{') return 8;
  const align = ALIGNMENT[first];
  if (!align) throw new DbusError(`unknown D-Bus type "${first}"`);
  return align;
}

// How many characters of a signature one complete type takes. 'a(so)' is one
// type five characters long; 'ss' is two types one character each.
function typeLength(signature, at = 0) {
  const first = signature[at];
  if (first === undefined) throw new DbusError('signature ended mid-type');
  if (first === 'a') return 1 + typeLength(signature, at + 1);
  if (first === '(' || first === '{') {
    const close = first === '(' ? ')' : '}';
    let depth = 1;
    let index = at + 1;
    while (index < signature.length && depth > 0) {
      const here = signature[index];
      if (here === '(' || here === '{') depth += 1;
      else if (here === ')' || here === '}') depth -= 1;
      index += 1;
    }
    if (depth !== 0) throw new DbusError(`unbalanced ${first} in signature "${signature}"`);
    if (signature[index - 1] !== close) throw new DbusError(`mismatched brackets in "${signature}"`);
    return index - at;
  }
  return 1;
}

// A signature as the list of types it holds, so a body of several values can
// be walked one value at a time.
function splitSignature(signature) {
  const types = [];
  let at = 0;
  while (at < signature.length) {
    const length = typeLength(signature, at);
    types.push(signature.slice(at, at + length));
    at += length;
  }
  return types;
}

// A buffer that grows, and that knows where it is — which is what alignment
// needs. Positions are absolute within the message, because that is what the
// format aligns against.
class Writer {
  constructor() {
    this.buffer = Buffer.alloc(512);
    this.pos = 0;
  }

  #room(bytes) {
    if (this.pos + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.pos + bytes) size *= 2;
    const bigger = Buffer.alloc(size);
    this.buffer.copy(bigger, 0, 0, this.pos);
    this.buffer = bigger;
  }

  align(width) {
    const pad = (width - (this.pos % width)) % width;
    if (!pad) return;
    this.#room(pad);
    this.buffer.fill(0, this.pos, this.pos + pad);
    this.pos += pad;
  }

  byte(value) {
    this.#room(1);
    this.buffer.writeUInt8(value & 0xff, this.pos);
    this.pos += 1;
  }

  uint32(value) {
    this.align(4);
    this.#room(4);
    this.buffer.writeUInt32LE(value >>> 0, this.pos);
    this.pos += 4;
  }

  raw(bytes) {
    this.#room(bytes.length);
    bytes.copy(this.buffer, this.pos);
    this.pos += bytes.length;
  }

  // A string is its length, its bytes, and a terminating nul that the length
  // does not count.
  string(value) {
    const bytes = Buffer.from(String(value), 'utf8');
    this.uint32(bytes.length);
    this.raw(bytes);
    this.byte(0);
  }

  // A signature is the same shape with a single byte of length, since no
  // signature may be longer than 255 characters.
  signature(value) {
    const bytes = Buffer.from(String(value), 'ascii');
    this.byte(bytes.length);
    this.raw(bytes);
    this.byte(0);
  }

  patchUint32(at, value) {
    this.buffer.writeUInt32LE(value >>> 0, at);
  }

  done() {
    return this.buffer.subarray(0, this.pos);
  }
}

function writeValue(writer, type, value) {
  const first = type[0];
  switch (first) {
    case 'y': writer.byte(Number(value)); return;
    case 'b': writer.uint32(value ? 1 : 0); return;
    case 'i': {
      writer.align(4);
      const bytes = Buffer.alloc(4);
      bytes.writeInt32LE(Number(value));
      writer.raw(bytes);
      return;
    }
    case 'u': writer.uint32(Number(value)); return;
    case 's': case 'o': writer.string(value); return;
    case 'g': writer.signature(value); return;
    case 'v': {
      // A variant carries its own signature, which is the whole point of it:
      // it is how a value of a type the caller does not know travels.
      const inner = value && value.signature ? value.signature : 's';
      const held = value && Object.hasOwn(value, 'value') ? value.value : value;
      writer.signature(inner);
      writeValue(writer, inner, held);
      return;
    }
    case 'a': {
      const element = type.slice(1);
      writer.align(4);
      const lengthAt = writer.pos;
      writer.uint32(0);
      // The length counts the elements only, and is measured from after the
      // padding that the first element's own alignment demands.
      writer.align(alignmentOf(element));
      const start = writer.pos;
      for (const item of value || []) writeValue(writer, element, item);
      writer.patchUint32(lengthAt, writer.pos - start);
      return;
    }
    case '(': case '{': {
      const inner = type.slice(1, -1);
      const types = splitSignature(inner);
      writer.align(8);
      types.forEach((each, index) => writeValue(writer, each, (value || [])[index]));
      return;
    }
    default:
      throw new DbusError(`cannot write D-Bus type "${type}"`);
  }
}

// Reading is the mirror of writing, and the same alignment rules apply. A
// reader is given the whole message so that its positions are the ones the
// message was marshalled against.
class Reader {
  constructor(buffer, pos = 0) {
    this.buffer = buffer;
    this.pos = pos;
  }

  align(width) {
    this.pos += (width - (this.pos % width)) % width;
  }

  byte() {
    const value = this.buffer.readUInt8(this.pos);
    this.pos += 1;
    return value;
  }

  uint32() {
    this.align(4);
    const value = this.buffer.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  string() {
    const length = this.uint32();
    const value = this.buffer.toString('utf8', this.pos, this.pos + length);
    this.pos += length + 1;
    return value;
  }

  signature() {
    const length = this.byte();
    const value = this.buffer.toString('ascii', this.pos, this.pos + length);
    this.pos += length + 1;
    return value;
  }

  value(type) {
    const first = type[0];
    switch (first) {
      case 'y': return this.byte();
      case 'b': return this.uint32() !== 0;
      case 'n': { this.align(2); const v = this.buffer.readInt16LE(this.pos); this.pos += 2; return v; }
      case 'q': { this.align(2); const v = this.buffer.readUInt16LE(this.pos); this.pos += 2; return v; }
      case 'i': { this.align(4); const v = this.buffer.readInt32LE(this.pos); this.pos += 4; return v; }
      case 'u': case 'h': return this.uint32();
      case 'x': { this.align(8); const v = this.buffer.readBigInt64LE(this.pos); this.pos += 8; return v; }
      case 't': { this.align(8); const v = this.buffer.readBigUInt64LE(this.pos); this.pos += 8; return v; }
      case 'd': { this.align(8); const v = this.buffer.readDoubleLE(this.pos); this.pos += 8; return v; }
      case 's': case 'o': return this.string();
      case 'g': return this.signature();
      case 'v': {
        const inner = this.signature();
        return this.value(inner);
      }
      case 'a': {
        const element = type.slice(1);
        const bytes = this.uint32();
        this.align(alignmentOf(element));
        const end = this.pos + bytes;
        const items = [];
        while (this.pos < end) items.push(this.value(element));
        this.pos = end;
        return items;
      }
      case '(': case '{': {
        const types = splitSignature(type.slice(1, -1));
        this.align(8);
        return types.map((each) => this.value(each));
      }
      default:
        throw new DbusError(`cannot read D-Bus type "${type}"`);
    }
  }
}

function encodeMessage(message) {
  const {
    type = MESSAGE_METHOD_CALL, flags = 0, serial = 1,
    path = null, iface = null, member = null, destination = null,
    errorName = null, replySerial = null, signature = '', body = [],
  } = message;

  const writer = new Writer();
  writer.byte(LITTLE_ENDIAN);
  writer.byte(type);
  writer.byte(flags);
  writer.byte(PROTOCOL_VERSION);
  const bodyLengthAt = writer.pos;
  writer.uint32(0);
  writer.uint32(serial);

  writer.align(4);
  const fieldsLengthAt = writer.pos;
  writer.uint32(0);
  writer.align(8);
  const fieldsStart = writer.pos;
  const field = (code, fieldType, value) => {
    if (value == null) return;
    writer.align(8);
    writer.byte(code);
    writer.signature(fieldType);
    writeValue(writer, fieldType, value);
  };
  field(FIELD_PATH, 'o', path);
  field(FIELD_INTERFACE, 's', iface);
  field(FIELD_MEMBER, 's', member);
  field(FIELD_ERROR_NAME, 's', errorName);
  field(FIELD_REPLY_SERIAL, 'u', replySerial);
  field(FIELD_DESTINATION, 's', destination);
  field(FIELD_SIGNATURE, 'g', signature || null);
  writer.patchUint32(fieldsLengthAt, writer.pos - fieldsStart);

  writer.align(8);
  const bodyStart = writer.pos;
  splitSignature(signature).forEach((each, index) => writeValue(writer, each, body[index]));
  writer.patchUint32(bodyLengthAt, writer.pos - bodyStart);
  return writer.done();
}

// How long the message beginning at the front of `buffer` is, or null if not
// all of it has arrived. A stream of messages is separable only through the
// two lengths in the prologue, so this is what makes reading one possible.
function messageLength(buffer) {
  if (buffer.length < 16) return null;
  const bodyLength = buffer.readUInt32LE(4);
  const fieldsLength = buffer.readUInt32LE(12);
  const headerEnd = 16 + fieldsLength;
  const bodyStart = headerEnd + ((8 - (headerEnd % 8)) % 8);
  const total = bodyStart + bodyLength;
  return buffer.length >= total ? total : null;
}

function decodeMessage(buffer) {
  const reader = new Reader(buffer, 1);
  const type = reader.byte();
  const flags = reader.byte();
  reader.byte(); // protocol version
  const bodyLength = reader.uint32();
  const serial = reader.uint32();

  const fields = reader.value('a(yv)');
  const message = {
    type, flags, serial, bodyLength, signature: '', body: [],
    path: null, iface: null, member: null, destination: null, sender: null,
    errorName: null, replySerial: null,
  };
  for (const [code, value] of fields) {
    if (code === FIELD_PATH) message.path = value;
    else if (code === FIELD_INTERFACE) message.iface = value;
    else if (code === FIELD_MEMBER) message.member = value;
    else if (code === FIELD_ERROR_NAME) message.errorName = value;
    else if (code === FIELD_REPLY_SERIAL) message.replySerial = value;
    else if (code === FIELD_DESTINATION) message.destination = value;
    else if (code === FIELD_SENDER) message.sender = value;
    else if (code === FIELD_SIGNATURE) message.signature = value;
  }

  reader.align(8);
  if (message.signature && bodyLength) {
    message.body = splitSignature(message.signature).map((each) => reader.value(each));
  }
  return message;
}

// An address is a transport and its parameters — "unix:path=/run/user/1000/
// at-spi/bus_99", sometimes with a guid after it, sometimes several addresses
// separated by semicolons. Only unix sockets are worth supporting: the
// accessibility bus is always one.
function parseAddress(address) {
  for (const candidate of String(address || '').split(';')) {
    const [transport, rest = ''] = candidate.split(':');
    if (transport !== 'unix') continue;
    const parameters = new Map(rest.split(',').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    }));
    // An abstract socket is a Linux one with no filesystem name; Node spells
    // it with a leading nul, exactly as the kernel does.
    if (parameters.has('path')) return parameters.get('path');
    if (parameters.has('abstract')) return `\0${parameters.get('abstract')}`;
  }
  throw new DbusError(`no unix socket in D-Bus address "${address}"`);
}

// The handshake, which is a line protocol that runs before the binary one.
//
// A nul byte first — it carries the credentials the kernel attaches to a unix
// socket — then EXTERNAL authentication, which is the client saying "I am
// this uid" and the bus checking that against what the kernel told it. No
// secret is exchanged because none is needed: being able to open the socket
// and being that uid is the whole of the claim.
function handshake(socket, { timeout }) {
  return new Promise((resolve, reject) => {
    let pending = '';
    const uid = Buffer.from(String(os.userInfo().uid), 'ascii').toString('hex');
    const timer = setTimeout(() => finish(new DbusError('the D-Bus handshake timed out')), timeout);

    const finish = (err) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onError = (err) => finish(new DbusError(`D-Bus handshake failed: ${err.message}`));
    const onData = (chunk) => {
      pending += chunk.toString('ascii');
      let at = pending.indexOf('\r\n');
      while (at >= 0) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 2);
        if (line.startsWith('OK')) {
          socket.write('BEGIN\r\n');
          finish(null);
          return;
        }
        if (line.startsWith('REJECTED') || line.startsWith('ERROR')) {
          finish(new DbusError(`the bus refused authentication: ${line}`));
          return;
        }
        at = pending.indexOf('\r\n');
      }
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
  });
}

// One connection to one bus. Commands carry a serial and the reply names it,
// which is the same shape as every other protocol here.
class DbusConnection {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.signalHandlers = [];
    this.nextSerial = 1;
    this.closed = false;
    this.name = null;
    this.buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#onClose(new DbusError('the D-Bus connection closed')));
    socket.on('error', (err) => this.#onClose(new DbusError(`D-Bus connection failed: ${err.message}`)));
  }

  #onClose(err) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    try { this.socket.destroy(); } catch { /* already gone */ }
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const length = messageLength(this.buffer);
      if (length == null) return;
      const raw = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      let message;
      try {
        message = decodeMessage(raw);
      } catch {
        // A message we cannot parse is one we cannot answer either; dropping
        // it is better than tearing down a connection over a type we have
        // never asked for.
        continue;
      }
      this.#deliver(message);
    }
  }

  #deliver(message) {
    if (message.type === MESSAGE_SIGNAL) {
      for (const handler of [...this.signalHandlers]) {
        try { handler(message); } catch { /* a listener's problem, not ours */ }
      }
      return;
    }
    const waiter = this.pending.get(message.replySerial);
    if (!waiter) return;
    this.pending.delete(message.replySerial);
    if (message.type === MESSAGE_ERROR) {
      const detail = typeof message.body[0] === 'string' ? `: ${message.body[0]}` : '';
      waiter.reject(new DbusError(`${message.errorName}${detail}`, message.errorName));
      return;
    }
    waiter.resolve(message.body);
  }

  onSignal(handler) {
    this.signalHandlers.push(handler);
    return this;
  }

  call({
    destination, path, iface, member, signature = '', body = [], timeout = DEFAULT_TIMEOUT_MS,
  }) {
    if (this.closed) return Promise.reject(new DbusError('the D-Bus connection closed'));
    const serial = this.nextSerial;
    this.nextSerial += 1;
    const raw = encodeMessage({
      type: MESSAGE_METHOD_CALL, serial, destination, path, iface, member, signature, body,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new DbusError(`${iface}.${member} did not answer within ${timeout / 1000}s`));
      }, timeout);
      this.pending.set(serial, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.socket.write(raw);
      } catch (err) {
        this.pending.delete(serial);
        clearTimeout(timer);
        reject(new DbusError(`${iface}.${member}: ${err.message}`));
      }
    });
  }

  // What a bus name's owner is, as a process. This is how an application on
  // the accessibility bus is identified as the browser we started rather than
  // some other window on the same desktop: the bus knows the pid behind every
  // connection and will say so.
  async processIdOf(name) {
    const [pid] = await this.call({
      destination: 'org.freedesktop.DBus',
      path: '/org/freedesktop/DBus',
      iface: 'org.freedesktop.DBus',
      member: 'GetConnectionUnixProcessID',
      signature: 's',
      body: [name],
    });
    return pid;
  }

  close() {
    this.#onClose(new DbusError('the D-Bus connection was closed here'));
  }
}

async function connect(address, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const path = parseAddress(address);
  const socket = await new Promise((resolve, reject) => {
    const attempt = net.createConnection({ path });
    const timer = setTimeout(() => {
      attempt.destroy();
      reject(new DbusError(`no D-Bus answered at ${path} within ${timeout / 1000}s`));
    }, timeout);
    attempt.once('connect', () => { clearTimeout(timer); resolve(attempt); });
    attempt.once('error', (err) => {
      clearTimeout(timer);
      reject(new DbusError(`cannot reach the D-Bus at ${path}: ${err.message}`));
    });
  });
  socket.setNoDelay(true);
  await handshake(socket, { timeout });

  const connection = new DbusConnection(socket);
  // Hello is not a greeting, it is a registration: until it is answered the
  // connection has no name of its own and the bus will not route to it.
  const [name] = await connection.call({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    iface: 'org.freedesktop.DBus',
    member: 'Hello',
    timeout,
  });
  connection.name = name;
  return connection;
}

module.exports = {
  connect, DbusConnection, DbusError,
  encodeMessage, decodeMessage, messageLength, parseAddress,
  splitSignature, typeLength,
  MESSAGE_METHOD_CALL, MESSAGE_METHOD_RETURN, MESSAGE_ERROR, MESSAGE_SIGNAL,
};
