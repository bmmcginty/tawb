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

const runtimeNamed = (name) => RUNTIMES.find((runtime) => runtime.name === name);

// The browser's own BiDi port, as recorded in the profile the reader was
// pointed at. It names the browser rather than the broker in front of it, so
// an unchanged port across two readers is what proves the second one joined
// the first one's browser instead of starting another.
function endpointPort(profile) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(profile, 'tawb-endpoint.json'), 'utf8'));
    return record.port || null;
  } catch {
    return null;
  }
}

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

// A page whose link leaves the drawn page. Movement and re-reading can be
// answered from lines the reader already holds, so following the link is what
// proves the browser behind the reader is the one still answering.
const FIRST = `<!doctype html><html><head><title>First</title></head><body>
<h1>First page</h1>
<a href="second.html">Go second</a>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second</title></head><body>
<h1>Second page</h1>
</body></html>`;

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

// A change that adds a block instead of replacing the text of one: a list gets
// a row. There is no line to splice, so the reader has to rebuild the page
// through the binding rather than patch the buffer it already holds.
const APPEND = `<!doctype html><html><head><meta charset="utf-8"><title>Grow</title></head>
<body><h1>List heading</h1>
<ul id="list"><li>First row</li></ul>
<script>
  setTimeout(() => {
    const row = document.createElement('li');
    row.textContent = 'Second row';
    document.getElementById('list').appendChild(row);
  }, 2500);
</script></body></html>`;

// A page that rewrites the paragraph the reader is standing on. The words have
// to change without the reader moving: a rebuild that re-anchors by line index
// or by screen position, rather than by the block under the cursor, lands the
// reader somewhere else in the page.
const UNDER = `<!doctype html><html><head><meta charset="utf-8"><title>Anchor</title></head>
<body><h1>Anchor heading</h1>
<p>keep one</p>
<p id="under">here before</p>
<p>keep three</p>
<script>
  setTimeout(() => {
    document.getElementById('under').firstChild.data = 'here after';
  }, 6000);
</script></body></html>`;

// A page that changes when the test tells it to, not when a wall clock does.
// The exact instant matters once the change has to land inside a keystroke's
// grace period, and a timer measured from page load cannot say where the
// reader was when it fired. The page asks its own origin whether the change is
// due, so the test arms it at a chosen point in the reader's session. The
// change is structural — a row is added — so it takes the whole-page rebuild
// path, and it announces itself through a live region so the test can see it
// arrived even when the buffer is held.
const HOLD = `<!doctype html><html><head><meta charset="utf-8"><title>Hold</title></head>
<body><h1>Hold heading</h1>
<p>Reading line</p>
<ul id="list"><li>First row</li></ul>
<div role="status">Nothing yet</div>
<script>
  const timer = setInterval(async () => {
    try {
      const answer = await fetch('/ready');
      if ((await answer.text()) !== 'go') return;
      clearInterval(timer);
      const row = document.createElement('li');
      row.textContent = 'Held row';
      document.getElementById('list').appendChild(row);
      document.querySelector('[role="status"]').firstChild.data = 'Held announcement';
    } catch (error) { /* the server went away; the page stays as it was */ }
  }, 120);
</script></body></html>`;

