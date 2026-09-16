'use strict';

// Killing a browser means killing a process group.
//
// The shape being tested is the one buildCommand creates on a machine with no
// display: we spawn xvfb-run, a shell, and the browser is that shell's child.
// A shell is stood in for here by `sh`, because the point has nothing to do
// with browsers — it is that a signal sent to a shell waiting on a foreground
// command does not reach the command.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');

const {
  processAlive, killProcessGroup, processesUsing, anyProcessUsing,
  requireBrowserUser, watchChildStartup, compactDiagnostic, browserStartupError,
  startupTimeoutMs, snapPackageName, snapCanReach, snapProfileDir, xvfbDisplayOption,
} = require('../src/proc');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { tempDir, removeTempDir } = require('./tmpdir');

// A shell holding a long-running child, in a process group of its own. Resolves
// once the grandchild has announced its pid, so both are known to be running.
function spawnShellHoldingAChild() {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', 'sleep 60 & echo "$!"; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    child.on('error', reject);
    child.stdout.once('data', (buf) => {
      const inner = Number(String(buf).trim());
      if (!inner) reject(new Error('the shell did not report its child'));
      else resolve({ child, inner });
    });
  });
}

// Signals are delivered asynchronously; the process is reaped a moment later.
async function goneWithin(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('signalling the process we spawned leaves its child running', async () => {
  const { child, inner } = await spawnShellHoldingAChild();
  try {
    child.kill('SIGTERM');
    assert.ok(await goneWithin(child.pid), 'the shell survived its own SIGTERM');
    // The bug, stated as a fact about the platform: this is why a browser was
    // left behind on every close.
    assert.ok(processAlive(inner), 'the child died with the shell after all');
  } finally {
    killProcessGroup(child.pid, 'SIGKILL');
    try { process.kill(inner, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('signalling the group takes the child down with it', async () => {
  const { child, inner } = await spawnShellHoldingAChild();
  try {
    assert.equal(killProcessGroup(child.pid), true, 'the group refused the signal');
    assert.ok(await goneWithin(child.pid), 'the shell outlived the group signal');
    assert.ok(await goneWithin(inner), 'the child outlived the group signal');
  } finally {
    killProcessGroup(child.pid, 'SIGKILL');
    try { process.kill(inner, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('a process group that has already gone is not an error', () => {
  const { child } = { child: spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore', detached: true }) };
  return new Promise((resolve) => {
    child.on('exit', () => {
      assert.equal(killProcessGroup(child.pid), false, 'a dead group answered the signal');
      assert.equal(killProcessGroup(0), false, 'a missing pid was signalled anyway');
      resolve();
    });
  });
});


// Whether a directory is still being used is the question that decides if it
// can be deleted, and a browser answers it by naming its profile in its own
// arguments — which is the only trace of the association that survives the
// process that set it up.

test('a path a running process names is seen as in use', async () => {
  const marker = `/tmp/tweb-inuse-check-${process.pid}-${Date.now()}`;
  assert.equal(anyProcessUsing(marker), false, 'a path nothing mentions looked busy');

  const holder = spawn('sh', ['-c', 'while :; do sleep 1; done', 'sh', `--user-data-dir=${marker}`],
    { stdio: 'ignore', detached: true });
  holder.unref();
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(processesUsing(marker), [holder.pid], 'the holder was not found');
    assert.equal(anyProcessUsing(marker), true);

    killProcessGroup(holder.pid, 'SIGKILL');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && processAlive(holder.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(anyProcessUsing(marker), false, 'a path stayed busy after its holder went');
  } finally {
    killProcessGroup(holder.pid, 'SIGKILL');
  }
});

test('asking about nothing is not asking about everything', () => {
  assert.deepEqual(processesUsing(''), [], 'an empty path matched processes');
  assert.equal(anyProcessUsing(null), false);
});

// Browser startup diagnostics have to survive the launcher. Without these,
// Chromium's root refusal was discarded and then misreported as a profile
// conflict, sending the user towards a directory that was not the problem.

test('launching a browser as root is refused without disabling its sandbox', () => {
  assert.throws(
    () => requireBrowserUser('chromium', () => 0),
    /will not launch chromium as root.*normal user account.*--no-sandbox/i,
  );
  assert.doesNotThrow(() => requireBrowserUser('chromium', () => 1000));
});

test('a browser exit reports its status and bounded stderr instead of guessing', async () => {
  const child = spawn('sh', ['-c', 'printf "first line\\nreal failure\\n" >&2; exit 23'], {
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  const startup = watchChildStartup(child);
  await new Promise((resolve) => child.once('close', resolve));

  const err = browserStartupError({
    name: 'test-browser', executable: '/bin/test-browser', profileDir: '/tmp/profile',
    port: 9123, timeoutMs: 25000, state: startup,
  });
  assert.match(err.message, /exited with status 23/);
  assert.match(err.message, /Executable: \/bin\/test-browser/);
  assert.match(err.message, /Profile: \/tmp\/profile/);
  assert.match(err.message, /Browser said: first line real failure/);
  assert.doesNotMatch(err.message, /another browser|profile (?:clash|conflict)/i);
});

test('a browser timeout identifies its port and keeps diagnostics readable', () => {
  const stderr = `ignored-${'x'.repeat(9000)}\n\x1b[31mremote agent unavailable\x1b[0m\n`;
  assert.equal(compactDiagnostic(stderr, 24), 'remote agent unavailable');

  const err = browserStartupError({
    name: 'firefox', executable: '/usr/bin/firefox', profileDir: '/tmp/firefox-profile',
    port: 9333, timeoutMs: 45000,
    state: { exited: false, code: null, signal: null, error: null, stderr: '' },
  });
  assert.match(err.message, /did not open debugging port 9333 within 45s/);
});


// xvfb-run runs its command as `"$@" 2>&1`. Everything the browser says
// therefore arrives on stdout, so a launcher watching stderr alone hears
// nothing at all — which is exactly what a machine with no display reported:
// a timeout, and no browser output to explain it.

test('what the browser says through xvfb-run is not lost with its stderr', async () => {
  // Two shapes: a browser complaining on stderr, and the same complaint after
  // xvfb-run's `2>&1` has folded it into stdout. Both have to reach the user.
  const onStderr = spawn('sh', ['-c', 'printf "cannot open display\\n" >&2; exit 1'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const merged = spawn('sh', ['-c', 'printf "cannot open display\\n" 2>&1; exit 1'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const states = [onStderr, merged].map((child) => watchChildStartup(child));
  await Promise.all([onStderr, merged].map(
    (child) => new Promise((resolve) => child.once('close', resolve)),
  ));
  for (const state of states) {
    const err = browserStartupError({
      name: 'firefox', executable: '/usr/bin/firefox', profileDir: '/tmp/p',
      port: 9000, timeoutMs: 45000, state,
    });
    assert.match(err.message, /Browser said: cannot open display/);
  }
});

test('a startup failure says what display the browser was given', () => {
  const err = browserStartupError({
    name: 'google-chrome-stable',
    executable: '/usr/bin/google-chrome-stable',
    profileDir: '/home/someone/.local/share/tawb/profile',
    port: 43291,
    timeoutMs: 25000,
    state: { exited: false, output: '' },
    context: ['Display: none, so the browser was run under /usr/bin/xvfb-run', null],
  });
  assert.match(err.message, /Display: none, so the browser was run under \/usr\/bin\/xvfb-run/);
  // A silent browser is a fact about the failure, not an absence to leave out.
  assert.match(err.message, /The browser said nothing/);
});

// Waiting longer is the only way to tell a slow first launch from one that was
// never going to finish, so the wait is something a user can raise.

test('the startup wait can be raised for a machine that needs it', () => {
  assert.equal(startupTimeoutMs(25000, {}), 25000);
  assert.equal(startupTimeoutMs(25000, { TAWB_BROWSER_TIMEOUT: '120' }), 120000);
  assert.equal(startupTimeoutMs(25000, { TAWB_BROWSER_TIMEOUT: 'soon' }), 25000);
  assert.equal(startupTimeoutMs(25000, { TAWB_BROWSER_TIMEOUT: '-5' }), 25000);
});

// A Snap-packaged browser reaches non-hidden files under $HOME and nothing
// else, so the usual profile in ~/.local/share is invisible to it. Ubuntu
// ships Firefox that way, and the failure is silent: the browser waits on a
// window nobody can see until the launcher times out.
//
// Ubuntu hides the snap two different ways, and neither is visible in the
// path. The firefox deb installs a shell script that ends in `exec
// /snap/bin/firefox "$@"`; elsewhere /usr/bin/firefox is a symlink into
// /snap/bin, and what is there is a symlink to the snap command itself.

const SNAP_LINKS = {
  '/usr/bin/firefox': '/snap/bin/firefox',
  '/snap/bin/firefox': '/usr/bin/snap',
  '/usr/bin/firefox-esr': '/usr/lib/firefox-esr/firefox-esr',
};

// Ubuntu's wrapper, shortened: it names the snap once while complaining that
// it is missing, and again when it launches it.
const UBUNTU_WRAPPER = [
  '#!/bin/sh',
  'if ! [ -x /snap/bin/chromium ]; then',
  '  echo "Command \'$0\' requires the chromium snap to be installed." >&2',
  '  exit 1',
  'fi',
  'exec /snap/bin/chromium "$@"',
].join('\n');

function fakeIo({ links = SNAP_LINKS, files = {}, installed = true } = {}) {
  return {
    readlink: (target) => {
      if (!(target in links)) throw new Error('not a symlink');
      return links[target];
    },
    readFile: (target) => {
      if (!(target in files)) throw new Error('no such file');
      return files[target];
    },
    exists: () => installed,
  };
}

test('a snap is recognised through the symlinks that hide it', () => {
  assert.equal(snapPackageName('/usr/bin/firefox', fakeIo()), 'firefox');
  assert.equal(snapPackageName('/snap/bin/chromium', fakeIo()), 'chromium');
  assert.equal(snapPackageName('/snap/firefox/current/usr/lib/firefox/firefox', fakeIo()), 'firefox');
});

test('a snap is recognised through the wrapper script that launches it', () => {
  const io = fakeIo({ files: { '/usr/bin/chromium-browser': UBUNTU_WRAPPER } });
  // The deb is chromium-browser and the snap is chromium: the profile has to
  // go where snapd put the snap, not where the command was named.
  assert.equal(snapPackageName('/usr/bin/chromium-browser', io), 'chromium');
});

test('nothing is taken for a snap without one installed to run', () => {
  const io = fakeIo({ files: { '/usr/bin/firefox-esr': '#!/bin/sh\nexec /usr/lib/firefox-esr/firefox-esr "$@"' } });
  assert.equal(snapPackageName('/usr/bin/firefox-esr', io), null, 'an ordinary wrapper looked confined');
  assert.equal(snapPackageName('/usr/bin/google-chrome-stable', io), null, 'a binary looked confined');
  assert.equal(snapPackageName(null, io), null);

  // The wrapper is there, the snap it names is not. That browser is not a snap
  // browser; it is one that will explain itself perfectly well on its own.
  const uninstalled = fakeIo({
    files: { '/usr/bin/chromium-browser': UBUNTU_WRAPPER }, installed: false,
  });
  assert.equal(snapPackageName('/usr/bin/chromium-browser', uninstalled), null);
});

test('a confined browser can only be given a profile it is allowed to open', () => {
  const home = '/home/someone';
  assert.equal(snapCanReach(`${home}/.local/share/tawb/firefox-profile`, home), false);
  assert.equal(snapCanReach('/tmp/tawb-profile', home), false, 'a snap has a private /tmp of its own');
  assert.equal(snapCanReach(`${home}/snap/firefox/common/tawb/firefox-profile`, home), true);
  assert.equal(
    snapProfileDir('firefox', 'firefox-profile', home),
    `${home}/snap/firefox/common/tawb/firefox-profile`,
  );
});

test('a snap firefox is refused an unreachable profile instead of timing out', () => {
  const { requireReachableProfile } = require('../src/firefox');
  const snapFirefox = { executable: '/snap/bin/firefox', name: 'firefox' };
  assert.throws(
    () => requireReachableProfile(snapFirefox, '/home/someone/.local/share/tawb/firefox-profile'),
    /runs the firefox snap.*cannot open.*non-hidden.*snap\/firefox\/common/s,
  );
  assert.doesNotThrow(
    () => requireReachableProfile(
      snapFirefox,
      path.join(os.homedir(), 'snap', 'firefox', 'common', 'tawb', 'firefox-profile'),
    ),
  );
  // An unconfined Firefox keeps the ordinary profile, wherever it is.
  assert.doesNotThrow(
    () => requireReachableProfile(
      { executable: '/usr/lib/firefox-esr/firefox-esr', name: 'firefox-esr' },
      '/home/someone/.local/share/tawb/firefox-profile',
    ),
  );
});

// ---------------------------------------------------------------------------
// Which display option a browser under Xvfb is launched with
//
// `-a` makes xvfb-run choose the display number by scanning for a lock file
// that is not there, which two launches at once both succeed at and then
// collide over. `-d` makes the X server choose and report its own, which two
// launches at once cannot collide over. So `-d` is used wherever xvfb-run
// offers it, and the option an installed xvfb-run offers is asked rather than
// assumed — which is what these stand-ins check.

// An xvfb-run that answers --help however the test wants it answered.
function fakeXvfbRun(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('an xvfb-run offering --auto-display is used with the option that cannot collide', () => {
  const dir = tempDir('tweb-xvfb-');
  const xvfb = fakeXvfbRun(dir, 'xvfb-run-new', 'echo "-a --auto-servernum"; echo "-d --auto-display"');
  assert.equal(xvfbDisplayOption(xvfb), '-d');
  removeTempDir(dir);
});

test('an older xvfb-run keeps the only option it has', () => {
  const dir = tempDir('tweb-xvfb-');
  const xvfb = fakeXvfbRun(dir, 'xvfb-run-old', 'echo "-a --auto-servernum"');
  assert.equal(xvfbDisplayOption(xvfb), '-a');
  removeTempDir(dir);
});

test('an xvfb-run that will not describe itself is not assumed to be the newer one', () => {
  const dir = tempDir('tweb-xvfb-');
  const xvfb = fakeXvfbRun(dir, 'xvfb-run-mute', 'exit 1');
  assert.equal(xvfbDisplayOption(xvfb), '-a');
  removeTempDir(dir);
});
