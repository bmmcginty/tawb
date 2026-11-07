'use strict';

// A reader left running while the page keeps changing, in a real terminal.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_soak.test.js
//     TAWB_SOAK_MS=3600000 tools/test_soak.sh   # the long run
//
// The policy tests pin when a live refresh happens; the differentials compare
// what one refresh does. Neither can say whether a reader that refreshes for
// an hour keeps its descriptors, processes and memory bounded, or whether it
// still answers after the mutation storm. This keeps one page mutating on two
// scales — a live region on every tick and a structural change every couple of
// seconds — drives the reader through navigation, refresh and next-change while
// it happens, and samples the whole process group from outside.
//
// Browser-side handles are not visible here. Their creation and disposal are
// asserted on the wire by the double-disposal and protocol-trace tests; what
// this adds is many repeated actions against one browser with no growth in the
// things a leak would show at the process boundary.
//
// The short run is the CI smoke case. A long run is deliberately not proved by
// it: TAWB_SOAK_MS scales the same assertions to the hour-long qualification.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const {
  RUNTIMES, ReaderTty, sleep, browserTestSkip, environment,
  waitForProfileToDrain, killProfile, waitForRow,
} = require('./tmux_reader');

const skip = browserTestSkip();

// Long enough for several live refreshes and several rounds of actions; kept
// short enough that the ordinary browser gate can run it on every change.
const DURATION_MS = Math.max(8000, Number(process.env.TAWB_SOAK_MS) || 30000);
const SAMPLE_MS = 1000;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Soak fixture</title></head>
<body>
  <h1>Soak fixture</h1>
  <div role="status">Ready</div>
  <p>Soak paragraph zero, quiet and steady.</p>
  <button id="soak">Touch the page</button>
  <p id="extra"></p>
  <script>
    let ticks = 0;
    let touches = 0;
    setInterval(() => {
      document.querySelector('[role=status]').textContent = 'Tick ' + (++ticks);
    }, 100);
    setInterval(() => {
      document.getElementById('extra').textContent =
        ticks % 2 ? 'Extra row present.' : '';
    }, 2000);
    document.getElementById('soak').addEventListener('click', () => {
      document.querySelector('h1').textContent = 'Soak fixture touched ' + (++touches);
    });
  </script>
