'use strict';

// Our accessibility tree, held against the web platform's own tests.
//
//   npm run wpt                     # accessible names and roles, Chromium
//   npm run wpt -- --browser firefox
//   npm run wpt -- --native --browser firefox   # read with the native extraction
//   npm run test:wai-aria           # WAI-ARIA role tests, fail on mismatches
//   npm run wpt -- --filter labelledby
//   npm run wpt -- --verbose        # every case, not just the failures
//
// web-platform-tests is the conformance suite the browser engines are held
// to, and two of its directories are written in a shape we can use directly:
// accname/ and wai-aria/role/ mark the element under test in the markup
// itself —
//
//   <input type="button" value="button label"
//          data-expectedlabel="button label" data-testname="html: input[type=button]">
//
// so the expected answer travels with the page. That is the whole reason this
// is possible: the usual route to those expectations is a WebDriver call that
// returns the *browser's* computed label, which would tell us nothing about
// ours. Reading the attributes instead means the same pages judge whichever
// tree we point at them.
//
// What this does not do is run WPT proper. There is no testharness here, no
// reftests, no js-driven cases — those pages are reported as producing no
// cases rather than as failures. It is the name-and-role slice of the suite,
// which is the slice ax_own.js is an implementation of.
//
// `--native` judges the native Crystal extraction instead of ax_own.js. The
// pages are handed to one conformance call that launches a single browser and
// runs each page's own collect script in the document the native extraction
// read, so an axIndex still names the same element on both sides.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver.js'));
const { extractAxItems } = require(path.join(__dirname, '..', 'src', 'ax_own.js'));
const { processesUsing } = require(path.join(__dirname, '..', 'src', 'proc.js'));

const ROOT = path.join(__dirname, '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');

const RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt/master';
const API = 'https://api.github.com/repos/web-platform-tests/wpt/contents';
// The directories whose expectations are written into the markup.
const SUITES = {
  accname: ['accname/name', 'accname/name/shadowdom'],
  'wai-aria': ['wai-aria/role'],
};
const CACHE = path.join(os.tmpdir(), 'tweb-wpt-cache');

function parseArgs(argv) {
  const options = {
    engine: 'chromium', filter: null, suite: 'all', verbose: false,
    refresh: false, failOnMismatch: false, native: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browser') { options.engine = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--browser=')) options.engine = arg.slice('--browser='.length);
    else if (arg === '--filter') { options.filter = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--filter=')) options.filter = arg.slice('--filter='.length);
    else if (arg === '--suite') { options.suite = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--suite=')) options.suite = arg.slice('--suite='.length);
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '--fail-on-mismatch') options.failOnMismatch = true;
    else if (arg === '--native') options.native = true;
  }
  if (options.suite !== 'all' && !SUITES[options.suite]) {
    throw new Error(`Unknown WPT suite ${JSON.stringify(options.suite)}; use all, accname, or wai-aria`);
  }
  return options;
}

