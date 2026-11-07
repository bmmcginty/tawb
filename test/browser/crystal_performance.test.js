'use strict';

// A first performance corpus for the two runtimes, measured from outside.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_performance.test.js
//
// Behavioral equality that makes the native reader noticeably slower is not
// parity. This runs the same five documents through both readers in a real
// terminal, on both engines, and records the phases a person notices: startup
// to first page, key-to-cursor latency, a whole refresh, the idle cost of a
// live page, and the resident memory and descriptors left behind. tmux is the
// only channel; neither runtime's internals are read. Every comparison is made
// within one engine: Chromium and Firefox are two different browsers, and a
// native reader that is slower than the reference on one of them is a parity
// failure regardless of how the other engine behaves.
//
// The budgets are ratios with an allowance for scheduler noise plus absolute
// ceilings a local action should never cross. They are smoke budgets, not the
// full performance qualification: privileged scan counts, protocol command
// counts, frame queries and handle lifecycles are counted by the
// protocol-trace and ARIA/role gates where the wire is observable. A failure
// reports every phase for both runtimes, including the live-pulse and refresh
// counts from the diagnostic log, so a slow number can be read as work rather
// than guessed at.
//
// Snapshot extraction and ordering are budgeted per snapshot, taken from the
// median of the `snapshot` records each runtime writes, because the number of
// snapshots a page takes depends on how many live pulses landed in the
// window. The two runtimes send the same page functions with the same
// arguments, so an extraction that reads the same blocks in twice the time is
// work, not a missing call: the native client parses the accessibility
// answers into Crystal values where the reference keeps the decoded JSON, and
// that conversion measured between 1.3 and 2.3 times the reference phase on
// the frame, shadow and live pages. The budget is therefore a ceiling that
// catches a second scan or a per-block round trip, not a claim of equality;
// the block counts are compared exactly so a faster extraction that dropped
// blocks fails.
//
// TAWB_PERF_ONLY=large narrows the corpus while calibrating a budget,
// TAWB_PERF_ENGINE=firefox narrows it to one engine while doing the same, and
// TAWB_PERF_REVERSE=1 runs the runtimes in the opposite order so a budget
// that only passes because of which profile ran first is visible.

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
  waitForProfileToDrain, killProfile,
} = require('./tmux_reader');

const skip = browserTestSkip();

// What a local keystroke may cost before it is visibly slow, and how much
// slower than the JavaScript reference the native reader may be. The slack is
// for one scheduler quantum and tmux's own capture, not for a second pass.
const KEY_CEILING_MS = 400;
const REFRESH_CEILING_MS = 15000;
const STARTUP_CEILING_MS = 90000;
const LIVE_CPU_CEILING_MS = 45000;
// A whole-page extraction is one page evaluation per document plus the media
// probe, so its cost should not grow faster than the reference's. The
// allowance covers the difference between a reference that decodes JSON and a
// native client that builds typed values from it; a second scan of the same
// document, or a round trip per block, crosses it.
const EXTRACT_RATIO = 2.5;
const EXTRACT_ALLOWANCE_MS = 30;
const ORDER_RATIO = 2.5;
const ORDER_ALLOWANCE_MS = 10;
// Snapshots taken for the same reason land in the same window; a runtime that
// re-read the page on its own clock would take materially more.
const SNAPSHOT_PASS_ALLOWANCE = 2;

// The engines the corpus runs on. A missing browser is reported rather than
// silently dropping half of the comparison; every release environment runs
// both, since the JavaScript browser suites need them anyway.
const ENGINES = ['firefox', 'chromium'];
const CHROMIUM_CANDIDATES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];

