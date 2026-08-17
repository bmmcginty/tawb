'use strict';

// Reads one page in both browsers and reports where they disagree.
//
//   npm run compare -- https://example.com
//   npm run compare -- --view html https://example.com
//   npm run compare -- --lines https://example.com
//
// The point is not that the two agree line for line — they will not, and
// where they differ is the interesting part. What this answers is the
// question you cannot answer by using one browser at a time: is Firefox
// seeing the same page, is it seeing it as fast, and is it announcing itself.

const path = require('path');
const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver.js'));
const { snapshotFrameTree } = require(path.join(__dirname, '..', 'src', 'frames.js'));
const { layoutLines } = require(path.join(__dirname, '..', 'src', 'layout.js'));

const ENGINES = ['chromium', 'firefox'];
const WIDTH = 78;

function parseArgs(argv) {
  const options = { url: null, views: null, showLines: false, engines: ENGINES };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--view') { options.views = [argv[i + 1]]; i += 1; }
    else if (arg.startsWith('--view=')) { options.views = [arg.slice('--view='.length)]; }
    else if (arg === '--lines') options.showLines = true;
    else if (arg === '--only') { options.engines = [argv[i + 1]]; i += 1; }
    else if (!arg.startsWith('-') && !options.url) options.url = arg;
  }
  return options;
}

async function readWith(engine, url, views) {
  const started = Date.now();
  const driver = await openDriver({ engine, log: () => {} });
  const out = { engine, views: {}, webdriver: null, startupMs: Date.now() - started };

  try {
    const page = driver.context.pages()[0] || await driver.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Modern pages arrive in pieces; give scripts a moment before judging.
    await new Promise((r) => setTimeout(r, 4000));

    out.webdriver = await page.evaluate(() => navigator.webdriver);
    out.url = page.url();

    for (const view of views) {
      if (view === 'ax' && driver.capabilities?.ax === false) {
        out.views[view] = { unavailable: 'not implemented for this engine' };
        continue;
      }
      const t0 = Date.now();
      try {
        const blocks = await snapshotFrameTree(page, view, { driver });
        out.views[view] = {
          ms: Date.now() - t0,
          blocks: blocks.length,
          rows: layoutLines(blocks, WIDTH).length,
          text: blocks.map((b) => b.text),
        };
      } catch (err) {
        out.views[view] = { error: String(err.message || err).split('\n')[0] };
      }
    }
  } finally {
    await driver.close();
  }
  return out;
}

// The first place two lists of lines part company, which is far more use than
// a count of differences.
function firstDifference(a = [], b = []) {
  const limit = Math.max(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    if (a[i] !== b[i]) return { at: i, left: a[i], right: b[i] };
  }
  return null;
}

function summarise(results, views, showLines) {
  const [left, right] = results;
  const pad = (s, n) => String(s).padEnd(n);

  console.log('');
  console.log(`  ${pad('', 14)}${results.map((r) => pad(r.engine, 30)).join('')}`);
  console.log(`  ${pad('startup', 14)}${results.map((r) => pad(`${(r.startupMs / 1000).toFixed(1)}s`, 30)).join('')}`);
  console.log(`  ${pad('webdriver', 14)}${results.map((r) => pad(String(r.webdriver), 30)).join('')}`);
  for (const r of results) {
    if (r.webdriver !== false) {
      console.log(`  !! ${r.engine} is announcing itself as automated — it will fail bot checks`);
    }
  }

  for (const view of views) {
    const cells = results.map((r) => {
      const v = r.views[view] || {};
      if (v.unavailable) return 'not available';
      if (v.error) return `error: ${v.error.slice(0, 40)}`;
      return `${v.blocks} blocks, ${v.rows} rows, ${v.ms}ms`;
    });
    console.log('');
    console.log(`  ${pad(view, 14)}${cells.map((c) => pad(c, 30)).join('')}`);

    if (!left || !right) continue;
    const a = left.views[view]?.text;
    const b = right.views[view]?.text;
    if (!a || !b) continue;

    const diff = firstDifference(a, b);
    if (!diff) {
      console.log(`  ${pad('', 14)}identical, all ${a.length} lines`);
      continue;
    }
    const shared = diff.at;
    console.log(`  ${pad('', 14)}agree for ${shared} line${shared === 1 ? '' : 's'}, then part:`);
    console.log(`  ${pad('', 14)}${left.engine}: ${JSON.stringify((diff.left || '(end)').slice(0, 60))}`);
    console.log(`  ${pad('', 14)}${right.engine}: ${JSON.stringify((diff.right || '(end)').slice(0, 60))}`);

    if (showLines) {
      const limit = Math.max(a.length, b.length);
      console.log('');
      for (let i = 0; i < limit; i += 1) {
        const same = a[i] === b[i];
        console.log(`   ${same ? ' ' : '~'} ${pad((a[i] ?? '').slice(0, 60), 62)}${(b[i] ?? '').slice(0, 60)}`);
      }
    }
  }
  console.log('');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url) {
    console.error('Usage: npm run compare -- [--view <name>] [--lines] <url>');
    process.exit(1);
  }
  const views = options.views || ['ax', 'render', 'html', 'source'];

  const results = [];
  for (const engine of options.engines) {
    process.stderr.write(`reading with ${engine}…\n`);
    try {
      results.push(await readWith(engine, options.url, views));
    } catch (err) {
      results.push({ engine, views: {}, webdriver: null, startupMs: 0, failed: String(err.message || err) });
      console.error(`  ${engine} failed: ${String(err.message || err).split('\n')[0]}`);
    }
  }

  summarise(results.filter((r) => !r.failed), views, options.showLines);
}

main().catch((err) => { console.error(err); process.exit(1); });