function selectedSuites(name) {
  return name === 'all' ? Object.values(SUITES).flat() : SUITES[name];
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tweb-wpt' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// The suite is fetched once and kept, because it is somebody else's tree and
// vendoring a copy of it into this one would go stale silently.
async function ensureSuite(refresh, suites) {
  const pages = [];
  for (const suite of suites) {
    const dir = path.join(CACHE, suite);
    fs.mkdirSync(dir, { recursive: true });
    const index = path.join(dir, '.index.json');
    let listing;
    if (!refresh && fs.existsSync(index)) {
      listing = JSON.parse(fs.readFileSync(index, 'utf8'));
    } else {
      const raw = JSON.parse(await fetchText(`${API}/${suite}`));
      listing = raw.filter((e) => e.type === 'file' && e.name.endsWith('.html')).map((e) => e.name);
      fs.writeFileSync(index, JSON.stringify(listing));
    }
    for (const name of listing) {
      const file = path.join(dir, name);
      if (refresh || !fs.existsSync(file)) {
        process.stderr.write(`fetching ${suite}/${name}\n`);
        fs.writeFileSync(file, await fetchText(`${RAW}/${suite}/${name}`));
      }
      pages.push({ suite, name, file });
    }
  }
  return pages;
}

// The expectations the markup carries, paired with what our tree said about
// the same element. Two round trips rather than one: extractAxItems leaves the
// nodes it registered on the window, so the second call can look an element up
// in that list by identity rather than by guessing at role and name.
const COLLECT = () => {
  const nodes = window[Symbol.for('tweb.ax')] || [];
  const out = [];
  for (const el of document.querySelectorAll('[data-expectedlabel],[data-expectedrole]')) {
    out.push({
      testname: el.getAttribute('data-testname') || el.tagName.toLowerCase(),
      expectedLabel: el.getAttribute('data-expectedlabel'),
      expectedRole: el.getAttribute('data-expectedrole'),
      index: nodes.indexOf(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
    });
  }
  return out;
};

// Only our own tree can be judged this way. Playwright's carries no node
// references, so there is no way to ask it what it made of *this* element —
// which is why ax_own.js registers the nodes it walks in the first place.
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const isComparableExpectation = (value) => value != null
  && String(value).toLowerCase() !== 'spec_ambiguous_log_value';

function portFrom(profile) {
  for (const name of ['tawb-endpoint.json', '.tawb-devtools-port', 'DevToolsActivePort']) {
    const file = path.join(profile, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8').trim();
    if (name === 'DevToolsActivePort') return Number(text.split('\n')[0]);
    try {
      return Number(JSON.parse(text).port);
    } catch {
      return Number(text);
    }
  }
  throw new Error(`no endpoint record under ${profile}`);
}

function killProfile(profile) {
  for (const pid of processesUsing(profile)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// One conformance call carries every page, so the native side launches one
// browser for the whole suite rather than one per file. It also means the
// page marks its own nodes in the same document the native extraction read,
// which is what makes an axIndex comparable at all.
function callNative(operation, payload, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, ['--conformance', operation], {
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${operation} did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      let response;
      try {
        response = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`${operation} returned no JSON: ${stderr}`));
        return;
      }
      if (status !== 0 || !response.ok) {
        reject(new Error(response.error || stderr || `${operation} failed`));
        return;
      }
      resolve(response.value);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

// The native extraction has to answer in the same browser that ran COLLECT,
// so the pages are handed to it in one batch against a kept browser of its
// own. That browser is launched by the native reader, exactly as the view
// differentials launch one.
async function nativeObservations(options, selected, urls) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tawb-wpt-native-'));
  const profile = path.join(root, 'profile');
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    TAWB_A11Y_BUS: process.env.TAWB_A11Y_BUS || 'private',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  try {
    const launched = await run(BINARY, [
      '--dump', '--keep-browser', '--browser', options.engine,
      '--profile', profile, urls[0],
    ], { cwd: ROOT, env });
    if (launched.status !== 0) {
      throw new Error(`the native browser did not start: ${launched.stderr}`);
    }
    const endpoint = options.engine === 'firefox'
      ? '' : `http://127.0.0.1:${portFrom(profile)}`;
    const answers = await callNative('aria.scan', {
      engine: options.engine, endpoint, profile, urls, collect: COLLECT.toString(),
    }, 1_800_000, env);
    return selected.map((entry, index) => ({
      suite: entry.suite,
      name: entry.name,
      items: answers[index]?.items || [],
      cases: answers[index]?.cases || [],
    }));
  } finally {
    killProfile(profile);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function judge(observations, totals, unreached, failures) {
  for (const entry of observations) {
    totals.files += 1;
    const { items, cases } = entry;
    if (!cases.length) { totals.empty += 1; continue; }

    const byIndex = new Map();
    for (const item of items) {
      if (typeof item.axIndex === 'number') byIndex.set(item.axIndex, item);
    }

    for (const c of cases) {
      const compareLabel = isComparableExpectation(c.expectedLabel);
      const compareRole = isComparableExpectation(c.expectedRole);
      // WPT uses this sentinel in tentative tests where the specification
      // deliberately has no expected answer. It asks implementations to log
      // their result; treating that instruction as a literal role invents a
      // conformance failure.
      if (!compareLabel && !compareRole) continue;
      const item = c.index >= 0 ? byIndex.get(c.index) : undefined;
      if (!item) {
        totals.unreached += 1;
        const key = c.role ? `${c.tag}[role=${c.role}]` : c.tag;
        if (!unreached.has(entry.suite)) unreached.set(entry.suite, new Map());
        const shapes = unreached.get(entry.suite);
        shapes.set(key, (shapes.get(key) || 0) + 1);
        continue;
      }
      if (compareLabel) {
        const ok = norm(item.name) === norm(c.expectedLabel);
        totals.label[ok ? 0 : 1] += 1;
        if (!ok) {
          failures.push(`  label  ${entry.name}  ${c.testname}\n`
            + `           want ${JSON.stringify(norm(c.expectedLabel))}  got ${JSON.stringify(norm(item.name))}`);
        }
      }
      if (compareRole) {
        const want = norm(c.expectedRole).toLowerCase();
        const ok = norm(item.role).toLowerCase() === want;
        totals.role[ok ? 0 : 1] += 1;
        if (!ok) {
          failures.push(`  role   ${entry.name}  ${c.testname}\n`
            + `           want ${JSON.stringify(want)}  got ${JSON.stringify(norm(item.role).toLowerCase())}`);
        }
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pages = await ensureSuite(options.refresh, selectedSuites(options.suite));
  const selected = pages.filter((entry) => !options.filter
    || `${entry.suite}/${entry.name}`.includes(options.filter));

  // Served rather than opened as files: a file:// document has an opaque
  // origin and its shadow and frame behaviour differs, and several of these
  // pages are about exactly that.
  const root = CACHE;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const totals = { label: [0, 0], role: [0, 0], unreached: 0, files: 0, empty: 0 };
  // What our tree said nothing at all about, by the shape of the element, so
  // that "no item" is a lead rather than a number.
  const unreached = new Map();
  const failures = [];

  try {
    let observations;
    if (options.native) {
      if (!fs.existsSync(BINARY)) {
        throw new Error(`${BINARY} is absent; build the native reader or set TAWB_CRYSTAL_BIN`);
      }
      observations = await nativeObservations(
        options, selected, selected.map((entry) => `${base}${entry.suite}/${entry.name}`),
      );
    } else {
      const driver = await openDriver({ engine: options.engine, log: () => {} });
      try {
        const page = driver.context.pages()[0] || await driver.context.newPage();
        observations = [];
        for (const entry of selected) {
          const url = `${base}${entry.suite}/${entry.name}`;
          await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await new Promise((r) => setTimeout(r, 120));
          observations.push({
            suite: entry.suite,
            name: entry.name,
            items: await page.evaluate(extractAxItems, {}).catch(() => []),
            cases: await page.evaluate(COLLECT).catch(() => []),
          });
        }
      } finally {
        await driver.close().catch(() => {});
      }
    }
    judge(observations, totals, unreached, failures);
  } finally {
    server.close();
  }

  const line = (what, [pass, fail]) => {
    const total = pass + fail;
    const pct = total ? ((pass / total) * 100).toFixed(1) : '—';
    console.log(`  ${what.padEnd(6)} ${String(pass).padStart(4)}/${String(total).padEnd(4)}  ${pct}%`);
  };
  if (failures.length && options.verbose) console.log(failures.join('\n'));
  else if (failures.length) console.log(failures.slice(0, 40).join('\n')
    + (failures.length > 40 ? `\n  … and ${failures.length - 40} more (--verbose for all)` : ''));
  const implementation = options.native ? `native ${options.engine}` : options.engine;
  console.log(`\n${implementation}, ${totals.files} files (${totals.empty} with no inline expectations)`);
  line('labels', totals.label);
  line('roles', totals.role);
  // An element the test marked and our tree said nothing about is a gap, not a
  // note. Some gaps are structural and known: the tree speaks through a
  // container rather than for it, so a marked div[role=group] has no item of
  // its own until structural roles are emitted, and content the walk treats as
  // hidden is deliberately absent. Those are recorded with a reason in
  // tools/wpt-unreached.json and pinned by count, so this fails on a shape we
  // have never accounted for and on any regression inside one we have, while
  // still letting the list shrink as the gaps close.
  const allowance = readAllowance();
  const unexpected = [];
  let known = 0;
  for (const [suite, shapes] of unreached) {
    const allowedShapes = allowance[suite] || {};
    for (const [shape, count] of shapes) {
      const allowed = allowedShapes[shape] || 0;
      if (allowed >= count) { known += count; continue; }
      unexpected.push({ suite, shape, count, allowed });
    }
  }
  console.log(`  ${String(totals.unreached).padStart(4)} elements our tree emitted no item for:`
    + ` ${known} known, ${unexpected.length ? `${unexpected.reduce((n, u) => n + (u.count - u.allowed), 0)} unexpected` : 'none unexpected'}`);
  for (const [suite, shapes] of unreached) {
    const worst = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    for (const [what, count] of worst) {
      const allowed = (allowance[suite] || {})[what] || 0;
      const mark = allowed >= count ? 'known' : 'UNEXPECTED';
      console.log(`         ${String(count).padStart(4)}  ${suite}/${what}  ${mark}`);
    }
  }
  if (options.failOnMismatch) {
    if (totals.label[1] || totals.role[1] || unexpected.length) process.exitCode = 1;
    if (unexpected.length) {
      console.log('\nunreached elements with no entry in tools/wpt-unreached.json:');
      for (const { suite, shape, count, allowed } of unexpected) {
        console.log(`  ${suite}/${shape}: ${count} (allowed ${allowed})`);
      }
    }
  }
}

// What the gate already knows about, per suite and element shape, with the
// reason it is still there. See the report above.
function readAllowance() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'wpt-unreached.json'), 'utf8'));
  } catch {
    return {};
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { parseArgs, selectedSuites, isComparableExpectation };
