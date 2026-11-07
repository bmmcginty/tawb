'use strict';

// A first performance corpus for the two runtimes, measured from outside.
//
//     xvfb-run -a env TAWB_TEST_CRYSTAL_BROWSER=1 TAWB_TEST_CRYSTAL=1 \
//       TAWB_SKIP_BUILD=1 node --test test/browser/crystal_performance.test.js
//
// Behavioral equality that makes the native reader noticeably slower is not
// parity. This runs the same five documents through both readers in a real
// terminal and records the phases a person notices: startup to first page,
// key-to-cursor latency, a whole refresh, the idle cost of a live page, and
// the resident memory and descriptors left behind. tmux is the only channel;
// neither runtime's internals are read.
//
// The budgets are ratios with an allowance for scheduler noise plus absolute
// ceilings a local action should never cross. They are smoke budgets, not the
// full performance qualification: extraction and ordering phases, privileged
// scan counts, protocol command counts, frame queries and handle lifecycles
// are counted by the snapshot log, protocol-trace and ARIA/role gates where
// the wire is observable. A failure reports every phase for both runtimes,
// including the live-pulse and refresh counts from the diagnostic log, so a
// slow number can be read as work rather than guessed at.
//
// TAWB_PERF_ONLY=large narrows the corpus while calibrating a budget, and
// TAWB_PERF_REVERSE=1 runs the runtimes in the opposite order so a budget
// that only passes because of which profile ran first is visible.

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

// What a local keystroke may cost before it is visibly slow, and how much
// slower than the JavaScript reference the native reader may be. The slack is
// for one scheduler quantum and tmux's own capture, not for a second pass.
const KEY_CEILING_MS = 400;
const REFRESH_CEILING_MS = 15000;
const STARTUP_CEILING_MS = 90000;
const LIVE_CPU_CEILING_MS = 45000;

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
  const totals = { extractMs: 0, orderMs: 0, snapshotMs: 0 };
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => name.includes('.tawb.'));
  } catch {
    return { counts, totals };
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
          totals.extractMs += Number(record.extractMs) || 0;
          totals.orderMs += Number(record.orderMs) || 0;
          totals.snapshotMs += Number(record.ms) || 0;
        }
      } catch {
        // A record cut short by shutdown is not a count.
      }
    }
  }
  return { counts, totals };
}

async function measure(runtime, kind, root, server) {
  const name = `${runtime.name}-perf-${kind}`.toLowerCase();
  const profile = path.join(root, name, 'profile');
  const logDirectory = path.join(root, name, 'log');
  const reader = new ReaderTty({
    session: `tawb-perf-${name}-${process.pid}`.toLowerCase(),
    command: runtime.command,
    args: [...runtime.args, '--browser', 'firefox', '--profile', profile,
      '--log', '--log-dir', logDirectory,
      '--no-alt-screen', `${server.origin}/${kind}`],
    env: environment(root, name),
  });
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
    // of the measured keys have asked for a refresh.
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
    reader.send('L');
    assert.ok(await waitForStatusWhere(reader, /Live updates on/, 5000),
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
    return {
      kind,
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
      snapshotExtractMs: logs.totals.extractMs,
      snapshotOrderMs: logs.totals.orderMs,
      profile,
    };
  } finally {
    reader.stop();
    killProfile(profile);
    await waitForProfileToDrain(profile, 15000);
  }
}

function line(result) {
  const events = Object.entries(result.logCounts)
    .filter(([event]) => ['live.pulse', 'live.refresh', 'snapshot', 'live.tick.error',
      'navigate', 'activate'].includes(event))
    .map(([event, count]) => `${event}=${count}`).join(',');
  return `${result.kind} ${result.runtime}: startup ${result.startupMs}ms, `
    + `key ${result.keyMs}ms, refresh ${result.refreshMs}ms, `
    + `idle cpu ${result.idleCpuMs}ms/${4000}ms (first ${result.startupIdleCpuMs}ms/2000ms) `
    + `(reader ${result.idleReaderMs}, browser ${result.idleBrowserMs}), `
    + `${result.rssMb}MB, ${result.fds} descriptors, `
    + `extract ${result.snapshotExtractMs}ms, order ${result.snapshotOrderMs}ms`
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
      for (const kind of selected) {
        results[kind] = [];
        for (const runtime of order) {
          results[kind].push(await measure(runtime, kind, root, server));
        }
      }
      for (const kind of Object.keys(results)) {
        for (const result of results[kind]) t.diagnostic(line(result));
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
