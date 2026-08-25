'use strict';

// A terminal is a byte stream, not a keyboard event stream. One `data` chunk
// may hold several keys, and one escape sequence may be split across chunks.
// This reader turns that stream back into complete keystrokes. Escape alone
// needs a short wait because it is also the prefix of every special key.

// The keyboard is gone and is not coming back.
//
// Every way a terminal dies that arrives as a signal is handled where the
// program shuts down. This is the one that does not: stdin ending under a
// process that goes on running — a pty closed without a hangup, input from a
// pipe that reached its end, a stream destroyed under us. A waiter that can
// never be answered is worse than one answered with nothing, because a
// password prompt is holding a request the browser has paused, and neither
// the prompt nor the page can move again. So the end of the stream is
// delivered as a keystroke of its own, and whoever is waiting decides what it
// means: a prompt declines, and the reading loop leaves.
const EOF = Symbol('input.eof');

class KeyReader {
  constructor(stream, { escapeMs = 35 } = {}) {
    this.stream = stream;
    this.escapeMs = escapeMs;
    this.buffer = '';
    this.keys = [];
    this.waiters = [];
    // Who the keystrokes belong to. Normally nobody, and the reading loop
    // takes them. See claim().
    this.owner = null;
    this.ended = false;
    this.escapeTimer = null;
    this.onData = (chunk) => this.push(chunk);
    this.onEnd = () => this.end();
    stream.setEncoding('utf8');
    stream.on('data', this.onData);
    // A stream can finish quietly, or be destroyed, or fail. All three mean
    // the same thing to a reader waiting for a key.
    stream.on('end', this.onEnd);
    stream.on('close', this.onEnd);
    stream.on('error', this.onEnd);
    stream.resume();
  }

  push(chunk) {
    this.buffer += chunk;
    this.parse(false);
  }

  emit(key) {
    const at = this.waiters.findIndex((waiter) => waiter.owner === this.owner);
    if (at < 0) { this.keys.push(key); return; }
    const [waiter] = this.waiters.splice(at, 1);
    waiter.resolve(key);
  }

  // Take the keyboard, so a prompt that has to be answered while the reading
  // loop is blocked can be answered at all.
  //
  // The loop is one key at a time and everything it calls is awaited, so a
  // password prompt raised from inside a navigation is raised while the loop
  // is sitting in the middle of that navigation, unable to reach its next
  // keystroke — and the navigation cannot finish until the prompt is
  // answered. Whoever holds the claim is served instead, and the loop's own
  // waiting call stays parked until the claim is given back.
  //
  // Anything typed before the claim is dropped. Those keys were pressed at a
  // page, by a reader who had not yet been told a password was wanted, and
  // the least welcome place for them is a username field.
  claim() {
    this.keys.length = 0;
    this.owner = {};
    return this.owner;
  }

  release(token) {
    if (this.owner === token) this.owner = null;
  }

  // Everybody hears it: whoever holds the claim, and the reading loop parked
  // behind them. Both have to — the prompt so it can decline the challenge it
  // is holding open, the loop so it can shut the session down.
  end() {
    if (this.ended) return;
    this.ended = true;
    // A lone Escape is held back for the few milliseconds that tell it from
    // an Alt key. This is the last chance to decide it was one, and it is a
    // keystroke the reader typed: it goes out before the end does.
    if (this.buffer) this.parse(true);
    for (const waiter of this.waiters.splice(0)) waiter.resolve(EOF);
  }

  parse(expireEscape) {
    if (this.escapeTimer) { clearTimeout(this.escapeTimer); this.escapeTimer = null; }
    while (this.buffer) {
      if (this.buffer[0] !== '\x1b') {
        const key = [...this.buffer][0];
        this.buffer = this.buffer.slice(key.length);
        this.emit(key);
        continue;
      }

      if (this.buffer.length === 1) {
        if (expireEscape) {
          this.buffer = '';
          this.emit('\x1b');
        } else {
          this.escapeTimer = setTimeout(() => this.parse(true), this.escapeMs);
        }
        return;
      }

      const second = this.buffer[1];
      if (second === '[' || second === 'O') {
        // CSI and SS3 end with any byte from @ through ~. That includes the
        // ^ and $ endings older terminals use for modified navigation keys,
        // not just letters and `~`. ESC[[A is a historical function-key form
        // whose extra `[` is an introducer rather than its final byte.
        let end = -1;
        for (let i = 2; i < this.buffer.length; i += 1) {
          const code = this.buffer.charCodeAt(i);
          if (i === 2 && this.buffer[i] === '[') continue;
          if (code >= 0x40 && code <= 0x7e) { end = i; break; }
        }
        if (end < 0) return;
        const key = this.buffer.slice(0, end + 1);
        this.buffer = this.buffer.slice(end + 1);
        this.emit(key);
        continue;
      }

      // An escape followed by one character is the traditional Alt encoding.
      const character = [...this.buffer.slice(1)][0];
      if (!character) return;
      const length = 1 + character.length;
      this.emit(this.buffer.slice(0, length));
      this.buffer = this.buffer.slice(length);
    }
  }

  next(owner = null) {
    if (owner === this.owner && this.keys.length) return Promise.resolve(this.keys.shift());
    if (this.ended) return Promise.resolve(EOF);
    return new Promise((resolve) => this.waiters.push({ owner, resolve }));
  }

  close() {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    // Deliberate teardown ends the stream as far as this reader is concerned,
    // so a call for a key made after it answers rather than hanging.
    this.ended = true;
    this.stream.off('data', this.onData);
    this.stream.off('end', this.onEnd);
    this.stream.off('close', this.onEnd);
    this.stream.off('error', this.onEnd);
    // The reader resumed stdin when it took ownership. Leaving it flowing
    // after the standalone keyboard wizard has removed its listener keeps
    // Node's event loop alive with nothing left that can consume input.
    this.stream.pause();
  }
}

module.exports = { KeyReader, EOF };
