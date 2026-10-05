'use strict';

// A real Lynx, driven the way a person drives it.
//
// Everything else in the Lynx tests looks at what Lynx *prints* — the effective
// keymap, the configuration dump, a rendered page. None of that answers the
// questions this file exists for: what Lynx puts on the screen when `o` is
// pressed, where it leaves the cursor, what a key does to the option under it,
// and what `>` writes to the user's options file. Those live in the interactive
// program, so the interactive program is what is asked.
//
// A tmux pane is the smallest thing that is a terminal: Lynx gets a tty, a
// fixed size, and a key stream, and tmux answers with the rendered screen and
// the cursor position. The pane is the only channel; nothing about Lynx's
// internals is read.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TERM = 'xterm-256color';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 10000, ...options });
}

function hasCommand(name) {
  const result = run('sh', ['-c', `command -v ${name}`]);
  return result.status === 0;
}

// Both halves are needed, and neither is an error when it is missing: this is
// the same posture as the unit tests' missing-lynx fallback.
function available() {
  return hasCommand('lynx') && hasCommand('tmux');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One Lynx in one tmux pane.
//
// The session name is supplied by the caller so that two test files cannot
// collide, and the home directory is supplied for the same reason every other
// Lynx test supplies one: a personal ~/.lynxrc must not be part of the answer,
// and ~/.lynxrc must be somewhere writable when `>` saves.
class LynxTty {
  constructor({
    session, home, page, config = null, cols = 80, rows = 24, extraArgs = [],
  }) {
    this.session = session;
    this.home = home;
    this.page = page;
    this.config = config;
    this.cols = cols;
    this.rows = rows;
    this.extraArgs = extraArgs;
    this.started = false;
  }

  #tmux(args) {
    return run('tmux', args);
  }

  async start({ ready = null, timeout = 8000 } = {}) {
    this.stop();
    const command = [
      `HOME=${this.home}`,
      `TERM=${TERM}`,
      'lynx',
      ...(this.config ? [`-cfg=${this.config}`] : []),
      ...this.extraArgs,
      this.page,
    ].join(' ');
    const started = run('tmux', [
      'new-session', '-d', '-s', this.session,
      '-x', String(this.cols), '-y', String(this.rows), command,
    ]);
    if (started.status !== 0) {
      throw new Error(`could not start tmux: ${started.stderr || started.error}`);
    }
    this.started = true;
    const wanted = ready || 'Commands: Use arrow keys';
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      await sleep(120);
      if (this.screen().includes(wanted)) return this;
    }
    throw new Error(`Lynx never drew its first screen; last was:\n${this.screen()}`);
  }

  stop() {
    if (!this.started) return;
    this.#tmux(['kill-session', '-t', this.session]);
    this.started = false;
  }

  // One key, by tmux's own name, awaited until the screen stops changing.
  //
  // Two waits, because Lynx draws in two steps when an option is changing: the
  // status line first, then the option it came from. Waiting for quiet rather
  // than for a fixed delay is what keeps a slow machine from reading a
  // half-drawn screen, and what keeps a fast one from taking a second per key.
  async press(key, { settle = 60, timeout = 2000 } = {}) {
    const before = this.screen();
    this.#tmux(['send-keys', '-t', this.session, key]);
    let previous = null;
    let current = before;
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      await sleep(settle);
      previous = current;
      current = this.screen();
      if (current === previous && current !== before) return current;
    }
    return current;
  }

  async pressAll(keys) {
    const seen = [];
    for (const key of keys) seen.push(await this.press(key));
    return seen;
  }

  raw() {
    const result = this.#tmux(['capture-pane', '-p', '-t', this.session]);
    return result.stdout || '';
  }

  // The visible pane, one string per row and padded to the pane's width, so a
  // column means the same thing in one capture and the next.
  screen() {
    const lines = this.raw().split('\n');
    const out = [];
    for (let row = 0; row < this.rows; row += 1) {
      const line = lines[row] == null ? '' : lines[row];
      out.push(line.length >= this.cols ? line.slice(0, this.cols) : line.padEnd(this.cols, ' '));
    }
    return out.join('\n');
  }

  line(row) {
    return this.screen().split('\n')[row];
  }

  // Where Lynx left the terminal cursor, zero-based in both directions.
  cursor() {
    const result = this.#tmux([
      'display-message', '-p', '-t', this.session, '#{cursor_x},#{cursor_y}',
    ]);
    const [x, y] = String(result.stdout || '').trim().split(',').map(Number);
    return { x, y };
  }

  // The last row, which is where Lynx writes every message it has for the
  // reader.
  statusLine() {
    return this.line(this.rows - 1).replace(/\s+$/, '');
  }

  rcPath() {
    return path.join(this.home, '.lynxrc');
  }

  // The options file Lynx writes with `>` — every setting it knows, in its own
  // format. Parsed into the same lower-case names the file uses, so a test asks
  // for `show_cursor` rather than for a line of text.
  rc() {
    let text;
    try {
      text = fs.readFileSync(this.rcPath(), 'utf8');
    } catch {
      return null;
    }
    const settings = {};
    for (const line of text.split('\n')) {
      const match = /^([a-z_0-9]+)=(.*)$/.exec(line);
      if (match) settings[match[1]] = match[2];
    }
    return settings;
  }

  removeRc() {
    fs.rmSync(this.rcPath(), { force: true });
  }
}

// Option labels, as Lynx draws them on the single-screen menu, taken from the
// option letter it prints in parentheses beside each one. A line may hold two
// options ("Raw 8-bit or CJK m(O)de : ON   show color (&) : ON"), so the line
// is cut at its colons and each piece is asked whether it names an option.
// "(E)ditor" yields `E` and "show cursor (@)" yields `@`.
function optionFields(screen) {
  const fields = [];
  for (const line of String(screen).split('\n')) {
    let at = 0;
    for (const segment of line.split(':')) {
      const match = /\(([!@&]|\^?[A-Za-z])\)/.exec(segment);
      if (match) {
        fields.push({
          letter: match[1],
          label: segment.trim(),
          column: at + segment.indexOf(match[0]),
        });
      }
      at += segment.length + 1;
    }
  }
  return fields;
}

module.exports = { LynxTty, available, optionFields, sleep };
