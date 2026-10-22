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

// Escape-string introducers. OSC ends with BEL or ST; the others end with
// ST. They are kept whole because their payload is terminal data, not keys.
const STRING_INTRODUCERS = new Set([']', 'P', 'X', '^', '_']);

class KeyReader {
  constructor(stream, { escapeMs = 80 } = {}) {
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

      const parsed = this.escapeAt();
      if (parsed.length == null) {
        if (parsed.fallback) {
          if (expireEscape) {
            const count = Math.min(parsed.fallback, this.buffer.length);
            const key = this.buffer.slice(0, count);
            this.buffer = this.buffer.slice(count);
            this.emit(key);
            continue;
          }
          // A terminal writes Alt+letter as Escape followed by the letter.
          // Over SSH those two bytes can arrive in different packets tens of
          // milliseconds apart; expiring at 35ms intermittently turned the
          // webpage-mode exit key into Escape and a plain letter. Eighty
          // milliseconds remains a short lone-Escape delay while covering a
          // normal network scheduling gap. The same delay lets a prefix that
          // is also a key on its own — Escape, Alt+Escape, Alt+[, Alt+O, or
          // Alt+] — be delivered when nothing follows it.
          this.escapeTimer = setTimeout(() => this.parse(true), this.escapeMs);
        }
        return;
      }

      const key = this.buffer.slice(0, parsed.length);
      this.buffer = this.buffer.slice(parsed.length);
      this.emit(key);
    }
  }

  // How much of the buffer one escape sequence occupies, or null for “not
  // complete yet”. `fallback` is how many bytes can be taken as a key if no
  // more arrive; it is what keeps a prefix that is also a valid press —
  // Escape, Alt+Escape, Alt+[, Alt+O, Alt+] — usable on its own.
  escapeAt() {
    const buffer = this.buffer;
    if (buffer.length === 1) return { length: null, fallback: 1 };

    const second = buffer[1];
    // A terminal writes Alt+<key> as Escape followed by the key it would
    // otherwise send. For a function key that key is itself an escape
    // sequence, so Alt+F12 arrives as Escape, Escape, "[24~".
    if (second === '\x1b') {
      if (buffer.length === 2) return { length: null, fallback: 2 };
      const third = buffer[2];
      if (third === '[' || third === 'O') {
        const end = this.csiEnd(2);
        if (end < 0) return { length: null, fallback: 0 };
        return { length: end + 1, fallback: 0 };
      }
      if (STRING_INTRODUCERS.has(third)) {
        const end = this.stringEnd(2);
        if (end < 0) return { length: null, fallback: 2 };
        return { length: end, fallback: 0 };
      }
      return { length: 2, fallback: 0 };
    }

    if (second === '[' || second === 'O') {
      const end = this.csiEnd(1);
      if (end < 0) {
        return { length: null, fallback: buffer.length === 2 ? 2 : 0 };
      }
      // X10 mouse reports are a CSI sequence followed by three payload bytes.
      // Keeping the payload with the introducer stops coordinate bytes being
      // read as ordinary keys.
      if (second === '[' && buffer[2] === 'M' && end === 2) {
        const payloadEnd = end + 1 + 3;
        if (buffer.length < payloadEnd) return { length: null, fallback: 0 };
        return { length: payloadEnd, fallback: 0 };
      }
      return { length: end + 1, fallback: 0 };
    }

    if (STRING_INTRODUCERS.has(second)) {
      const end = this.stringEnd(1);
      if (end < 0) return { length: null, fallback: 2 };
      return { length: end, fallback: 0 };
    }

    // An escape followed by one character is the traditional Alt encoding.
    const character = [...buffer.slice(1)][0];
    if (!character) return { length: null, fallback: 1 };
    return { length: 1 + character.length, fallback: 0 };
  }

  // The final byte of a CSI or SS3 sequence whose introducer is at `start`.
  // Kept here rather than inline because an Alt prefix puts the same sequence
  // one byte further into the buffer.
  csiEnd(start) {
    for (let i = start + 1; i < this.buffer.length; i += 1) {
      const code = this.buffer.charCodeAt(i);
      // ESC[[A is a historical function-key form whose extra "[" is an
      // introducer rather than its final byte.
      if (i === start + 1 && this.buffer[i] === '[') continue;
      if (code >= 0x40 && code <= 0x7e) return i;
    }
    return -1;
  }

  // One past the end of an OSC/DCS/SOS/PM/APC string, or -1 when it has not
  // finished arriving. BEL ends an OSC string; ST — Escape followed by a
  // backslash — ends any of them.
  stringEnd(start) {
    for (let i = start + 1; i < this.buffer.length; i += 1) {
      if (this.buffer[i] === '\x07') return i + 1;
      if (this.buffer[i] === '\x1b') {
        if (i + 1 >= this.buffer.length) return -1;
        if (this.buffer[i + 1] === '\\') return i + 2;
      }
    }
    return -1;
  }

  next(owner = null) {
    if (owner === this.owner && this.keys.length) return Promise.resolve(this.keys.shift());
    if (this.ended) return Promise.resolve(EOF);
    return new Promise((resolve) => this.waiters.push({ owner, resolve }));
  }

  // Wait for either a key or an operation to finish. Unlike a bare
  // Promise.race with next(), this removes the key waiter when the operation
  // wins, so the next key cannot disappear into an abandoned promise.
  nextOr(operation, owner = null) {
    const completed = Promise.resolve(operation).then((value) => ({ value }));
    let waiter = null;
    let key;
    if (owner === this.owner && this.keys.length) {
      key = Promise.resolve({ key: this.keys.shift() });
    } else if (this.ended) {
      key = Promise.resolve({ key: EOF });
    } else {
      key = new Promise((resolve) => {
        waiter = { owner, resolve: (pressed) => resolve({ key: pressed }) };
        this.waiters.push(waiter);
      });
    }
    return Promise.race([completed, key]).finally(() => {
      if (!waiter) return;
      const at = this.waiters.indexOf(waiter);
      if (at >= 0) this.waiters.splice(at, 1);
    });
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
