'use strict';

// What flatpak is, to a program that answers a desktop portal.
//
// A Flatpak browser does not share this program's filesystem. `flatpak run`
// puts the browser in a mount namespace of its own, and a path chosen on the
// terminal — `/home/reader/Downloads/report.pdf` — is in general not a path
// that exists inside it. A chooser that hands such a path back has answered
// with something the browser cannot open, and the browser says nothing: it
// simply fails to find the file.
//
// The real portals solve this with the *document portal*, which is a FUSE
// filesystem that re-exports one chosen file, or one chosen directory, at a
// path the sandbox can see. `org.freedesktop.portal.Documents` is a separate
// service from the file chooser, and `xdg-document-portal` is a separate
// binary from `xdg-desktop-portal` — so this program can start the real
// document portal on the bus it made without starting a second file chooser
// to compete with its own.
//
// Three facts decide the shape of what follows, and all three were measured
// rather than read:
//
//   * `xdg-document-portal` runs against a private session bus and mounts its
//     FUSE filesystem at `$XDG_RUNTIME_DIR/doc`, with no systemd and no
//     desktop in sight;
//   * `flatpak run` binds that mount into the sandbox *at launch*, so the
//     document portal has to be running before the browser starts. A sandbox
//     started first has a dangling `/run/user/<uid>/doc` for its whole life,
//     and starting the portal afterwards does not reach it;
//   * `flatpak document-export --noexist` crashes in flatpak 1.14.6 — the
//     command parses the reply of `AddFull` from a call to `AddNamed`, whose
//     reply has a different signature. A file that does not exist yet
//     therefore cannot be exported on its own, which is why a save exports
//     the *parent directory*. That turns out to be required anyway: Firefox
//     downloads to `name.part` and renames, and a rename needs the directory.
//
// The export is done by `flatpak document-export` rather than by calling
// `org.freedesktop.portal.Documents` here, because every method that adds a
// document takes a file descriptor, and Node cannot send a file descriptor
// over a unix socket — there is no SCM_RIGHTS in `net`. The command does the
// descriptor passing, and what it prints on stdout is the exported path.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

// Where distributions put the document portal. Ubuntu and Debian use
// `/usr/libexec`, Arch and Fedora `/usr/lib`. It arrives with
// xdg-desktop-portal, which flatpak recommends, so a machine with flatpak on
// it almost always has this too — and when it does not, a chosen path is
// handed back unexported and the reader is told why.
const DOCUMENT_PORTAL_BINARIES = [
  '/usr/libexec/xdg-document-portal',
  '/usr/lib/xdg-document-portal',
  '/usr/lib/flatpak/xdg-document-portal',
  '/usr/libexec/flatpak/xdg-document-portal',
];

const DOCUMENTS_NAME = 'org.freedesktop.portal.Documents';
const DOCUMENTS_PATH = '/org/freedesktop/portal/documents';
const START_TIMEOUT_MS = 5000;

function which(command) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function flatpakBinary() {
  return which('flatpak');
}

