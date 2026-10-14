'use strict';

// The native reader, driven the way a person drives it, against a real
// Firefox.
//
// Every other Crystal differential stops at the edge of the terminal: a
// scripted core answers what a rescan found, and what the two runtimes are
// compared on is the state machine. None of that answers the question this
// file exists for — whether the ported reader, started for itself, launching
// its own browser, reading a real document, puts the same thing on a real
// terminal as the JavaScript reader does.
//
// A tmux pane is the smallest thing that is a terminal: each reader gets a
// tty, a fixed size, and a key stream, and tmux answers with the rendered
// screen and the cursor position. The pane is the only channel; nothing
// about either reader's internals is read.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'dist', 'tawb-crystal');
const TERM = 'xterm-256color';
const COLS = 80;
const ROWS = 24;
// The rows the two readers must agree on: the title, the address, the hint,
// and the reading area. The status row is left out of the comparison on
// purpose — it carries whatever the reader last said, and a snapshot that
// took longer on one run than the other says so there.
const STATUS_ROW = ROWS - 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20000, ...options });
}

function hasCommand(name) {
  return run('sh', ['-c', `command -v ${name}`]).status === 0;
}

const reasons = [];
if (process.env.TAWB_TEST_CRYSTAL_BROWSER !== '1') reasons.push('TAWB_TEST_CRYSTAL_BROWSER is not 1');
if (!hasCommand('tmux')) reasons.push('tmux is not installed');
if (!fs.existsSync(BINARY)) reasons.push(`${BINARY} has not been built`);
if (!process.env.DISPLAY) reasons.push('there is no DISPLAY to start a browser on');
const skip = reasons.length ? reasons.join('; ') : false;

const PAGE = `<!doctype html><html><head><title>Fixture page</title></head><body>
<h1>Fixture heading</h1>
<p>First paragraph of the fixture.</p>
<a href="https://example.test/docs">Docs link</a>
<button>Save it</button>
<input type="text" aria-label="Your name">
</body></html>`;

// One reader in one tmux pane. The session name is the caller's, so two
// readers cannot collide, and the environment is the caller's for the reason
// every other test supplies one: a personal keymap must not be part of the
// answer.
class ReaderTty {
  constructor({ session, command, args, env }) {
    this.session = session;
    this.command = command;
    this.args = args;
    this.env = env;
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
      '-x', String(COLS), '-y', String(ROWS),
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

  raw() {
    return run('tmux', ['capture-pane', '-p', '-t', this.session]).stdout || '';
  }

  // The visible pane, one string per row and padded to the pane's width, so
  // a column means the same thing in one capture and the next.
  rows() {
    const lines = this.raw().replace(/\n$/, '').split('\n');
    while (lines.length < ROWS) lines.push('');
    return lines.slice(0, ROWS).map((line) => line.padEnd(COLS, ' '));
  }

  // The rows the comparison is made on, which is everything the readers
  // promise to agree about.
  drawn() {
    return this.rows().filter((row, index) => index !== STATUS_ROW);
  }

  status() {
    return this.rows()[STATUS_ROW].trim();
  }

  cursor() {
    const answer = run('tmux', ['display-message', '-p', '-t', this.session,
      '#{cursor_x},#{cursor_y}']).stdout.trim();
    const [column, row] = answer.split(',').map((value) => Number(value));
    return { column, row };
  }

  // One key, awaited until the screen stops changing. Waiting for quiet
  // rather than for a fixed delay is what keeps a slow machine from reading
  // a half-drawn screen and a fast one from taking a second per key.
  async press(key, { settle = 150, timeout = 8000 } = {}) {
    run('tmux', ['send-keys', '-t', this.session, key]);
    let previous = null;
    let current = this.raw();
    for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
      await sleep(settle);
      previous = current;
      current = this.raw();
      if (current === previous) return current;
    }
    return current;
  }

  alive() {
    return run('tmux', ['has-session', '-t', this.session]).status === 0;
  }

