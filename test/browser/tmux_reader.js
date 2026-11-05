'use strict';

// A small black-box terminal harness for browser tests. It intentionally knows
// nothing about reader state: tmux supplies the tty, keys, rendered cells,
// cursor position and SIGWINCH, exactly as a terminal emulator would.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { processesUsing } = require('../../src/proc');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const TERM = 'xterm-256color';
const COLS = 80;
const ROWS = 24;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options });
}

function hasCommand(name) {
  return run('sh', ['-c', `command -v ${name}`]).status === 0;
}

function browserTestSkip() {
  const reasons = [];
  if (process.env.TAWB_TEST_CRYSTAL_BROWSER !== '1') {
    reasons.push('TAWB_TEST_CRYSTAL_BROWSER is not 1');
  }
  if (!hasCommand('tmux')) reasons.push('tmux is not installed');
  if (!fs.existsSync(BINARY)) reasons.push(`${BINARY} has not been built`);
  if (!process.env.DISPLAY) reasons.push('there is no DISPLAY to start a browser on');
  return reasons.length ? reasons.join('; ') : false;
}

class ReaderTty {
  constructor({ session, command, args, env, cols = COLS, rows = ROWS }) {
    this.session = session;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cols = cols;
    this.height = rows;
    this.started = false;
  }

  async start({ ready, timeout = 90000 } = {}) {
    this.stop();
    const quoted = [this.command, ...this.args]
      .map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
    const exported = Object.entries(this.env)
      .map(([name, value]) => `${name}='${String(value).replace(/'/g, "'\\''")}'`).join(' ');
    const started = run('tmux', [
      'new-session', '-d', '-s', this.session,
      '-x', String(this.cols), '-y', String(this.height),
      `env ${exported} TERM=${TERM} ${quoted}`,
    ], { cwd: ROOT });
    if (started.status !== 0) {
      throw new Error(`could not start tmux: ${started.stderr || started.error}`);
    }
    this.started = true;
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      await sleep(250);
      if (this.rows().some((row) => row.includes(ready))) return this;
    }
    throw new Error(`${this.session} never drew ${ready}; last screen was:\n${this.raw()}`);
  }

  stop() {
    if (!this.started) return;
    run('tmux', ['kill-session', '-t', this.session]);
    this.started = false;
  }

  alive() {
    return run('tmux', ['has-session', '-t', this.session]).status === 0;
  }

  raw() {
    return run('tmux', ['capture-pane', '-p', '-t', this.session]).stdout || '';
  }

  rows() {
    const lines = this.raw().replace(/\n$/, '').split('\n');
    while (lines.length < this.height) lines.push('');
    return lines.slice(0, this.height).map((line) => line.padEnd(this.cols, ' '));
  }

  drawn() {
    return this.rows().filter((row, index) => index !== this.height - 1);
  }

  status() {
    return this.rows()[this.height - 1].trim();
  }

  cursor() {
    const answer = run('tmux', [
      'display-message', '-p', '-t', this.session, '#{cursor_x},#{cursor_y}',
    ]).stdout.trim();
    const [column, row] = answer.split(',').map(Number);
    return { column, row };
  }

  async quiet({ settle = 150, timeout = 8000 } = {}) {
    let current = this.raw();
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      await sleep(settle);
      const next = this.raw();
      if (next === current) return next;
      current = next;
    }
    return current;
  }

  async press(key, options = {}) {
    run('tmux', ['send-keys', '-t', this.session, key]);
    return this.quiet(options);
  }

  send(key) {
    run('tmux', ['send-keys', '-t', this.session, key]);
  }

  async type(text, { settle = 300 } = {}) {
    run('tmux', ['send-keys', '-t', this.session, '-l', text]);
    await sleep(settle);
    return this.raw();
  }

  // Filters consume one key at a time. Sending a whole literal string lets a
  // tty coalesce its tail into one read, which correctly behaves as a paste
  // but is not what a person typing characters is doing.
  async typeKeys(text, options = {}) {
    for (const character of text) await this.press(character, options);
    return this.raw();
  }

  async resize(cols, rows, options = {}) {
    const resized = run('tmux', [
      'resize-window', '-t', this.session, '-x', String(cols), '-y', String(rows),
    ]);
    if (resized.status !== 0) {
      throw new Error(`could not resize tmux: ${resized.stderr || resized.error}`);
    }
    this.cols = cols;
    this.height = rows;
    return this.quiet(options);
  }

  async quit() {
    await this.press('q');
    if (this.alive()) await this.press('y');
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      if (!this.alive()) return;
      await sleep(200);
    }
  }
}

function environment(root, name) {
  const home = path.join(root, name, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    XDG_CONFIG_HOME: path.join(root, name, 'config'),
    XDG_DATA_HOME: path.join(root, name, 'data'),
    XDG_CACHE_HOME: path.join(root, name, 'cache'),
  };
}

async function waitForProfileToDrain(profile, timeout = 30000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (processesUsing(profile).length === 0) return true;
    await sleep(250);
  }
  return processesUsing(profile).length === 0;
}

function killProfile(profile) {
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

async function waitForRow(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.rows().some((row) => row.includes(text))) return true;
    await sleep(200);
  }
  return reader.rows().some((row) => row.includes(text));
}

async function waitForStatus(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.status().includes(text)) return true;
    await sleep(200);
  }
  return reader.status().includes(text);
}

async function waitForDrawn(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.drawn().some((row) => row.includes(text))) return true;
    await sleep(200);
  }
  return reader.drawn().some((row) => row.includes(text));
}

const RUNTIMES = [
  { name: 'JavaScript', command: process.execPath, args: ['src/index.js'] },
  { name: 'Crystal', command: BINARY, args: [] },
];

module.exports = {
  ROOT, BINARY, COLS, ROWS, RUNTIMES, ReaderTty,
  sleep, browserTestSkip, environment, waitForProfileToDrain, killProfile,
  waitForRow, waitForStatus, waitForDrawn,
};
