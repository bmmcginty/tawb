'use strict';

// The password prompt a 401 raises, answered through a real browser, in both
// readers and on both engines.
//
// This is the one dialog that is nobody's document: browser chrome draws it,
// so a reader who cannot see it cannot answer it, and the only way to answer
// it at all is to take the prompt over through whatever interception the
// engine offers. Firefox has one for authentication alone; Chromium's goes
// through Fetch and pauses every request to get there. Two different
// instruments, one prompt on the status row, and that is what is compared.
//
// The server is a real one: it verifies a digest response properly, so an
// answer computed wrongly is refused here exactly as a real server refuses
// it. It runs as its own process, because a reader is driven by waiting and
// a server in this process would not answer while waiting.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const TERM = 'xterm-256color';
const COLS = 80;
const ROWS = 24;
const USER = 'reader';
const PASSWORD = 'opensesame';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmux(args) {
  return spawnSync('tmux', args, { encoding: 'utf8', timeout: 20000 });
}

function hasCommand(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).status === 0;
}

const reasons = [];
if (process.env.TAWB_TEST_CRYSTAL_BROWSER !== '1') reasons.push('TAWB_TEST_CRYSTAL_BROWSER is not 1');
if (!hasCommand('tmux')) reasons.push('tmux is not installed');
if (!fs.existsSync(BINARY)) reasons.push(`${BINARY} has not been built`);
if (!process.env.DISPLAY) reasons.push('there is no DISPLAY to start a browser on');
const skip = reasons.length ? reasons.join('; ') : false;

// The project's own challenge server, in a process of its own, which prints
// the address it chose.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'authserve.js'), '0'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let printed = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      printed += chunk;
      const found = printed.match(/http:\/\/\S+/);
      if (found) resolve({ child, url: found[0].trim() });
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('the challenge server never printed its address')), 15000);
  });
}

function killProfile(profile) {
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// One reader in one tmux pane, answering one challenge. Answers the rows the
// comparison is made on, and the status row the prompt is drawn on.
async function readingRun({ root, engine, runtime, address, answer }) {
  const name = `${runtime.name}-${engine}`;
  const profile = path.join(root, name, 'profile');
  const home = path.join(root, name, 'home');
  fs.mkdirSync(home, { recursive: true });
  const session = `tawb-auth-${name.toLowerCase()}-${process.pid}`;
  const environment = {
    HOME: home,
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    XDG_CONFIG_HOME: path.join(root, name, 'config'),
    XDG_DATA_HOME: path.join(root, name, 'data'),
    XDG_CACHE_HOME: path.join(root, name, 'cache'),
  };
  const quoted = [runtime.command, ...runtime.args, '--browser', engine,
    '--profile', profile, '--no-alt-screen', address]
    .map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
  const exported = Object.entries(environment)
    .map(([key, value]) => `${key}='${String(value).replace(/'/g, "'\\''")}'`).join(' ');

  tmux(['kill-session', '-t', session]);
  const started = tmux(['new-session', '-d', '-s', session,
    '-x', String(COLS), '-y', String(ROWS),
    `env ${exported} TERM=${TERM} ${quoted}`]);
  if (started.status !== 0) {
    throw new Error(`could not start tmux: ${started.stderr || started.error}`);
  }
  const rows = () => {
    const raw = tmux(['capture-pane', '-p', '-t', session]).stdout || '';
    const lines = raw.replace(/\n$/, '').split('\n');
    while (lines.length < ROWS) lines.push('');
    return lines.slice(0, ROWS).map((line) => line.padEnd(COLS, ' '));
  };
  const status = () => rows()[ROWS - 1].trim();
  const hint = () => rows()[2].trim();

  try {
    // The prompt is the reader's own, on the status row.
    let asking = '';
    for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
      await sleep(250);
      if (status().startsWith('user:')) { asking = hint(); break; }
    }
    if (!asking) throw new Error(`${session} never asked for a user; last screen:\n${rows().join('\n')}`);

    if (answer) {
      tmux(['send-keys', '-t', session, USER]);
      await sleep(400);
      tmux(['send-keys', '-t', session, 'Enter']);
      await sleep(600);
      const password = status();
      tmux(['send-keys', '-t', session, PASSWORD]);
      await sleep(400);
      tmux(['send-keys', '-t', session, 'Enter']);
      // The page the credentials unlock.
      for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
        await sleep(250);
        if (rows().some((row) => row.includes('Signed in as'))) break;
      }
      const body = rows().filter((row, index) => index !== ROWS - 1);
      tmux(['send-keys', '-t', session, 'q']);
      await sleep(1500);
      return { asking, password, body, profile };
    }

    // Escaping the prompt: cancelling is not failing, so the 401's own body
    // loads — which is a page, and a tab that has finished.
    tmux(['send-keys', '-t', session, 'Escape']);
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      await sleep(250);
      if (!status().startsWith('user:')) break;
    }
    await sleep(2000);
    const body = rows().filter((row, index) => index !== ROWS - 1);
    tmux(['send-keys', '-t', session, 'q']);
    await sleep(1500);
    return { asking, body, profile };
  } finally {
    tmux(['kill-session', '-t', session]);
  }
}

const RUNTIMES = [
  { name: 'JavaScript', command: process.execPath, args: [path.join(ROOT, 'src', 'index.js')] },
  { name: 'Crystal', command: BINARY, args: [] },
];

for (const engine of ['firefox', 'chromium']) {
  test(`both readers answer a real challenge through ${engine} the same way`,
    { skip }, async () => {
      const root = tempDir(`tawb-auth-${engine}-`);
      let server = null;
      const profiles = [];
      try {
        server = await startServer();
        const address = `${server.url.replace(/\/$/, '')}/basic`;
        const seen = [];
        for (const runtime of RUNTIMES) {
          const run = await readingRun({ root, engine, runtime, address, answer: true });
          profiles.push(run.profile);
          seen.push(run);
          killProfile(run.profile);
        }
        const [javascript, crystal] = seen;
        assert.equal(crystal.asking, javascript.asking,
          'the prompt says the same thing in both runtimes');
        assert.match(javascript.asking, /Sign in to http:\/\/127\.0\.0\.1:\d+ — "Staff area" \(basic\)/);
        assert.equal(crystal.password, javascript.password);
        assert.match(javascript.password, /^password:/);
        assert.deepEqual(crystal.body, javascript.body,
          'and the page the credentials unlock is the same page');
        assert.ok(javascript.body.some((row) => row.includes('Signed in as reader')),
          'which is the protected page, not the challenge');
      } finally {
        for (const profile of profiles) killProfile(profile);
        if (server) server.child.kill('SIGKILL');
        removeTempDir(root);
      }
    });
}

test('escaping the prompt loads the challenge\'s own body, in both runtimes',
  { skip }, async () => {
    const root = tempDir('tawb-auth-escape-');
    let server = null;
    const profiles = [];
    try {
      server = await startServer();
      const address = `${server.url.replace(/\/$/, '')}/basic`;
      const seen = [];
      for (const runtime of RUNTIMES) {
        const run = await readingRun({
          root, engine: 'chromium', runtime, address, answer: false,
        });
        profiles.push(run.profile);
        seen.push(run);
        killProfile(run.profile);
      }
      const [javascript, crystal] = seen;
      assert.deepEqual(crystal.body, javascript.body,
        'a declined challenge leaves both readers the same page');
      assert.ok(javascript.body.some((row) => row.trim().length > 0),
        'and it is a page rather than a tab still loading');
    } finally {
      for (const profile of profiles) killProfile(profile);
      if (server) server.child.kill('SIGKILL');
      removeTempDir(root);
    }
  });
