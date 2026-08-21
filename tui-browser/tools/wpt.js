'use strict';

// Our accessibility tree, held against the web platform's own tests.
//
//   npm run wpt                     # accessible names and roles, Chromium
//   npm run wpt -- --browser firefox
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver.js'));
const { extractAxItems } = require(path.join(__dirname, '..', 'src', 'ax_own.js'));

const RAW = 'https://raw.githubusercontent.com/web-platform-tests/wpt/master';
const API = 'https://api.github.com/repos/web-platform-tests/wpt/contents';
// The directories whose expectations are written into the markup.
const SUITES = ['accname/name', 'accname/name/shadowdom', 'wai-aria/role'];
const CACHE = path.join(os.tmpdir(), 'tweb-wpt-cache');

function parseArgs(argv) {
  const options = { engine: 'chromium', filter: null, verbose: false, refresh: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--browser') { options.engine = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--browser=')) options.engine = arg.slice('--browser='.length);
    else if (arg === '--filter') { options.filter = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--filter=')) options.filter = arg.slice('--filter='.length);
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--refresh') options.refresh = true;
  }
  return options;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'tweb-wpt' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// The suite is fetched once and kept, because it is somebody else's tree and
// vendoring a copy of it into this one would go stale silently.
async function ensureSuite(refresh) {
  const pages = [];
  for (const suite of SUITES) {
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pages = await ensureSuite(options.refresh);

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

  const driver = await openDriver({ engine: options.engine, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  if (driver.ax === 'playwright') {
    throw new Error('This judges ax_own.js, which only the engines using it have. '
      + 'Use --browser chromium or --browser firefox.');
  }

  const totals = { label: [0, 0], role: [0, 0], unreached: 0, files: 0, empty: 0 };
  // What our tree said nothing at all about, by the shape of the element, so
  // that "no item" is a lead rather than a number.
  const unreached = new Map();
  const failures = [];

  try {
    for (const entry of pages) {
      if (options.filter && !`${entry.suite}/${entry.name}`.includes(options.filter)) continue;
      totals.files += 1;
      const url = `${base}${entry.suite}/${entry.name}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));

      const items = await page.evaluate(extractAxItems, {}).catch(() => []);
      const cases = await page.evaluate(COLLECT).catch(() => []);
      if (!cases.length) { totals.empty += 1; continue; }

      const byIndex = new Map();
      for (const item of items) {
        if (typeof item.axIndex === 'number') byIndex.set(item.axIndex, item);
      }

      for (const c of cases) {
        const item = c.index >= 0 ? byIndex.get(c.index) : undefined;
        if (!item) {
          totals.unreached += 1;
          const key = c.role ? `${c.tag}[role=${c.role}]` : c.tag;
          unreached.set(key, (unreached.get(key) || 0) + 1);
          continue;
        }
        if (c.expectedLabel != null) {
          const ok = norm(item.name) === norm(c.expectedLabel);
          totals.label[ok ? 0 : 1] += 1;
          if (!ok) {
            failures.push(`  label  ${entry.name}  ${c.testname}\n`
              + `           want ${JSON.stringify(norm(c.expectedLabel))}  got ${JSON.stringify(norm(item.name))}`);
          }
        }
        if (c.expectedRole != null) {
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
  } finally {
    await driver.close().catch(() => {});
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
  console.log(`\n${options.engine}, ${totals.files} files (${totals.empty} with no inline expectations)`);
  line('labels', totals.label);
  line('roles', totals.role);
  // Not all of these are wrong. Our tree speaks through a container rather
  // than for it, so a marked div[role=group] never becomes an item of its own;
  // and content the walk treats as hidden is deliberately absent. The
  // breakdown is here to tell those apart from a control we simply lost.
  console.log(`  ${String(totals.unreached).padStart(4)} elements our tree emitted no item for, by shape:`);
  const worst = [...unreached.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [what, count] of worst) console.log(`         ${String(count).padStart(4)}  ${what}`);
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