  // The ordinary interface quits on the quit key; the Lynx one asks first.
  // Answering a question nobody asked would type a letter into the page, so
  // the answer is only sent while the reader is still there to read it.
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

// Everything the readers launch names the profile on its command line, so
// the profile search finds whatever is left running under it.
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

// One reader's answers for one engine: the first screen, the screen two
// lines further down, and where the terminal cursor was left.
async function readingRun(root, engine, runtime, address) {
  const name = `${runtime.name}-${engine}`;
  const profile = path.join(root, name, 'profile');
  const reader = new ReaderTty({
    session: `tawb-interactive-${name.toLowerCase()}-${process.pid}`,
    command: runtime.command,
    args: [...runtime.args, '--browser', engine, '--profile', profile,
      '--no-alt-screen', address],
    env: environment(root, name),
  });
  try {
    await reader.start({ ready: 'Fixture heading' });
    const first = reader.drawn();
    await reader.press('Down');
    await reader.press('Down');
    const moved = reader.drawn();
    const cursor = reader.cursor();
    await reader.quit();
    return { name: runtime.name, first, moved, cursor, profile };
  } finally {
    reader.stop();
  }
}

const RUNTIMES = [
  { name: 'JavaScript', command: process.execPath, args: ['src/index.js'] },
  { name: 'Crystal', command: BINARY, args: [] },
];

for (const engine of ['firefox', 'chromium']) {
  test(`both readers draw the same real page through ${engine} and move through it the same way`,
    { skip }, async () => {
      const root = tempDir(`tawb-interactive-${engine}-`);
      const page = path.join(root, 'page.html');
      fs.writeFileSync(page, PAGE);
      const address = `file://${page}`;
      const seen = [];
      const profiles = [];
      try {
        for (const runtime of RUNTIMES) {
          const run = await readingRun(root, engine, runtime, address);
          profiles.push(run.profile);
          seen.push(run);
          await waitForProfileToDrain(run.profile);
        }

        const [javascript, crystal] = seen;
        assert.deepEqual(crystal.first, javascript.first,
          'the first screen of a real page is the same in both runtimes');
        assert.ok(javascript.first.some((row) => row.includes('# Fixture heading')),
          'and it is the page, not an error');
        assert.ok(javascript.first.some((row) => row.includes('{Docs link}')));
        assert.ok(javascript.first.some((row) => row.includes('[Your name]')));
        assert.deepEqual(crystal.moved, javascript.moved,
          'and so is the screen two lines further down');
        assert.deepEqual(crystal.cursor, javascript.cursor,
          'with the terminal cursor left on the same line, which is what a '
          + 'screen reader follows');
      } finally {
        for (const profile of profiles) killProfile(profile);
        removeTempDir(root);
      }
    });
}

// A site that moves between two views with the History API, the way a modern
// reader's pages do, and blanks its view before re-rendering on a back move.
// The blank is the point: it is what the reader sees if it reads the document
// the instant the history command is answered instead of when the site has
// finished putting the destination back.
const SPA = `<!doctype html><html><head><meta charset="utf-8"><title>Site</title></head>
<body><div id="app"></div>
<script>
  function render(path) {
    const app = document.getElementById('app');
    app.innerHTML = path === '/videos'
      ? '<h1>Videos page heading</h1><p>Listing.</p><a id="watch" href="/watch">Go to the video</a>'
      : '<h1>Watch page heading</h1><p>Playing.</p><a id="videos" href="/videos">All videos</a>';
    app.querySelector('a').addEventListener('click', (event) => {
      event.preventDefault();
      const href = event.currentTarget.getAttribute('href');
      history.pushState({}, '', href);
      render(href);
    });
  }
  render(location.pathname);
  addEventListener('popstate', () => {
    document.getElementById('app').innerHTML = '';
    setTimeout(() => render(location.pathname), 700);
  });
</script></body></html>`;

// A page that rewrites its own text after it has loaded: the paragraph a
// reader is looking at, and a live region beside it. Nothing the reader asks
// for changes; only the page does. What turns the change into a screen is the
// live ticker rebuilding through the real binding, which is the seam a
// scripted core stands in for and cannot verify.
const LIVE = `<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head>
<body><h1>Live heading</h1>
<p id="body">before the update</p>
<div role="status">One result</div>
<script>
  setTimeout(() => {
    document.getElementById('body').firstChild.data = 'after the update';
    document.querySelector('[role="status"]').firstChild.data = 'Two results';
  }, 2500);
</script></body></html>`;

// A screen has arrived when one of its rows says so. Waiting for quiet is the
// wrong wait here: the blank a site leaves mid-render is perfectly quiet.
async function waitForRow(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.rows().some((row) => row.includes(text))) return true;
    await sleep(200);
  }
  return reader.rows().some((row) => row.includes(text));
}

// The status row is not part of the compared screen, but a live region's
// announcement lands there, so a live update is two claims: the text arrived,
// and the reader said so.
async function waitForStatus(reader, text, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (reader.status().includes(text)) return true;
    await sleep(200);
  }
  return reader.status().includes(text);
}

