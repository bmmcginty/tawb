'use strict';

// The four views of one page, against a real browser, differenced between the
// JavaScript extractors and the Crystal port.
//
// The four are four completely different descriptions of the same document —
// what it means, what it visibly says, what it is made of, and the semantics
// beside the markup that produced them — and what each says is the whole of
// what the reader has to read. Three of the four are page-side walks carried
// over as assets, so the comparison is what came back from running them: the
// text of every line, the role it was given, and the element it came from.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir, removeTempDir } = require('../tmpdir');
const { processesUsing } = require('../../src/proc');
const { callAsync } = require('../crystal_impl');
const { openDriver } = require('../../src/driver');
const { Core } = require('../../src/core');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

// Something for each view to disagree about: a heading, prose split by inline
// styling, a link, a button, a field with a value, an image with no text of
// its own, and a table.
const PAGE = `<!doctype html><html><head><title>Four views</title></head><body>
  <h1>Views heading</h1>
  <p>Prose that is <em>split</em> by styling.</p>
  <a href="https://example.test/docs">Docs link</a>
  <button type="button">Save it</button>
  <input type="text" aria-label="Your name" value="Ada">
  <img src="logo.png" alt="">
  <table><tr><th>Name</th><td>Ada</td></tr></table>
</body></html>`;

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

// Only what means the same thing in both runtimes: the index is the view's own
// numbering, while the frame is a protocol handle and is reported only as
// whether there is one.
function kept(block) {
  const item = block.item || {};
  const index = item.renderIndex !== undefined ? item.renderIndex
    : item.domIndex !== undefined ? item.domIndex
      : item.axIndex !== undefined ? item.axIndex : null;
  return {
    text: block.text,
    role: item.role === undefined ? null : item.role,
    name: item.name === undefined ? null : item.name,
    index: index === undefined ? null : index,
    framed: !!item.frame,
  };
}

// A browser of its own, because this is about what an extraction says of a
// document rather than about one browser answering two clients: Firefox's one
// protocol session belongs to whichever reader holds it, and sharing it here
// would be testing the sharing.
async function javascriptBlocks(engine, profile, url, source) {
  const driver = await openDriver({ engine, profile, log: () => {} });
  const page = driver.context.pages()[0] || await driver.context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const core = new Core({ driver, page, source, sources: [source] });
    const blocks = await core.rescan({ page });
    return blocks.map(kept);
  } finally {
    await driver.close().catch(() => {});
  }
}

for (const engine of ['chromium', 'firefox']) {
  for (const source of ['ax', 'render', 'inspect', 'source']) {
    test(`the ${source} view of a page reads the same in both runtimes through ${engine}`,
      { skip }, async () => {
        const root = tempDir(`tawb-views-${engine}-${source}-`);
        const native = path.join(root, 'native');
        const other = path.join(root, 'javascript');
        const page = path.join(root, 'page.html');
        fs.writeFileSync(page, PAGE);
        const url = `file://${page}`;
        const env = {
          ...process.env,
          HOME: path.join(root, 'home'),
          XDG_CONFIG_HOME: path.join(root, 'config'),
          XDG_DATA_HOME: path.join(root, 'data'),
          XDG_CACHE_HOME: path.join(root, 'cache'),
        };
        fs.mkdirSync(env.HOME, { recursive: true });
        try {
          // The native side's browser is launched by the native reader, and
          // kept, so the extraction can be asked of it afterwards.
          const launched = await run(BINARY, [
            '--dump', '--keep-browser', '--browser', engine, '--profile', native, url,
          ], { cwd: ROOT, env });
          assert.equal(launched.status, 0, launched.stderr);
          // Chromium is reached at its own endpoint. Firefox allows one
          // protocol session per browser, so a second reader reaches a kept
          // one through the broker holding it — which is what the native
          // reader does too, and so is named by its profile rather than by
          // an address.
          const endpoint = engine === 'firefox'
            ? '' : `http://127.0.0.1:${portFrom(native)}`;

          const crystal = await callAsync('core.view_blocks',
            { endpoint, engine, url, source, profile: native }, { timeoutMs: 120000 });
          const javascript = await javascriptBlocks(engine, other, url, source);

          assert.deepEqual(crystal, javascript,
            `the ${source} view differs between the runtimes`);
          assert.ok(crystal.length > 0, 'and it read something');
        } finally {
          killProfile(native);
          killProfile(other);
          removeTempDir(root);
        }
      });
  }
}