</body></html>`;

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

function residentKb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function openDescriptors(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return 0;
  }
}

function descendants(pid) {
  const found = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    let children = [];
    try {
      const listing = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parent)],
        { encoding: 'utf8' });
      children = String(listing.stdout || '').trim().split('\n')
        .map((line) => Number(line.trim())).filter(Boolean);
    } catch {
      children = [];
    }
    for (const child of children) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

// The reader, whatever it started, and the browser on the same profile. The
// browser is detached into its own process group, so a tree walk from the pane
// does not reach it; processesUsing does.
function sample(profile, panePid) {
  const pids = new Set([...descendants(panePid), ...processesUsing(profile)]);
  let resident = 0;
  for (const pid of pids) resident += residentKb(pid);
  return {
    at: Date.now(),
    rssMb: Math.round(resident / 1024),
    fds: openDescriptors(panePid),
    processes: processesUsing(profile).length,
    alive: pids.size,
  };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

function report(samples) {
  return samples.map((s) => `${s.rssMb}MB/${s.fds}fd/${s.processes}p`).join(' ');
}

async function soak(root, runtime, server) {
  const name = `${runtime.name}-soak`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const reader = new ReaderTty({
    session: `tawb-soak-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', 'firefox', '--profile', profile,
      '--no-alt-screen', server.url],
    env: environment(root, name),
  });
  const samples = [];
  try {
    await reader.start({ ready: 'Soak fixture' });
    // Let the first snapshot, live attach and browser startup settle before
    // the baseline: those are one-off costs, not growth.
    await sleep(3000);
    assert.ok(reader.alive(), `${runtime.name} left before the soak began`);
    const panePid = reader.panePid();
    const baseline = sample(profile, panePid);
    samples.push(baseline);

    const started = Date.now();
    let touched = false;
    let lastKey = 0;
    let lastRefresh = 0;
    while (Date.now() - started < DURATION_MS) {
      await sleep(SAMPLE_MS);
      const elapsed = Date.now() - started;
      // An idle stretch in the middle: no keys, so the live ticker and the
      // page's own mutations are the only work.
      const idle = elapsed > DURATION_MS * 0.4 && elapsed < DURATION_MS * 0.55;
      if (!idle) {
        // Move, ask for a rescan and jump to the next change. These are the
        // browser-bound actions the reader repeats while live updates run.
        if (Date.now() - lastKey > 1200) {
          // A live page never goes quiet, so a key is sent rather than waited
          // on: the soak is the mutations and the actions, not the pauses
          // between them.
          reader.send(elapsed % 2400 < 1200 ? 'Down' : 'Up');
          lastKey = Date.now();
        }
        if (!touched) {
          reader.send('b');
          reader.send('Enter');
          touched = await waitForRow(reader, 'touched', 10000);
          assert.ok(touched, `${runtime.name} did not activate the button during live updates`);
        }
        if (Date.now() - lastRefresh > 6000) {
          reader.send('r');
          reader.send('c');
          lastRefresh = Date.now();
        }
      }
      const current = sample(profile, panePid);
      samples.push(current);
      assert.ok(current.processes > 0,
        `${runtime.name} lost the browser during the soak: ${report(samples)}`);
      assert.ok(reader.alive(),
        `${runtime.name} left during the soak: ${report(samples)}`);
    }

    // The reader still answers after the storm: the status row is rewritten
    // by a key the reader owns, not by the page.
    reader.send('=');
    await sleep(1000);
    assert.match(reader.status(), /\S/,
      `${runtime.name} did not answer a key after the soak`);

    const window = Math.max(1, Math.ceil(samples.length / 4));
    const early = samples.slice(0, window);
    const late = samples.slice(-window);
    const start = {
      rssMb: median(early.map((s) => s.rssMb)),
      fds: median(early.map((s) => s.fds)),
      processes: median(early.map((s) => s.processes)),
    };
    const end = {
      rssMb: median(late.map((s) => s.rssMb)),
      fds: median(late.map((s) => s.fds)),
      processes: median(late.map((s) => s.processes)),
    };
    const peakProcesses = Math.max(...samples.map((s) => s.processes));

    // The budgets are deliberately loose: a browser caches, a renderer
    // restarts, and a garbage collection may not have happened yet. What they
    // still exclude is a descriptor, process or buffer that grows with every
    // tick, which over an hour would cross any of these.
    assert.ok(end.fds <= start.fds + 12,
      `${runtime.name} descriptors grew from ${start.fds} to ${end.fds}: ${report(samples)}`);
    assert.ok(end.rssMb <= start.rssMb + Math.max(40, Math.round(start.rssMb * 0.5)),
      `${runtime.name} resident memory grew from ${start.rssMb}MB to ${end.rssMb}MB: `
      + report(samples));
    assert.ok(peakProcesses <= start.processes + 6,
      `${runtime.name} process count peaked at ${peakProcesses} from ${start.processes}: `
      + report(samples));

    await reader.quit();
    assert.ok(await waitForProfileToDrain(profile, 15000),
      `${runtime.name} left a browser running after quitting`);
    assert.deepEqual(processesUsing(profile), [],
      `${runtime.name} left a process naming the profile`);
    return { start, end, peakProcesses, samples: samples.length, touched };
  } finally {
    reader.stop();
  }
}

for (const runtime of RUNTIMES) {
  test(`a ${runtime.name} reader stays bounded while the page mutates and is driven`,
    { skip }, async () => {
      const root = tempDir(`tawb-soak-${runtime.name}-`);
      const server = await startServer();
      try {
        const result = await soak(root, runtime, server);
        assert.equal(result.touched, true);
        assert.ok(result.samples >= 3, 'the soak took too few samples to judge growth');
      } finally {
        await server.close();
        removeTempDir(root);
      }
    });
}
