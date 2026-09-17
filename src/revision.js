'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let cached = null;

// A checkout can ask Git directly. Packaged copies may have no .git directory,
// so release tooling can provide TAWB_COMMIT, and npm's gitHead metadata is a
// final source when it is present. The log always gets a field, even for an
// unpackaged source tree whose provenance cannot be recovered.
function resolveRevision({
  env = process.env,
  root = ROOT,
  exec = execFileSync,
  readFile = fs.readFileSync,
} = {}) {
  const supplied = String(env.TAWB_COMMIT || '').trim();
  if (/^[0-9a-f]{7,64}$/i.test(supplied)) return supplied;

  try {
    const revision = String(exec('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })).trim();
    if (/^[0-9a-f]{40,64}$/i.test(revision)) return revision;
  } catch { /* installed without Git metadata */ }

  try {
    const pkg = JSON.parse(readFile(path.join(root, 'package.json'), 'utf8'));
    const revision = String(pkg.gitHead || '').trim();
    if (/^[0-9a-f]{7,64}$/i.test(revision)) return revision;
  } catch { /* an incomplete package has no revision to report */ }

  return 'unknown';
}

function currentRevision() {
  if (cached == null) cached = resolveRevision();
  return cached;
}

module.exports = { currentRevision, resolveRevision };
