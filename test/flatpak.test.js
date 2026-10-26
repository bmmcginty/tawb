'use strict';

// A chosen path, as a Flatpak browser can open it.
//
// What is checked here is what the document portal is asked for, because that
// is what decides whether the browser finds the file: which path is exported,
// whether write is granted, and what is handed back. The export itself is
// `flatpak document-export`, so a stand-in named `flatpak` is put on the
// command line and its arguments are read back — the command is the interface,
// and the interface is what a test can hold still.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const flatpak = require('../src/flatpak');

// A `flatpak` that records what it was asked and answers the way the real one
// does: the exported path on stdout, under the document portal's mount.
function fakeFlatpak({ fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-flatpak-test-'));
  const record = path.join(dir, 'asked');
  const binary = path.join(dir, 'flatpak');
  fs.writeFileSync(binary, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(record)}`,
    fail ? 'echo "error: No such file or directory" >&2; exit 1' : '',
    // The real command prints the mount path of the export, whose last
    // component is the name of what was exported.
    fail ? '' : 'for each in "$@"; do last="$each"; done',
    fail ? '' : 'echo "/run/user/1000/doc/d00d/$(basename "$last")"',
    '',
  ].filter(Boolean).join('\n'), { mode: 0o755 });
  return {
    binary,
    asked() {
      try {
        return fs.readFileSync(record, 'utf8').trim().split('\n');
      } catch {
        return [];
      }
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a caller that is not in a sandbox is not one', () => {
  // The current process has no /.flatpak-info at its root, which is how every
  // ordinary caller looks.
  assert.equal(flatpak.sandboxOf(process.pid), null);
  assert.equal(flatpak.sandboxOf(null), null);
  assert.equal(flatpak.sandboxOf(0), null);
});

test('a file is exported as itself, and read-only', async () => {
  const fake = fakeFlatpak();
  try {
    const answered = await flatpak.exportedPathsFor(['/home/reader/report.pdf'], {
      appId: 'org.mozilla.firefox',
      request: { saving: false, directory: false },
      binary: fake.binary,
    });
    assert.deepEqual(answered, ['/run/user/1000/doc/d00d/report.pdf']);
    const asked = fake.asked();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /document-export/);
    assert.match(asked[0], /--transient/);
    assert.match(asked[0], /--app=org\.mozilla\.firefox/);
    assert.match(asked[0], /--allow-read/);
    // A file the browser only has to read is not given write.
    assert.doesNotMatch(asked[0], /--allow-write/);
    assert.match(asked[0], /\/home\/reader\/report\.pdf$/);
  } finally {
    fake.remove();
  }
});

test('a chosen folder is exported with write, because that is what it is for', async () => {
  const fake = fakeFlatpak();
  try {
    const answered = await flatpak.exportedPathsFor(['/home/reader/Downloads'], {
      appId: 'org.mozilla.firefox',
      request: { saving: false, directory: true },
      binary: fake.binary,
    });
    assert.deepEqual(answered, ['/run/user/1000/doc/d00d/Downloads']);
    assert.match(fake.asked()[0], /--allow-write/);
    // A download is written as `name.part` and renamed, and renaming the first
    // name away is a delete.
    assert.match(fake.asked()[0], /--allow-delete/);
  } finally {
    fake.remove();
  }
});

test('a save exports the folder and puts the name back on the end', async () => {
  // The name does not exist yet, and `flatpak document-export --noexist`
  // crashes in flatpak 1.14.6. Exporting the folder is also the only
  // arrangement a download can use: Firefox writes `name.part` into the
  // folder and renames it, which needs the folder and not the name.
  const fake = fakeFlatpak();
  try {
    const answered = await flatpak.exportedPathsFor(['/home/reader/Downloads/report.pdf'], {
      appId: 'org.mozilla.firefox',
      request: { saving: true, directory: false },
      binary: fake.binary,
    });
    assert.deepEqual(answered, ['/run/user/1000/doc/d00d/Downloads/report.pdf']);
    const asked = fake.asked();
    assert.equal(asked.length, 1);
    assert.match(asked[0], /--allow-write/);
    // The folder was exported, not the name.
    assert.match(asked[0], /\/home\/reader\/Downloads$/);
  } finally {
    fake.remove();
  }
});

test('an export that fails answers nothing rather than something unreachable', async () => {
  const fake = fakeFlatpak({ fail: true });
  try {
    const answered = await flatpak.exportedPathsFor(['/home/reader/report.pdf'], {
      appId: 'org.mozilla.firefox',
      request: { saving: false, directory: false },
      binary: fake.binary,
    });
    assert.equal(answered, null);
  } finally {
    fake.remove();
  }
});

test('one path exported and one not is not a half answer', async () => {
  // A list where some entries exist and some do not is worse than no answer:
  // the browser opens what it can and says nothing about the rest.
  const fake = fakeFlatpak();
  try {
    const answered = await flatpak.exportedPathsFor(['/a/one.txt', '/b/two.txt'], {
      appId: 'org.mozilla.firefox',
      request: { saving: false, directory: false },
      binary: fake.binary,
    });
    assert.deepEqual(answered, [
      '/run/user/1000/doc/d00d/one.txt',
      '/run/user/1000/doc/d00d/two.txt',
    ]);
  } finally {
    fake.remove();
  }
  const broken = fakeFlatpak({ fail: true });
  try {
    assert.equal(await flatpak.exportedPathsFor(['/a/one.txt', '/b/two.txt'], {
      appId: 'org.mozilla.firefox',
      request: { saving: false, directory: false },
      binary: broken.binary,
    }), null);
  } finally {
    broken.remove();
  }
});

test('nothing is exported without an application to export it to', async () => {
  const fake = fakeFlatpak();
  try {
    assert.equal(await flatpak.exportDocument('/home/reader/report.pdf', {
      appId: null, binary: fake.binary,
    }), null);
    assert.deepEqual(fake.asked(), []);
  } finally {
    fake.remove();
  }
});

test('the document portal is ready when its filesystem is mounted', () => {
  // A directory left behind by a killed portal is not a document portal. Only
  // the mount makes an exported path readable, so only the mount counts.
  assert.equal(flatpak.fuseMountedAt(os.tmpdir()), false);
  assert.equal(flatpak.fuseMountedAt('/definitely/not/mounted'), false);
});

test('a machine with no document portal says so rather than pretending', async () => {
  const started = await flatpak.startDocumentPortal({
    address: 'unix:path=/nowhere.sock',
    binary: null,
    runtimeDir: os.tmpdir(),
  });
  assert.equal(started, null);
});

test('a machine with no runtime directory has nowhere to mount one', async () => {
  const started = await flatpak.startDocumentPortal({
    address: 'unix:path=/nowhere.sock',
    binary: '/bin/true',
    runtimeDir: '',
  });
  assert.equal(started, null);
});

// ---------------------------------------------------------------------------
// Starting a browser flatpak installed.

const firefox = require('../src/firefox');
const chromium = require('../src/browser');

// A flatpak installation under a home directory of its own: an export
// directory with a launcher in it, and the application's own files where a
// version is read from.
function fakeInstall(appId, { milestone = '158.0.1', leaf = 'firefox' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-flatpak-home-'));
  const root = path.join(home, '.local', 'share', 'flatpak');
  fs.mkdirSync(path.join(root, 'exports', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'exports', 'bin', appId), '#!/bin/sh\n', { mode: 0o755 });
  const files = path.join(root, 'app', appId, 'current', 'active', 'files', 'lib', leaf);
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'platform.ini'), `[Build]\nMilestone=${milestone}\n`);
  return { home, appId, remove: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('an application flatpak installed is found by its id', () => {
  const install = fakeInstall('org.mozilla.firefox');
  try {
    const found = flatpak.installedApp('org.mozilla.firefox', install.home);
    assert.ok(found, 'the launcher in the export directory was not found');
    assert.equal(found.appId, 'org.mozilla.firefox');
    assert.equal(
      found.launcher,
      path.join(install.home, '.local/share/flatpak/exports/bin/org.mozilla.firefox'),
    );
    assert.equal(flatpak.installedApp('com.example.Nothing', install.home), null);
  } finally {
    install.remove();
  }
});

test('the version comes from the application files, not from the launcher', () => {
  // The launcher is a shell script in an export directory with no platform.ini
  // beside it, and asking it for `--version` would start a whole sandbox to
  // read one string.
  const install = fakeInstall('org.mozilla.firefox', { milestone: '158.0.1' });
  const home = os.homedir;
  try {
    os.homedir = () => install.home;
    assert.equal(flatpak.appFilesDirectory('org.mozilla.firefox'), path.join(
      install.home, '.local/share/flatpak/app/org.mozilla.firefox/current/active/files',
    ));
    assert.equal(
      firefox.installedFirefoxVersion('/unused', { appId: 'org.mozilla.firefox' }),
      '158.0.1',
    );
  } finally {
    os.homedir = home;
    install.remove();
  }
});

test('the only directory a sandbox shares with us is its own', () => {
  const home = '/home/reader';
  const own = flatpak.appDataDirectory('org.mozilla.firefox', home);
  assert.equal(own, '/home/reader/.var/app/org.mozilla.firefox');
  assert.equal(flatpak.appCanReach('org.mozilla.firefox', own, home), true);
  assert.equal(flatpak.appCanReach('org.mozilla.firefox', `${own}/tawb/profile`, home), true);
  assert.equal(flatpak.appCanReach('org.mozilla.firefox', '/home/reader/.local/share', home), false);
  assert.equal(flatpak.appCanReach('org.mozilla.firefox', '/tmp/profile', home), false);
  // A sibling whose name merely starts the same way is not inside it.
  assert.equal(
    flatpak.appCanReach('org.mozilla.firefox', '/home/reader/.var/app/org.mozilla.firefox-two', home),
    false,
  );
});

test('the two bus addresses are never passed into the sandbox', () => {
  // flatpak proxies the session bus and the accessibility bus and sets the
  // sandbox's own addresses to its proxies. An --env naming this program's
  // socket would replace a working proxy path with one the sandbox cannot
  // open — the single mistake that would make all of this fail quietly.
  const built = flatpak.runCommand({
    appId: 'org.mozilla.firefox',
    args: ['--no-remote', 'about:blank'],
    env: {
      GNOME_ACCESSIBILITY: '1',
      GTK_USE_PORTAL: '1',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/tawb-a11y-1.sock',
      AT_SPI_BUS_ADDRESS: 'unix:path=/tmp/tawb-a11y-1.sock',
    },
    filesystems: ['/home/reader/.var/app/org.mozilla.firefox'],
    binary: '/usr/bin/flatpak',
  });
  assert.equal(built.command, '/usr/bin/flatpak');
  assert.deepEqual(built.args, [
    'run',
    '--env=GNOME_ACCESSIBILITY=1',
    '--env=GTK_USE_PORTAL=1',
    '--filesystem=/home/reader/.var/app/org.mozilla.firefox',
    'org.mozilla.firefox',
    '--no-remote',
    'about:blank',
  ]);
});

test('a Flatpak browser keeps its profile where the sandbox can write', () => {
  const home = os.homedir;
  try {
    os.homedir = () => '/home/reader';
    assert.equal(
      firefox.defaultProfileDir({ executable: '/x', flatpak: { appId: 'org.mozilla.firefox' } }),
      '/home/reader/.var/app/org.mozilla.firefox/tawb/firefox-profile',
    );
    assert.equal(
      chromium.defaultProfileDir({ executable: '/x', flatpak: { appId: 'org.chromium.Chromium' } }),
      '/home/reader/.var/app/org.chromium.Chromium/tawb/profile',
    );
  } finally {
    os.homedir = home;
  }
});

test('a profile the sandbox cannot open is refused before the launch, not after', () => {
  // Pointed at a directory it may not write, a Flatpak browser behaves the way
  // a confined Snap does: it explains itself in a window on a virtual screen
  // and the launcher waits out the whole timeout for a port that never opens.
  const home = os.homedir;
  try {
    os.homedir = () => '/home/reader';
    const found = {
      executable: '/x', name: 'org.mozilla.firefox (flatpak)',
      flatpak: { appId: 'org.mozilla.firefox' },
    };
    assert.throws(
      () => firefox.requireReachableProfile(found, '/home/reader/.local/share/tawb/p'),
      /flatpak sandbox/,
    );
    // Its own data directory is allowed, and says nothing.
    firefox.requireReachableProfile(
      found, '/home/reader/.var/app/org.mozilla.firefox/tawb/firefox-profile',
    );
  } finally {
    os.homedir = home;
  }
});

test('the command for a Flatpak browser is flatpak run, under Xvfb or not', () => {
  const display = process.env.DISPLAY;
  const found = { executable: '/x', flatpak: { appId: 'org.mozilla.firefox' } };
  try {
    process.env.DISPLAY = ':0';
    const direct = firefox.buildCommand(found, ['about:blank'], {
      env: { GNOME_ACCESSIBILITY: '1' },
    });
    assert.match(direct.command, /flatpak$/);
    assert.deepEqual(direct.args, [
      'run', '--env=GNOME_ACCESSIBILITY=1', 'org.mozilla.firefox', 'about:blank',
    ]);

    // A browser installed the ordinary way is still run as itself.
    const native = firefox.buildCommand({ executable: '/usr/bin/firefox' }, ['about:blank']);
    assert.equal(native.command, '/usr/bin/firefox');
    assert.deepEqual(native.args, ['about:blank']);
  } finally {
    if (display === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = display;
  }
});

test('with no display, Xvfb wraps the flatpak command rather than replacing it', () => {
  const display = process.env.DISPLAY;
  try {
    delete process.env.DISPLAY;
    let built;
    try {
      built = firefox.buildCommand(
        { executable: '/x', flatpak: { appId: 'org.mozilla.firefox' } },
        ['about:blank'],
        { env: { GNOME_ACCESSIBILITY: '1' } },
      );
    } catch (err) {
      // No xvfb-run on this machine: the refusal is the documented behaviour
      // and there is nothing else to check here.
      assert.match(err.message, /xvfb-run was not found/);
      return;
    }
    assert.match(built.command, /xvfb-run$/);
    // flatpak run is what xvfb-run was given, with the application last before
    // its own arguments.
    const joined = built.args.join(' ');
    assert.match(joined, /flatpak run --env=GNOME_ACCESSIBILITY=1 org\.mozilla\.firefox about:blank$/);
  } finally {
    if (display === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = display;
  }
});