function documentPortalBinary() {
  for (const candidate of DOCUMENT_PORTAL_BINARIES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

// Who a D-Bus caller is, when the caller is a Flatpak application.
//
// Read exactly the way xdg-desktop-portal reads it: the bus knows the pid
// behind every connection, a sandbox has `/.flatpak-info` at its root, and
// `/proc/<pid>/root` is that root seen from outside. The file names the
// application, which is what an export has to be granted to.
//
// The pid is not the browser's. A sandboxed application talks to the
// `xdg-dbus-proxy` flatpak started for it, so the connection the bus sees
// belongs to the proxy — but the proxy runs inside the same sandbox root, and
// `/proc/<proxy pid>/root/.flatpak-info` names the same application. Measured,
// because the alternative was trusting the application id a caller sends.
function sandboxOf(pid) {
  if (!pid) return null;
  let text;
  try {
    text = fs.readFileSync(`/proc/${pid}/root/.flatpak-info`, 'utf8');
  } catch {
    return null;
  }
  let section = '';
  let appId = null;
  let instanceId = null;
  for (const line of text.split('\n')) {
    const held = line.trim();
    if (held.startsWith('[') && held.endsWith(']')) {
      section = held.slice(1, -1);
      continue;
    }
    const split = held.indexOf('=');
    if (split < 0) continue;
    const key = held.slice(0, split);
    const value = held.slice(split + 1);
    if (section === 'Application' && key === 'name') appId = value;
    if (section === 'Instance' && key === 'instance-id') instanceId = value;
  }
  if (!appId) return null;
  return { appId, instanceId };
}

// Whether a FUSE filesystem is mounted at a path. The document portal's own
// mount is the thing that makes an exported path readable, so its presence is
// what "the document portal is ready" means.
function fuseMountedAt(mountPoint) {
  let mounts;
  try {
    mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    // No mountinfo to read: fall back to the directory existing, which is all
    // that can be known here.
    try { return fs.existsSync(mountPoint); } catch { return false; }
  }
  for (const line of mounts.split('\n')) {
    const fields = line.split(' ');
    if (fields[4] !== mountPoint) continue;
    const separator = fields.indexOf('-');
    if (separator < 0) continue;
    if (String(fields[separator + 1] || '').startsWith('fuse')) return true;
  }
  return false;
}

// The real document portal, on a bus this program made.
//
// Started here rather than activated, because a private bus is given no
// <servicedir> on purpose — see a11y_bus.js — so nothing on it can be started
// on demand. The name appearing on the bus is what "ready" means; the mount
// point is checked too, because a document portal that owns the name without
// a mount cannot export anything.
async function startDocumentPortal({
  address, binary = documentPortalBinary(), log = () => {},
  runtimeDir = process.env.XDG_RUNTIME_DIR,
} = {}) {
  if (!binary) {
    log('documents.unavailable', { reason: 'no xdg-document-portal is installed' });
    return null;
  }
  if (!runtimeDir) {
    // The portal mounts at $XDG_RUNTIME_DIR/doc and flatpak looks for it
    // there. With no runtime directory there is nowhere for the two to meet.
    log('documents.unavailable', { reason: 'XDG_RUNTIME_DIR is not set' });
    return null;
  }
  const mountPoint = path.join(runtimeDir, 'doc');
  const child = spawn(binary, [], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      DBUS_SESSION_BUS_ADDRESS: address,
      XDG_RUNTIME_DIR: runtimeDir,
    },
  });
  child.unref();

  const until = Date.now() + START_TIMEOUT_MS;
  let mounted = false;
  while (Date.now() < until) {
    // The directory existing is not enough: a previous run that was killed
    // leaves an empty directory behind with nothing answering for it, and a
    // chooser that exported into that directory would hand the browser a path
    // that reads as empty. What settles it is the mount itself.
    if (fuseMountedAt(mountPoint)) {
      mounted = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!mounted) {
    log('documents.unavailable', { reason: `${mountPoint} did not appear` });
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    return null;
  }
  log('documents.served', { binary, mountPoint, pid: child.pid });
  return {
    pid: child.pid,
    mountPoint,
    name: DOCUMENTS_NAME,
    path: DOCUMENTS_PATH,
    stop() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    },
  };
}