function engineAvailable(engine) {
  if (engine === 'firefox') return true;
  return CHROMIUM_CANDIDATES.some((name) =>
    spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
}

const CORPUS = {
  small() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Small corpus page</title></head><body>
<h1>Small corpus page</h1>
${Array.from({ length: 8 }, (unused, i) => `<p>Small paragraph ${i}.</p>`).join('\n')}
<a href="#target">Small link</a>
<label>Small field <input aria-label="Small field"></label>
<p id="target">Small target.</p>
</body></html>`;
  },
  large() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Large corpus page</title></head><body>
<h1>Large corpus page</h1>
${Array.from({ length: 1500 }, (unused, i) => `<p>Large paragraph ${i}.</p>`).join('\n')}
</body></html>`;
  },
  frames() {
    const children = Array.from({ length: 24 }, (unused, i) =>
      `<iframe title="Corpus frame ${i}" src="/frame?n=${i}"></iframe>`).join('\n');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Frame corpus page</title></head><body>
<h1>Frame corpus page</h1>
${children}
</body></html>`;
  },
  frame(n) {
    return `<!doctype html><meta charset="utf-8"><title>Corpus frame ${n}</title>
<body><p>Corpus frame ${n} paragraph.</p></body>`;
  },
  shadow() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Shadow corpus page</title></head><body>
<h1>Shadow corpus page</h1>
<div id="roots"></div>
<script>
  const host = document.getElementById('roots');
  for (let i = 0; i < 160; i += 1) {
    const element = document.createElement('div');
    element.attachShadow({ mode: 'open' }).innerHTML =
      '<p>Shadow paragraph ' + i + '.</p><button>Shadow button ' + i + '</button>';
    host.append(element);
  }
</script>
</body></html>`;
  },
  live() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Live corpus page</title></head><body>
<h1>Live corpus page</h1>
<div role="status">Live ready</div>
${Array.from({ length: 200 }, (unused, i) => `<p>Live paragraph ${i}.</p>`).join('\n')}
<script>
  let ticks = 0;
  setInterval(() => {
    document.querySelector('[role=status]').textContent = 'Live tick ' + (++ticks);
  }, 100);
</script>
</body></html>`;
  },
};

function readyText(kind) {
  // Something the first viewport can hold. A heading deep in a large document
  // would be a scroll test, not a startup measurement.
  return {
    small: 'Small corpus page',
    large: 'Large corpus page',
    frames: 'Corpus frame 0 paragraph.',
    shadow: 'Shadow paragraph 0.',
    live: 'Live corpus page',
  }[kind];
}

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    if (req.url.startsWith('/frame')) {
      const number = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('n')) || 0;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      });
      res.end(CORPUS.frame(number));
      return;
    }
    const kind = req.url.replace(/^\//, '') || 'small';
    const body = CORPUS[kind] ? CORPUS[kind]() : CORPUS.small();
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function cpuTicks(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields after the parenthesised command name; utime and stime are the
    // 14th and 15th fields overall.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return Number(fields[11]) + Number(fields[12]);
  } catch {
    return 0;
  }
}

function residents(profile, panePid) {
  const browserPids = processesUsing(profile);
  const pids = new Set([panePid, ...browserPids]);
  let kb = 0;
  let fds = 0;
  let cpu = 0;
  let browserCpu = 0;
  try {
    fds = fs.readdirSync(`/proc/${panePid}/fd`).length;
  } catch {
    fds = 0;
  }
  for (const pid of pids) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) kb += Number(match[1]);
    } catch {
      // A renderer may have restarted between the listing and the read.
    }
    cpu += cpuTicks(pid);
  }
  // The reader's own command line names the profile, so it appears in
  // browserPids too. Subtract it from the browser side rather than counting
  // the reader as browser work.
  for (const pid of browserPids) {
    if (pid !== panePid) browserCpu += cpuTicks(pid);
  }
  return { rssMb: Math.round(kb / 1024), fds, cpu, browserCpu };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

async function waitForStatusWhere(reader, pattern, timeout) {
  for (const deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (pattern.test(reader.status())) return true;
    await sleep(10);
  }
  return pattern.test(reader.status());
}

function logSummary(directory) {
  const counts = {};
  const snapshots = [];
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => name.includes('.tawb.'));
  } catch {
    return { counts, snapshots, extractMs: 0, orderMs: 0, blocks: 0 };
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
        if (record.event) counts[record.event] = (counts[record.event] || 0) + 1;
        if (record.event === 'snapshot') {
          snapshots.push({
            extractMs: Number(record.extractMs) || 0,
            orderMs: Number(record.orderMs) || 0,
            ms: Number(record.ms) || 0,
            blocks: Number(record.blocks) || 0,
          });
        }
      } catch {
        // A record cut short by shutdown is not a count.
      }
    }
  }
  // The median phase of a snapshot, so one startup snapshot taken against a
  // cold page does not decide the budget. The block count is the median too,
  // and is compared exactly: the two runtimes must have read the same page.
  return {
    counts,
    snapshots,
    extractMs: snapshots.length ? median(snapshots.map((entry) => entry.extractMs)) : 0,
    orderMs: snapshots.length ? median(snapshots.map((entry) => entry.orderMs)) : 0,
    blocks: snapshots.length ? median(snapshots.map((entry) => entry.blocks)) : 0,
  };
}

// The status row is not only the reader's: a live page that announces itself
// puts its own words there, and on that page the answer to a key can be
// replaced before a capture reads it. The ticker's own log is the barrier
// that cannot be overwritten, so a key counts as answered when the row says
// so or when the pulses it restarts appear.
async function waitForPulsesAfter(logDirectory, before, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((logSummary(logDirectory).counts['live.pulse'] || 0) > before) return true;
    await sleep(100);
  }
  return false;
}

async function measure(runtime, kind, root, server, engine) {
  const name = `${runtime.name}-perf-${engine}-${kind}`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const logDirectory = path.join(root, name, 'log');
  const reader = new ReaderTty({
    session: `tawb-perf-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', engine, '--profile', profile,
      '--log', '--log-dir', logDirectory,
      '--no-alt-screen', `${server.origin}/${kind}`],
    env: environment(root, name),
  });
  let measured = false;
  try {
    const started = Date.now();
    await reader.start({ ready: readyText(kind), timeout: STARTUP_CEILING_MS });
    const startupMs = Date.now() - started;

    // A frame-heavy page is still arriving after its own heading has been
    // drawn. Let the first live scan and frame arming finish, then take the
    // keyboard, so the latency measured below is the reader's and not a
    // snapshot landing between the key and its repaint.
    reader.send('=');
    assert.ok(await waitForStatusWhere(reader, /^line \d+\/\d+/, 15000),
      `${runtime.name} never settled on the ${kind} page`);
    await sleep(750);

    // The first idle window is the ticker alone on a settled page, before any
    // of the measured keys have asked for a refresh. The settle is long
    // enough for a frame-heavy page to arm each frame and take its first
    // pass, so the reading is the steady ticker and not the startup burst.
    await sleep(2000);
    const startupIdleStart = residents(profile, reader.panePid());
    await sleep(2000);
    const startupIdleEnd = residents(profile, reader.panePid());
    const startupIdleCpuMs = Math.max(0, (startupIdleEnd.cpu - startupIdleStart.cpu) * 10);

    // The link-address switch is a local action whose status row alternates,
    // so a key's cost is the time to its final row without depending on how
    // far down a particular fixture the cursor happens to be. One unmeasured
    // press establishes which answer the next one must produce.
    reader.send('u');
    assert.ok(await waitForStatusWhere(reader, /Link addresses (on|off)\./, 5000),
      `${runtime.name} did not answer the link-address switch on the ${kind} page`);
    let expectOn = !reader.status().includes('on');
    const keyLatencies = [];
    for (let step = 0; step < 8; step += 1) {
      const startedKey = Date.now();
      reader.send('u');
      const wanted = expectOn ? /Link addresses on\./ : /Link addresses off\./;
      if (!await waitForStatusWhere(reader, wanted, 5000)) {
        assert.fail(`${runtime.name} did not answer the link-address switch `
          + `on the ${kind} page`);
      }
      keyLatencies.push(Date.now() - startedKey);
      expectOn = !expectOn;
      await sleep(50);
    }

    // A live page starts a refresh on its own clock, and a manual refresh
    // that arrives while one is running may be dropped. Turn the ticker off
    // for the refresh measurements so a key that is refused cannot look like
    // a refresh that never finished, then put it back for the idle window.
    reader.send('L');
    assert.ok(await waitForStatusWhere(reader, /Live updates off/, 5000),
      `${runtime.name} did not stop live updates for the refresh measurement`);
    const refreshTimings = [];
    for (let step = 0; step < 4; step += 1) {
      // A status of its own before every refresh, so a refresh cannot look
      // finished because the previous one left "Rescanned." on the row.
      reader.send('=');
      assert.ok(await waitForStatusWhere(reader, /^line \d+\/\d+/, 5000),
        `${runtime.name} did not report its position on the ${kind} page`);
      const startedRefresh = Date.now();
      reader.send('r');
      assert.ok(await waitForStatusWhere(reader, /Rescanned\./, REFRESH_CEILING_MS),
        `${runtime.name} never finished a refresh on the ${kind} page`);
      refreshTimings.push(Date.now() - startedRefresh);
      await sleep(100);
    }
    const pulsesBefore = logSummary(logDirectory).counts['live.pulse'] || 0;
    reader.send('L');
    assert.ok(await waitForStatusWhere(reader, /Live updates on/, 5000)
      || await waitForPulsesAfter(logDirectory, pulsesBefore),
      `${runtime.name} did not restart live updates after the refresh measurement`);
    await sleep(500);

    const idleStart = residents(profile, reader.panePid());
    const idleWall = 4000;
    await sleep(idleWall);
    const idleEnd = residents(profile, reader.panePid());
    const idleCpuMs = Math.max(0, (idleEnd.cpu - idleStart.cpu) * 10);
    const idleBrowserMs = Math.max(0, (idleEnd.browserCpu - idleStart.browserCpu) * 10);
    const idleReaderMs = Math.max(0, idleCpuMs - idleBrowserMs);

    const final = residents(profile, reader.panePid());
    // The budgets below compare readings from /proc. If the reader's process
    // is outside this test's view — a tmux server started outside the run's
    // namespace, for instance — every reading is zero and the gate would pass
    // by measuring nothing.
    assert.ok(final.fds > 0,
      `${runtime.name}'s descriptors were not visible under /proc/${reader.panePid()}`);
    assert.ok(final.rssMb > 0,
      `${runtime.name}'s resident memory was not visible under /proc/${reader.panePid()}`);
    const logs = logSummary(logDirectory);
    // The reading is complete; only the log and profile directories are left.
    measured = true;
    return {
      kind,
      engine,
      runtime: runtime.name,
      startupMs,
      keyMs: median(keyLatencies),
      refreshMs: median(refreshTimings),
      idleCpuMs,
      startupIdleCpuMs,
      idleBrowserMs,
      idleReaderMs,
      rssMb: final.rssMb,
      fds: final.fds,
      logCounts: logs.counts,
      snapshotCount: logs.snapshots.length,
      snapshotExtractMs: logs.extractMs,
      snapshotOrderMs: logs.orderMs,
      snapshotBlocks: logs.blocks,
      profile,
    };
  } finally {
    reader.stop();
    killProfile(profile);
    await waitForProfileToDrain(profile, 15000);
    // A corpus of twenty launches keeps every profile it has written, and a
    // Chromium profile is a cache of its own. Retaining them for the whole run
    // filled the temporary filesystem and made the last pages fail to start.
    // A failed measurement keeps its directory for the artifacts; a completed
    // one gives the space back.
    if (measured) removeTempDir(path.join(root, name));
  }
}