async function startHoldServer() {
  let armed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/ready') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(armed ? 'go' : 'wait');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(HOLD);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    address: `http://127.0.0.1:${server.address().port}/`,
    arm() { armed = true; },
    disarm() { armed = false; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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

// A structural change is not a text patch. The reader has no line for the row
// the page added, so it has to notice the page is different and rebuild, which
// is the whole-page path the text-replacement case never takes.
for (const engine of ['firefox', 'chromium']) {
  test(`both readers show a row the page appends through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-append-${engine}-`);
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end(APPEND);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = `http://127.0.0.1:${server.address().port}/`;
      const profiles = [];
      try {
        const answers = [];
        for (const runtime of RUNTIMES) {
          const name = `${runtime.name}-${engine}-append`;
          const profile = path.join(root, name, 'profile');
          const reader = new ReaderTty({
            session: `tawb-append-${name.toLowerCase()}-${process.pid}`,
            command: runtime.command,
            args: [...runtime.args, '--browser', engine, '--profile', profile,
              '--no-alt-screen', address],
            env: environment(root, name),
          });
          try {
            await reader.start({ ready: 'List heading' });
            assert.ok(await waitForRow(reader, 'First row'),
              `${runtime.name} never drew the list before it grew`);
            answers.push({
              runtime: runtime.name,
              added: await waitForRow(reader, 'Second row'),
            });
            await reader.quit();
          } finally {
            reader.stop();
          }
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
        for (const answer of answers) {
          assert.ok(answer.added,
            `${answer.runtime} never showed the row the page appended`);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await new Promise((resolve) => server.close(resolve));
        removeTempDir(root);
      }
    });
}

// A change on the line the reader is standing on must leave them there. The
// rebuild keeps the reader's place by anchoring to the block the cursor is in,
// so the rewritten words replace that line rather than pushing the reader off
// it.
for (const engine of ['firefox', 'chromium']) {
  test(`both readers stay on the line a live update rewrites through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-under-${engine}-`);
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end(UNDER);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = `http://127.0.0.1:${server.address().port}/`;
      const profiles = [];
      try {
        const answers = [];
        for (const runtime of RUNTIMES) {
          const name = `${runtime.name}-${engine}-under`;
          const profile = path.join(root, name, 'profile');
          const reader = new ReaderTty({
            session: `tawb-under-${name.toLowerCase()}-${process.pid}`,
            command: runtime.command,
            args: [...runtime.args, '--browser', engine, '--profile', profile,
              '--no-alt-screen', address],
            env: environment(root, name),
          });
          try {
            await reader.start({ ready: 'Anchor heading' });
            let onLine = false;
            for (let step = 0; step < 6 && !onLine; step += 1) {
              await reader.press('Down');
              onLine = reader.rows()[reader.cursor().row].includes('here before');
            }
            assert.ok(onLine, `${runtime.name} never reached the line under test`);
            const before = reader.cursor();
            const arrived = await waitForRow(reader, 'here after');
            const moved = reader.cursor();
            answers.push({
              runtime: runtime.name,
              arrived,
              before,
              moved,
              line: reader.rows()[moved.row],
            });
            await reader.quit();
          } finally {
            reader.stop();
          }
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
        for (const answer of answers) {
          assert.ok(answer.arrived,
            `${answer.runtime} never showed the rewritten words`);
          assert.deepEqual(answer.moved, answer.before,
            `${answer.runtime} moved when the line under the cursor changed`);
          assert.ok(answer.line.includes('here after'),
            `${answer.runtime} did not put the new words on the line the reader holds`);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await new Promise((resolve) => server.close(resolve));
        removeTempDir(root);
      }
    });
}

// Keys arriving while a page changes must not have the buffer swapped under
// the reader. The change is armed only after the pressing is under way, so it
// is guaranteed to land inside the input grace period; the live region proves
// it landed, and the buffer must still describe the page as it was.
for (const engine of ['firefox', 'chromium']) {
  test(`both readers hold the buffer while keys arrive during ${engine} updates`,
    { skip }, async () => {
      const root = tempDir(`tawb-freeze-${engine}-`);
      const hold = await startHoldServer();
      const profiles = [];
      try {
        const answers = [];
        for (const runtime of RUNTIMES) {
          hold.disarm();
          const name = `${runtime.name}-${engine}-freeze`;
          const profile = path.join(root, name, 'profile');
          const reader = new ReaderTty({
            session: `tawb-freeze-${name.toLowerCase()}-${process.pid}`,
            command: runtime.command,
            args: [...runtime.args, '--browser', engine, '--profile', profile,
              '--no-alt-screen', hold.address],
            env: environment(root, name),
          });
          try {
            await reader.start({ ready: 'Hold heading' });
            assert.ok(reader.rows().some((row) => row.includes('First row')),
              `${runtime.name} never drew the list before it changed`);
            // Up on the first line marks input without moving or writing the
            // status row, so the whole press window counts as reading and the
            // announcement is not overwritten by an end-of-page notice.
            let announced = false;
            let swapped = false;
            let armed = false;
            const until = Date.now() + 5000;
            while (Date.now() < until) {
              await reader.press('Up', { settle: 40, timeout: 2000 });
              if (!armed) { hold.arm(); armed = true; }
              if (reader.status().includes('Held announcement')) announced = true;
              if (reader.rows().some((row) => row.includes('Held row'))) swapped = true;
              await sleep(50);
            }
            answers.push({
              runtime: runtime.name,
              announced,
              swapped,
              arrived: await waitForRow(reader, 'Held row'),
            });
            await reader.quit();
          } finally {
            reader.stop();
          }
          profiles.push(profile);
          await waitForProfileToDrain(profile);
        }
        for (const answer of answers) {
          assert.ok(answer.announced,
            `${answer.runtime} never announced the live region while the reader was active`);
          assert.equal(answer.swapped, false,
            `${answer.runtime} rebuilt the buffer while keys were still arriving`);
          assert.ok(answer.arrived,
            `${answer.runtime} never showed the row once the reader stopped`);
        }
      } finally {
        for (const profile of profiles) killProfile(profile);
        await hold.close();
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

// The keep test above rejoins with the same runtime. What a person does is
// read with one build, quit, and read the same browser with the other, and it
// is the interactive reader's own startup that has to find the kept browser: a
// dump rejoining proves the endpoint record, not the reader.
for (const [first, second] of [['Crystal', 'JavaScript'], ['JavaScript', 'Crystal']]) {
  test(`a ${first} reader keeps a Firefox that the ${second} reader rejoins`,
    { skip }, async () => {
      const root = tempDir(`tawb-rejoin-${first}-`);
      const page = path.join(root, 'page.html');
      fs.writeFileSync(page, PAGE);
      const address = `file://${page}`;
      const profile = path.join(root, 'profile');
      const env = environment(root, 'rejoin');
      const opened = runtimeNamed(first);
      const joined = runtimeNamed(second);
      const launched = new ReaderTty({
        session: `tawb-rejoin-${first.toLowerCase()}-${process.pid}`,
        command: opened.command,
        args: [...opened.args, '--browser', 'firefox', '--profile', profile,
          '--no-alt-screen', '--keep-browser', address],
        env,
      });
      const rejoined = new ReaderTty({
        session: `tawb-rejoin-${second.toLowerCase()}-${process.pid}`,
        command: joined.command,
        args: [...joined.args, '--browser', 'firefox', '--profile', profile,
          '--no-alt-screen', address],
        env,
      });
      try {
        await launched.start({ ready: 'Fixture heading' });
        const port = endpointPort(profile);
        await launched.quit();
        assert.ok(port, 'the first reader recorded the browser it launched');
        assert.ok(processesUsing(profile).length > 0,
          'the kept Firefox outlives the reader that launched it');
        try {
          await rejoined.start({ ready: 'Fixture heading' });
          assert.ok(rejoined.drawn().some((row) => row.includes('# Fixture heading')),
            `the ${second} reader drew the page through the kept browser`);
          assert.equal(endpointPort(profile), port,
            'and it joined that browser rather than starting another');
          await rejoined.quit();
        } finally {
          rejoined.stop();
        }
      } finally {
        launched.stop();
        killProfile(profile);
        await waitForProfileToDrain(profile, 10000);
        removeTempDir(root);
      }
    });
}

// Two readers, one browser at the same time. Whichever one quits — the reader
// that launched the browser or the one that joined it — the other must keep
// reading: the browser and the BiDi session it rides on are the shared thing,
// and neither a departing owner nor a departing guest may end them while a
// third process is still using them. The broker is exercised on its own in
// broker_crystal, but not with two real readers and a real terminal.
for (const [first, second] of [['Crystal', 'JavaScript'], ['JavaScript', 'Crystal']]) {
  for (const leaver of ['launcher', 'joiner']) {
    const stayingName = leaver === 'launcher' ? second : first;
    test(`${first} and ${second} readers share one Firefox when the ${leaver} quits first`,
      { skip }, async () => {
        const label = `${first}-${leaver}`;
        const root = tempDir(`tawb-shared-${label}-`);
        fs.writeFileSync(path.join(root, 'first.html'), FIRST);
        fs.writeFileSync(path.join(root, 'second.html'), SECOND);
        const address = `file://${path.join(root, 'first.html')}`;
        const profile = path.join(root, 'profile');
        const env = environment(root, 'shared');
        const launcherRuntime = runtimeNamed(first);
        const joinerRuntime = runtimeNamed(second);
        const launcher = new ReaderTty({
          session: `tawb-shared-${label}-launcher-${process.pid}`.toLowerCase(),
          command: launcherRuntime.command,
          args: [...launcherRuntime.args, '--browser', 'firefox', '--profile', profile,
            '--no-alt-screen', address],
          env,
        });
        const joiner = new ReaderTty({
          session: `tawb-shared-${label}-joiner-${process.pid}`.toLowerCase(),
          command: joinerRuntime.command,
          args: [...joinerRuntime.args, '--browser', 'firefox', '--profile', profile,
            '--no-alt-screen', address],
          env,
        });
        const staying = leaver === 'launcher' ? joiner : launcher;
        const leaving = leaver === 'launcher' ? launcher : joiner;
        try {
          await launcher.start({ ready: 'First page' });
          const port = endpointPort(profile);
          try {
            await joiner.start({ ready: 'First page' });
            assert.equal(endpointPort(profile), port,
              `the ${second} reader joined the browser already running`);
            await leaving.quit();
            assert.ok(staying.alive(),
              `the ${stayingName} reader is still running after the other quit`);
            assert.ok(processesUsing(profile).length > 0,
              'the shared Firefox is still running');
            await staying.press('Down');
            await staying.press('Enter');
            assert.ok(await waitForRow(staying, 'Second page'),
              `the ${stayingName} reader is still driving the shared browser`);
            await staying.quit();
          } finally {
            joiner.stop();
          }
        } finally {
          launcher.stop();
          killProfile(profile);
          await waitForProfileToDrain(profile, 10000);
          removeTempDir(root);
        }
      });
  }
}

// A browser that goes away underneath a reader — crashed, killed, or quit from
// its own menu — must reach the reader as an end, not as a wait for a browser
// that will never answer. Whichever runtime is reading, the session ends
// within a bounded time instead of sitting on the terminal.
for (const runtime of RUNTIMES) {
  test(`a ${runtime.name} reader ends when the browser it is reading is killed`,
    { skip }, async () => {
      const root = tempDir(`tawb-loss-${runtime.name}-`);
      const page = path.join(root, 'page.html');
      fs.writeFileSync(page, PAGE);
      const profile = path.join(root, 'profile');
      const reader = new ReaderTty({
        session: `tawb-loss-${runtime.name}-${process.pid}`.toLowerCase(),
        command: runtime.command,
        args: [...runtime.args, '--browser', 'firefox', '--profile', profile,
          '--no-alt-screen', `file://${page}`],
        env: environment(root, runtime.name),
      });
      try {
        await reader.start({ ready: 'Fixture heading' });
        assert.ok(processesUsing(profile).length > 0,
          'the reader has a browser to lose');
        killProfile(profile);
        let ended = false;
        for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
          await sleep(250);
          if (!reader.alive()) { ended = true; break; }
        }
        assert.ok(ended,
          `${runtime.name} sat on the terminal after its browser was killed`);
      } finally {
        reader.stop();
        killProfile(profile);
        await waitForProfileToDrain(profile, 10000);
        removeTempDir(root);
      }
    });
}

