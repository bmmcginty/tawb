'use strict';

// How much of the screen a key repaints, through a real terminal.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_repaint.test.js
//
// A repainted row is read again by a screen reader and flashed again by a
// braille display whether or not it says anything new, so the scope of a
// repaint is user-observable even when the resulting screen is identical. The
// scripted reader tests pin that behaviour for one runtime's state machine;
// this drives the same keys through both terminals and compares what each
// runtime told the tty it was writing.
//
// Both runtimes log a `repaint` record with the rows they patched, the height
// of the list area, whether the repaint was whole-screen, and the view. The
// comparison is per key of the rows written and the whole-screen repaints, not
// of how many times the patcher was called: a call that writes no row costs
// the terminal and the reader nothing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile,
} = require('./tmux_reader');

const skip = browserTestSkip();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Repaint fixture</title></head>
<body>
<h1>Repaint fixture</h1>
<p><button id="press">Update two paragraphs</button></p>
${Array.from({ length: 40 }, (unused, i) =>
    `<p id="p${i}">Repaint paragraph ${i} with <a href="#p${i}">link ${i}</a>.</p>`).join('\n')}
<label>Repaint field <input aria-label="Repaint field"></label>
<script>
  document.getElementById('press').addEventListener('click', () => {
    document.getElementById('p5').textContent = 'Paragraph five was updated.';
    document.getElementById('p6').textContent = 'Paragraph six was updated.';
  });
</script>
</body></html>`;

// Keys a reader presses while reading. Live updates are turned off first: the
// point of this test is what a key asks the terminal to write, and a live
// refresh landing on its own clock would land in a different key's window on
// each runtime. With the page quiet, pressing the button and then rescanning
// is a deterministic two-row change, and the rest of the keys are movement and
// status rows that must not repaint the list.
const KEYS = ['L', 'Down', 'Enter', 'r', 'Down', 'u', 'u', '='];

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/fixture`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function repaintEvents(directory) {
  const events = [];
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => name.includes('.tawb.'));
  } catch {
    return events;
  }
  for (const file of files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(directory, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const record = JSON.parse(line);
        if (record.event === 'repaint') events.push(record);
      } catch {
        // A record cut short by shutdown is not a repaint.
      }
    }
  }
  return events;
}

// Wait until no new repaint has been logged for a moment, so the records that
// arrive after a key are attributed to that key rather than to the next one.
async function settleRepaints(directory, seen, timeout = 4000) {
  let count = repaintEvents(directory).length;
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    await sleep(100);
    const now = repaintEvents(directory).length;
    if (now === count) return repaintEvents(directory).slice(seen);
    count = now;
  }
  return repaintEvents(directory).slice(seen);
}

function summarize(events) {
  return {
    rows: events.reduce((sum, event) => sum + (Number(event.rows) || 0), 0),
    wholeScreen: events.filter((event) => event.full).length,
  };
}

// A rescan is not finished when the key has been read: the snapshot is a
// browser round trip, and its repaint lands afterwards. Counting the snapshot
// records is the barrier that keeps it out of the next key's window.
function snapshotCount(directory) {
  let count = 0;
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => name.includes('.tawb.'));
  } catch {
    return count;
  }
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(directory, file), 'utf8').split('\n')) {
      if (line.startsWith('{') && line.includes('"event":"snapshot"')) count += 1;
    }
  }
  return count;
}

async function waitForSnapshot(directory, before, timeout = 20000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (snapshotCount(directory) > before) return true;
    await sleep(100);
  }
  return false;
}

async function waitForStatus(reader, pattern, timeout = 15000) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(reader.status())) return true;
    await sleep(100);
  }
  return pattern.test(reader.status());
}

async function repaintRun(root, runtime, server) {
  const name = `${runtime.name}-repaint`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const logDirectory = path.join(root, name, 'log');
  const reader = new ReaderTty({
    session: `tawb-repaint-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [
      ...runtime.args,
      '--browser', 'firefox', '--profile', profile,
      '--log', '--log-dir', logDirectory,
      '--no-alt-screen', server.url,
    ],
    env: environment(root, name),
  });
  try {
    await reader.start({ ready: 'Repaint fixture' });
    // Let the first live pass settle: a page that has just been read has work
    // of its own, and it would otherwise be attributed to the first key.
    await settleRepaints(logDirectory, 0);
    const steps = [];
    let seen = repaintEvents(logDirectory).length;
    for (const key of KEYS) {
      const snapshots = snapshotCount(logDirectory);
      reader.send(key);
      // A rescan has not finished when its key has been read; wait for the
      // snapshot it takes so its repaint belongs to this key.
      if (key === 'r') await waitForSnapshot(logDirectory, snapshots);
      const events = await settleRepaints(logDirectory, seen);
      seen += events.length;
      steps.push({ key, repaint: summarize(events) });
    }
    assert.ok(await waitForStatus(reader, /^line \d+\/\d+/),
      `${name} never reported its position on the fixture`);
    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [], `${name} left a profile process`);
    return steps;
  } finally {
    reader.stop();
  }
}

test('both readers repaint the same rows for the same keys', { skip }, async (t) => {
  const root = tempDir('tawb-repaint-');
  const server = await startServer();
  const profiles = [];
  try {
    const seen = [];
    for (const runtime of RUNTIMES) {
      profiles.push(path.join(root, `${runtime.name}-repaint`.toLowerCase(), 'profile'));
      seen.push(await repaintRun(root, runtime, server));
    }
    for (const runtime of RUNTIMES) {
      const index = RUNTIMES.indexOf(runtime);
      t.diagnostic(`${runtime.name} repainted `
        + seen[index].map((step) => `${step.key}=${step.repaint.rows}`
          + (step.repaint.wholeScreen ? `+${step.repaint.wholeScreen}full` : '')).join(' '));
    }
    assert.deepEqual(seen[1], seen[0],
      'the two readers repainted different amounts of the screen for the same keys:'
      + `\nJavaScript ${JSON.stringify(seen[0])}\nCrystal ${JSON.stringify(seen[1])}`);
    // A scenario that repainted nothing would pass whatever the two runtimes
    // did with the patcher.
    const repainted = seen[0].reduce((sum, step) => sum + step.repaint.rows, 0);
    assert.ok(repainted > 0,
      'the key sequence never repainted a row, so nothing was compared: '
      + JSON.stringify(seen[0]));
  } finally {
    for (const profile of profiles) killProfile(profile);
    await server.close();
    removeTempDir(root);
  }
});
