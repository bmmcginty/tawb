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
