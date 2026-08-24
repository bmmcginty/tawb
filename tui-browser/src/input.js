'use strict';

// A terminal is a byte stream, not a keyboard event stream. One `data` chunk
// may hold several keys, and one escape sequence may be split across chunks.
// This reader turns that stream back into complete keystrokes. Escape alone
// needs a short wait because it is also the prefix of every special key.
class KeyReader {
  constructor(stream, { escapeMs = 35 } = {}) {
    this.stream = stream;
    this.escapeMs = escapeMs;
    this.buffer = '';
    this.keys = [];
    this.waiters = [];
    this.escapeTimer = null;
    this.onData = (chunk) => this.push(chunk);
    stream.setEncoding('utf8');
    stream.on('data', this.onData);
    stream.resume();
  }

  push(chunk) {
    this.buffer += chunk;
    this.parse(false);
  }

  emit(key) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(key);
    else this.keys.push(key);
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

  next() {
    if (this.keys.length) return Promise.resolve(this.keys.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close() {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.stream.off('data', this.onData);
    // The reader resumed stdin when it took ownership. Leaving it flowing
    // after the standalone keyboard wizard has removed its listener keeps
    // Node's event loop alive with nothing left that can consume input.
    this.stream.pause();
  }
}

module.exports = { KeyReader };