// Re-export one path for one application, and answer with the path that
// application can open.
//
// `write` is granted for a directory and for a save, and withheld from a file
// a browser only has to read. `--transient` ties the export to the document
// portal this program started: when that portal stops, the export is gone,
// rather than accumulating permanent grants in the reader's document store.
async function exportDocument(target, {
  appId, write = false, address, binary = flatpakBinary(), log = () => {},
} = {}) {
  if (!binary || !appId) return null;
  const args = ['document-export', '--transient', `--app=${appId}`, '--allow-read'];
  if (write) {
    args.push('--allow-write');
    // A download is written as `name.part` and renamed, and the rename is a
    // delete of the first name.
    args.push('--allow-delete');
  }
  args.push(target);
  // Asynchronous rather than `execFileSync`, because the reader is on the
  // other side of this: a synchronous child would stop the terminal for as
  // long as the export takes.
  const said = await new Promise((resolve) => {
    execFile(binary, args, {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, ...(address ? { DBUS_SESSION_BUS_ADDRESS: address } : {}) },
    }, (err, stdout, stderr) => {
      if (err) {
        log('documents.export.failed', {
          target, error: String((stderr || err.message || err)).trim().slice(0, 160),
        });
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
  if (said == null) return null;
  const exported = said.trim().split('\n').pop().trim();
  if (!exported.startsWith('/')) {
    log('documents.export.failed', { target, said: said.trim().slice(0, 120) });
    return null;
  }
  log('documents.exported', { appId, write, exported });
  return exported;
}

// What the chooser should answer a sandboxed caller with.
//
// A file is exported as itself and read-only. A directory is exported as
// itself, with write, because a directory is chosen in order to put something
// in it. A save names a file that does not exist yet, so the directory holding
// it is exported with write and the name is put back on the end — which is
// also the only arrangement a download can use, because Firefox writes
// `name.part` first and then renames it.
async function exportedPathsFor(paths, {
  appId, request, address, binary = flatpakBinary(), log = () => {},
} = {}) {
  const held = [];
  for (const each of paths) {
    if (request && request.saving) {
      const folder = path.dirname(each);
      // eslint-disable-next-line no-await-in-loop
      const exported = await exportDocument(folder, { appId, write: true, address, binary, log });
      held.push(exported ? path.join(exported, path.basename(each)) : null);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    held.push(await exportDocument(each, {
      appId, write: !!(request && request.directory), address, binary, log,
    }));
  }
  // All or nothing. A chooser that answers with one exported path and one raw
  // path has given the browser a list where some entries silently do not
  // exist, which is worse than failing the export outright.
  if (held.some((each) => !each)) return null;
  return held;
}

// ---------------------------------------------------------------------------
// Starting a browser that flatpak installed.
//
// Ubuntu is the reason this exists. Ubuntu's own Firefox is a Snap and its
// Chromium is Snap-only, and a reader who wants neither installs the Flatpak
// one — so on Ubuntu, "the browser the reader actually uses" is a Flatpak
// browser often enough to matter.

// Flatpak keeps two installations by convention: one for the machine under
// /var/lib/flatpak, one for the reader under the data home. An installation
// publishes launchers under `exports/bin` and the application's own files
// under `app/<id>/current/active/files`. A custom installation configured in
// /etc/flatpak/installations.d is not looked for here.
function installationRoots(home = os.homedir()) {
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [path.join(dataHome, 'flatpak'), '/var/lib/flatpak'];
}

// An application flatpak has installed, by its id.
//
// The launcher found here is a short script that runs `flatpak run`, and it is
// found rather than used: running the browser through it would leave nowhere
// to put the arguments flatpak itself has to be given — the environment for
// the sandbox, and the directories the sandbox may see.
function installedApp(appId, home = os.homedir()) {
  for (const root of installationRoots(home)) {
    const launcher = path.join(root, 'exports', 'bin', appId);
    try {
      fs.accessSync(launcher, fs.constants.X_OK);
      return { appId, launcher, root };
    } catch { /* keep looking */ }
  }
  return null;
}

// Where flatpak put an application's own files. A Flatpak install has no
// `platform.ini` beside its launcher, because its launcher is a script in an
// export directory, so a version has to be read from here instead.
function appFilesDirectory(appId, home = os.homedir()) {
  for (const root of installationRoots(home)) {
    const files = path.join(root, 'app', appId, 'current', 'active', 'files');
    try {
      fs.accessSync(files, fs.constants.R_OK);
      return files;
    } catch { /* keep looking */ }
  }
  return null;
}

// The application's own writable home. `~/.var/app/<id>` is the one directory
// that is the same path inside the sandbox and outside it, which is what a
// profile needs: this program writes the profile, and the browser opens it by
// the same name. Measured, in both directions.
function appDataDirectory(appId, home = os.homedir()) {
  return path.join(home, '.var', 'app', appId);
}

// Whether a directory is one the application can open without being granted
// anything. Its own data directory is; anything else has to be passed to
// `flatpak run` with --filesystem, and a profile somewhere else is a profile
// the browser silently cannot write.
function appCanReach(appId, dir, home = os.homedir()) {
  const own = appDataDirectory(appId, home);
  const resolved = path.resolve(dir);
  return resolved === own || resolved.startsWith(`${own}${path.sep}`);
}

// The two variables that must never be forwarded into the sandbox.
//
// flatpak makes an `xdg-dbus-proxy` for the session bus and another for the
// accessibility bus. It reads the session bus from its own environment, finds
// the accessibility bus by asking `org.a11y.Bus` on that session bus — which
// this program answers — and sets the sandbox's own two addresses to the two
// proxies. An --env naming this program's socket would overwrite a working
// proxy path with a path the sandbox cannot open. Measured: with neither
// variable forwarded, the sandbox still had an accessibility bus, and it
// reached this program's.
const PROXIED_BY_FLATPAK = ['DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS'];

// The command line that starts a Flatpak application.
//
// `env` is what the browser needs told, and it has to be told with --env:
// flatpak does not pass its own environment through to the sandbox. The two
// bus addresses are dropped here rather than at the call site, so that adding
// a variable later cannot reintroduce the one mistake that matters.
function runCommand({
  appId, args = [], env = {}, filesystems = [], binary = flatpakBinary(),
} = {}) {
  const flags = [];
  for (const [name, value] of Object.entries(env)) {
    if (PROXIED_BY_FLATPAK.includes(name)) continue;
    if (value == null) continue;
    flags.push(`--env=${name}=${value}`);
  }
  for (const dir of filesystems) flags.push(`--filesystem=${dir}`);
  return { command: binary || 'flatpak', args: ['run', ...flags, appId, ...args] };
}

module.exports = {
  flatpakBinary, documentPortalBinary, sandboxOf, fuseMountedAt,
  installationRoots, installedApp, appFilesDirectory, appDataDirectory,
  appCanReach, runCommand, PROXIED_BY_FLATPAK,
  startDocumentPortal, exportDocument, exportedPathsFor,
  DOCUMENTS_NAME, DOCUMENTS_PATH, DOCUMENT_PORTAL_BINARIES,
};
