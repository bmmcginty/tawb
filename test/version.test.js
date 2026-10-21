'use strict';

// The release version is written in one file and copied into the manifests
// their tools require. These tests drive the same program the Makefile does,
// inside a throwaway Git repository, so a version bump can be exercised
// without touching this checkout.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./tmpdir');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.PYTHON || 'python3';
const MAKE = process.env.MAKE || 'make';

function hasCommand(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function writeManifests(root, version) {
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tools', 'version.py'), path.join(root, 'tools', 'version.py'));
  fs.copyFileSync(path.join(ROOT, 'Makefile'), path.join(root, 'Makefile'));
  fs.writeFileSync(path.join(root, 'tools', 'build_crystal.sh'),
    '#!/bin/sh\nprintf "static binary\\n" > "$1"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'version.yml'), `version: ${version}\n`);
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture',
    version,
    main: 'index.js',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'fixture',
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'fixture', version },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'shard.yml'), `name: fixture\nversion: ${version}\n`);
}

function makeRepository(version) {
  const root = tempDir('tawb-version-');
  writeManifests(root, version);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'tawb tests']);
  git(root, ['config', 'user.email', 'tawb@example.test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function runWithEnv(root, args, extraEnv) {
  return spawnSync(PYTHON, [path.join(root, 'tools', 'version.py'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

function run(root, args) {
  return runWithEnv(root, args, {});
}

function versionOf(root) {
  return fs.readFileSync(path.join(root, 'version.yml'), 'utf8').trim().split(/\s+/)[1];
}

function manifestVersion(root, name) {
  if (name === 'shard.yml') {
    return fs.readFileSync(path.join(root, name), 'utf8').match(/^version:\s*(\S+)$/m)[1];
  }
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).version;
}

test('show-version prints the canonical version', () => {
  const root = makeRepository('1.2.0');
  const result = run(root, ['show']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1.2.0\n');
});

test('bump increments the patch, updates every manifest, commits and tags', () => {
  const root = makeRepository('1.2.0');
  const result = run(root, ['bump']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'v1.2.1\n');

  assert.equal(versionOf(root), '1.2.1');
  for (const name of ['package.json', 'package-lock.json', 'shard.yml']) {
    assert.equal(manifestVersion(root, name), '1.2.1', `${name} was not updated`);
  }
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].version, '1.2.1');

  assert.equal(git(root, ['log', '-1', '--format=%s']).trim(), 'Release v1.2.1');
  assert.match(git(root, ['tag', '--points-at', 'HEAD']), /(^|\n)v1\.2\.1(\n|$)/);
  assert.equal(git(root, ['status', '--porcelain']), '');
});

test('set accepts an explicit version and tags that version', () => {
  const root = makeRepository('1.2.0');
  const result = run(root, ['set', '2.3.4']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(versionOf(root), '2.3.4');
  assert.equal(manifestVersion(root, 'package.json'), '2.3.4');
  assert.match(git(root, ['tag', '--points-at', 'HEAD']), /(^|\n)v2\.3\.4(\n|$)/);
});

test('a dirty worktree refuses before changing anything', () => {
  const root = makeRepository('1.2.0');
  fs.writeFileSync(path.join(root, 'scratch.txt'), 'not part of a release\n');
  const before = git(root, ['rev-parse', 'HEAD']);
  const result = run(root, ['bump']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /working tree is not clean/i);
  assert.equal(versionOf(root), '1.2.0');
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(root, ['tag']), '');
});

test('check names every manifest that disagrees', () => {
  const root = makeRepository('1.2.0');
  const packagePath = path.join(root, 'package.json');
  const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  parsed.version = '9.9.9';
  fs.writeFileSync(packagePath, `${JSON.stringify(parsed, null, 2)}\n`);

  const result = run(root, ['check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package\.json says 9\.9\.9, expected 1\.2\.0/);
});

test('make version X.Y.Z passes the version through Make', { skip: !hasCommand(MAKE) }, () => {
  const root = makeRepository('1.2.0');
  const result = spawnSync(MAKE, ['version', '3.0.0'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PYTHON },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(versionOf(root), '3.0.0');
  assert.match(git(root, ['tag', '--points-at', 'HEAD']), /(^|\n)v3\.0\.0(\n|$)/);
});

test('release refuses an untagged HEAD', () => {
  const root = makeRepository('1.2.0');
  const result = run(root, ['release']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HEAD is not pointed to by v1\.2\.0/);
});

test('release publishes the tagged HEAD with the built binary', () => {
  const root = makeRepository('1.2.0');
  const set = run(root, ['set', '1.2.3']);
  assert.equal(set.status, 0, set.stderr);

  const remote = tempDir('tawb-version-remote-');
  git(remote, ['init', '--bare', '-q']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', 'origin', 'HEAD', '--tags']);

  const bin = tempDir('tawb-version-bin-');
  const ghLog = path.join(bin, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  'auth status') exit 0 ;;
  'release view') exit 1 ;;
  'release create') exit 0 ;;
esac
exit 0
`, { mode: 0o755 });

  const result = runWithEnv(root, ['release'], {
    PATH: `${bin}:${process.env.PATH || ''}`,
    GH_LOG: ghLog,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(ghLog, 'utf8');
  assert.match(calls, /auth status/);
  assert.match(calls, /release view v1\.2\.3/);
  assert.match(calls, /release create v1\.2\.3 --verify-tag --title v1\.2\.3 --generate-notes/);
  assert.match(calls, /tawb-v1\.2\.3-linux-/);
});