function line(result) {
  const events = Object.entries(result.logCounts)
    .filter(([event]) => ['live.pulse', 'live.refresh', 'snapshot', 'live.tick.error',
      'navigate', 'activate'].includes(event))
    .map(([event, count]) => `${event}=${count}`).join(',');
  return `${result.engine} ${result.kind} ${result.runtime}: startup ${result.startupMs}ms, `
    + `key ${result.keyMs}ms, refresh ${result.refreshMs}ms, `
    + `idle cpu ${result.idleCpuMs}ms/${4000}ms (first ${result.startupIdleCpuMs}ms/2000ms) `
    + `(reader ${result.idleReaderMs}, browser ${result.idleBrowserMs}), `
    + `${result.rssMb}MB, ${result.fds} descriptors, `
    + `snapshot ${result.snapshotExtractMs}ms extract + ${result.snapshotOrderMs}ms order `
    + `for ${result.snapshotBlocks} blocks`
    + (events ? `, ${events}` : '');
}

test('both runtimes stay within the performance budgets on the corpus', { skip },
  async (t) => {
    const root = tempDir('tawb-performance-');
    const server = await startServer();
    try {
      const results = {};
      const selected = Object.keys(CORPUS).filter((name) => name !== 'frame'
        && (!process.env.TAWB_PERF_ONLY || name === process.env.TAWB_PERF_ONLY));
      const order = process.env.TAWB_PERF_REVERSE ? [...RUNTIMES].reverse() : RUNTIMES;
      const engines = ENGINES.filter((engine) =>
        (!process.env.TAWB_PERF_ENGINE || engine === process.env.TAWB_PERF_ENGINE));
      for (const engine of engines) {
        if (!engineAvailable(engine)) {
          t.diagnostic(`${engine} is not installed; the engine dimension of the corpus `
            + 'was not measured');
        }
      }
      const measured = engines.filter(engineAvailable);
      assert.ok(measured.length > 0, 'no browser was available to measure the corpus');
      for (const engine of measured) {
        for (const kind of selected) {
          const entry = `${engine}/${kind}`;
          results[entry] = [];
          for (const runtime of order) {
            results[entry].push(await measure(runtime, kind, root, server, engine));
          }
        }
      }
      for (const entry of Object.keys(results)) {
        for (const result of results[entry]) t.diagnostic(line(result));
      }

      const failures = [];
      for (const [kind, pair] of Object.entries(results)) {
        const javascript = pair.find((result) => result.runtime === 'JavaScript');
        const crystal = pair.find((result) => result.runtime === 'Crystal');
        const check = (label, native, reference, ratio, absolute) => {
          const limit = Math.max(reference * ratio, reference + absolute);
          if (native > limit) {
            failures.push(`${kind}: ${label} ${native} > ${Math.round(limit)} `
              + `(JavaScript ${reference})`);
          }
        };
        check('startup', crystal.startupMs, javascript.startupMs, 1.2, 2000);
        check('key latency', crystal.keyMs, javascript.keyMs, 1.5, 50);
        check('refresh', crystal.refreshMs, javascript.refreshMs, 1.5, 150);
        check('first idle CPU', crystal.startupIdleCpuMs, javascript.startupIdleCpuMs, 2, 150);
        check('idle CPU', crystal.idleCpuMs, javascript.idleCpuMs, 2, 250);
        check('resident memory', crystal.rssMb, javascript.rssMb, 1.25, 150);
        check('descriptors', crystal.fds, javascript.fds, 1, 16);
        check('snapshot extraction', crystal.snapshotExtractMs, javascript.snapshotExtractMs,
          EXTRACT_RATIO, EXTRACT_ALLOWANCE_MS);
        check('snapshot ordering', crystal.snapshotOrderMs, javascript.snapshotOrderMs,
          ORDER_RATIO, ORDER_ALLOWANCE_MS);
        // A budget that passes because the native reader read less of the page
        // would be worse than no budget.
        if (crystal.snapshotBlocks !== javascript.snapshotBlocks) {
          failures.push(`${kind}: snapshot read ${crystal.snapshotBlocks} blocks, `
            + `JavaScript read ${javascript.snapshotBlocks}`);
        }
        // The live page refreshes on its own clock, and how many of those
        // land in the window is the page's business: the same build measured
        // 7 and 24 snapshots on it in consecutive runs. Its cost is already
        // the idle CPU reading above, so the pass count is only compared on
        // the pages whose snapshots come from this test's own keys.
        if (crystal.kind !== 'live'
          && crystal.snapshotCount > javascript.snapshotCount + SNAPSHOT_PASS_ALLOWANCE) {
          failures.push(`${kind}: ${crystal.snapshotCount} snapshots against `
            + `JavaScript's ${javascript.snapshotCount}`);
        }
        if (crystal.keyMs > KEY_CEILING_MS) {
          failures.push(`${kind}: key latency ${crystal.keyMs}ms > ${KEY_CEILING_MS}ms`);
        }
        if (crystal.refreshMs > REFRESH_CEILING_MS) {
          failures.push(`${kind}: refresh ${crystal.refreshMs}ms > ${REFRESH_CEILING_MS}ms`);
        }
        if (crystal.startupMs > STARTUP_CEILING_MS) {
          failures.push(`${kind}: startup ${crystal.startupMs}ms > ${STARTUP_CEILING_MS}ms`);
        }
        if (crystal.startupIdleCpuMs > LIVE_CPU_CEILING_MS / 2) {
          failures.push(`${kind}: first idle CPU ${crystal.startupIdleCpuMs}ms `
            + `> ${LIVE_CPU_CEILING_MS / 2}ms`);
        }
        if (crystal.idleCpuMs > LIVE_CPU_CEILING_MS) {
          failures.push(`${kind}: idle CPU ${crystal.idleCpuMs}ms > ${LIVE_CPU_CEILING_MS}ms`);
        }
      }
      assert.deepEqual(failures, [],
        `performance budgets failed:\n${failures.join('\n')}\n\n`
        + Object.values(results).flat().map(line).join('\n'));

      // Every page was left with no browser of its own.
      for (const [kind, pair] of Object.entries(results)) {
        for (const result of pair) {
          assert.deepEqual(processesUsing(result.profile), [],
            `${result.runtime} left a process naming the ${kind} profile`);
        }
      }
    } finally {
      await server.close();
      removeTempDir(root);
    }
  });