// A back move is not finished when the browser says history changed: a site
// that renders its own views puts the destination back asynchronously, and
// reading at the commit shows the site's own blank. What has to notice the
// view arrive is the live ticker, so a back move that leaves the ticker
// unable to rebuild keeps the reader on a blank page forever.
for (const engine of ['firefox', 'chromium']) {
  test(`both readers re-read what the site rendered after history back through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-history-${engine}-`);
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end(SPA);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = `http://127.0.0.1:${server.address().port}/videos`;
      const profiles = [];
      try {
        const answers = [];
        for (const runtime of RUNTIMES) {
          const name = `${runtime.name}-${engine}-history`;
          const profile = path.join(root, name, 'profile');
          const reader = new ReaderTty({
            session: `tawb-history-${name.toLowerCase()}-${process.pid}`,
            command: runtime.command,
            args: [...runtime.args, '--browser', engine, '--profile', profile,
              '--no-alt-screen', address],
            env: environment(root, name),
          });
          try {
            await reader.start({ ready: 'Videos page heading' });
            await reader.press('Down');
            await reader.press('Down');
            await reader.press('Enter');
            assert.ok(await waitForRow(reader, 'Watch page heading'),
              `${runtime.name} followed the site's own video link`);
            await reader.press('M--');
            answers.push({
              runtime: runtime.name,
              returned: await waitForRow(reader, 'Videos page heading'),
            });
            await reader.quit();
          } finally {
            reader.stop();
          }
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
        for (const answer of answers) {
          assert.ok(answer.returned,
            `${answer.runtime} stayed on the blank page the site left before re-rendering`);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await new Promise((resolve) => server.close(resolve));
        removeTempDir(root);
      }
    });
}

// A change that arrives while the reader is looking is not a navigation and
// not an answer to a key. It moves only if the live ticker notices it and
// rebuilds through the binding the reader really uses, so both the rewritten
// text and the live region's words have to reach the screen.
for (const engine of ['firefox', 'chromium']) {
  test(`both readers show a page's own update through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-live-${engine}-`);
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end(LIVE);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = `http://127.0.0.1:${server.address().port}/`;
      const profiles = [];
      try {
        const answers = [];
        for (const runtime of RUNTIMES) {
          const name = `${runtime.name}-${engine}-live`;
          const profile = path.join(root, name, 'profile');
          const reader = new ReaderTty({
            session: `tawb-live-${name.toLowerCase()}-${process.pid}`,
            command: runtime.command,
            args: [...runtime.args, '--browser', engine, '--profile', profile,
              '--no-alt-screen', address],
            env: environment(root, name),
          });
          try {
            await reader.start({ ready: 'Live heading' });
            assert.ok(await waitForRow(reader, 'before the update'),
              `${runtime.name} never drew the page before it changed`);
            answers.push({
              runtime: runtime.name,
              text: await waitForRow(reader, 'after the update'),
              announced: await waitForStatus(reader, 'Two results'),
            });
            await reader.quit();
          } finally {
            reader.stop();
          }
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
        for (const answer of answers) {
          assert.ok(answer.text,
            `${answer.runtime} did not show the text the page rewrote`);
          assert.ok(answer.announced,
            `${answer.runtime} did not announce the live region's new words`);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await new Promise((resolve) => server.close(resolve));
        removeTempDir(root);
      }
    });
}

test('the native reader closes the browser it launched, and keeps one it was told to keep',
  { skip }, async () => {
    const root = tempDir('tawb-interactive-keep-');
    const page = path.join(root, 'page.html');
    fs.writeFileSync(page, PAGE);
    const address = `file://${page}`;
    const env = environment(root, 'keep');
    const profile = path.join(root, 'profile');
    const reader = (extra) => new ReaderTty({
      session: `tawb-interactive-keep-${process.pid}`,
      command: BINARY,
      args: ['--browser', 'firefox', '--profile', profile, '--no-alt-screen',
        ...extra, address],
      env,
    });

    try {
      const launched = reader([]);
      try {
        await launched.start({ ready: 'Fixture heading' });
        await launched.quit();
      } finally {
        launched.stop();
      }
      assert.equal(await waitForProfileToDrain(profile), true,
        'a browser the reader launched goes when the reader does');

      const kept = reader(['--keep-browser']);
      try {
        await kept.start({ ready: 'Fixture heading' });
        await kept.quit();
      } finally {
        kept.stop();
      }
      await sleep(1000);
      assert.ok(processesUsing(profile).length > 0,
        'a browser the reader was told to keep stays running');

      // The second reader finds the running browser through the endpoint
      // record in the profile rather than starting one of its own.
      const rejoined = reader(['--keep-browser']);
      try {
        await rejoined.start({ ready: 'Fixture heading' });
        assert.ok(rejoined.drawn().some((row) => row.includes('# Fixture heading')),
          'and the next reader reads the page through it');
        await rejoined.quit();
      } finally {
        rejoined.stop();
      }
    } finally {
      killProfile(profile);
      await waitForProfileToDrain(profile, 10000);
      removeTempDir(root);
    }
  });
