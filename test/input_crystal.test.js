'use strict';

// The native reader owns the terminal through termios where Node had
// setRawMode. This probe runs the conformance binary under a pty (via
// `script`) and asks it to take the terminal raw, report the line
// discipline while raw is held, and hand the saved state back: the raw
// flags must be off, and the restored state must match what was read at
// the start, byte for byte.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const binary = process.env.TAWB_CRYSTAL_BIN
  || path.join(__dirname, '..', 'bin', 'tawb');

function runProbe() {
  // The child reads its payload from stdin, which is the pty slave here.
  // The payload line plus an EOT (^D, the canonical EOF character) ends
  // the read without ending the pty, which `script` keeps open for the
  // child's sake.
  const run = spawnSync('script', ['-qec', `${binary} --conformance input.raw_probe`, '/dev/null'], {
    input: '{}\n\x04',
    encoding: 'utf8',
    timeout: 20000,
  });
  const lines = String(run.stdout || '').split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.startsWith('{'));
  const parsed = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((envelope) => envelope && envelope.ok && envelope.value
    && envelope.value.tty !== undefined);
  if (!parsed.length) {
    throw new Error(`raw probe produced no report: ${run.stderr || run.stdout}`);
  }
  return parsed[parsed.length - 1].value;
}

test('the native reader takes the terminal raw and gives it back', (t) => {
  if (process.env.TAWB_TEST_CRYSTAL !== '1') {
    t.skip('exercises the Crystal termios path only');
    return;
  }
  if (!fs.existsSync(binary)) {
    t.skip('crystal binary is not built');
    return;
  }
  if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('script (util-linux) is not available for the pty');
    return;
  }
  const report = runProbe();
  assert.equal(report.tty, true, 'the probe must run against a real terminal');
  assert.deepEqual(report.raw, { icanon: false, echo: false, isig: false, opost: false },
    'raw mode clears the line discipline, the echo, the signals and the output processing');
  assert.equal(report.restore_ok, true, 'the saved discipline goes back on');
  assert.equal(report.restored, true, 'and the restored state is what was read at the start');
});
