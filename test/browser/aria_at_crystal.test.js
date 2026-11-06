'use strict';

// The adapted ARIA-AT toggle-button plan against both runtimes.
//
// test/browser/aria_at.test.js drives the JavaScript extraction and
// presentation against a real browser. That says nothing about the native
// accessibility tree, so the same page is read and operated here through both
// runtimes: the native side extracts with the Crystal core, renders the item
// with the Crystal presenter, operates it, and reads the document again; the
// JavaScript side does the same with its own modules. Both engines are run
// because the item each extraction produces comes from different browser
// accessibility trees.

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
const { renderLine } = require('../../src/aria');
const { blockV1 } = require('../parity/block-v1');

const ROOT = path.join(__dirname, '..', '..');
const BINARY = process.env.TAWB_CRYSTAL_BIN || path.join(ROOT, 'bin', 'tawb');
const enabled = process.env.TAWB_TEST_CRYSTAL_BROWSER === '1';
const skip = enabled ? false : 'TAWB_TEST_CRYSTAL_BROWSER is not 1';

// The same page as the JavaScript-only ARIA-AT adaptation.
const PAGE = `<!doctype html><meta charset="utf-8"><title>ARIA-AT toggle button</title>
<a id="before" href="#before">Navigate forwards from here</a>
<a tabindex="0" role="button" id="toggle" aria-pressed="false">Mute</a>
<a id="after" href="#after">Navigate backwards from here</a>
<script>
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-pressed', toggle.getAttribute('aria-pressed') !== 'true');
  });
</script>`;
const CONTROL = { name: 'Mute', role: 'button' };
const PROBE = "() => document.querySelector('#toggle').getAttribute('aria-pressed')";

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

async function javascriptAnswer(engine, profile, url) {
  const driver = await openDriver({ engine, profile, log: () => {} });
  try {
    const page = driver.context.pages()[0] || await driver.context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const seen = async () => {
      const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
      const blocks = await core.rescan({ page });
      return { core, block: blocks.find((candidate) => candidate.item?.name === CONTROL.name
        && candidate.item?.role === CONTROL.role) };
    };
    const before = await seen();
    assert.ok(before.block, 'the JavaScript extraction did not offer the toggle');
    const observed = (block) => ({
      item: blockV1({ item: block.item }).item,
      line: renderLine(block.item),
    });
    const activation = await before.core.activate(before.block.item, page);
    const after = await seen();
    assert.ok(after.block, 'the JavaScript extraction lost the toggle after activation');
    return {
      found: true,
      before: observed(before.block),
      activation,
      after: observed(after.block),
      probe: await page.evaluate((0, eval)(PROBE)),
    };
  } finally {
    await driver.close().catch(() => {});
  }
}

for (const engine of ['chromium', 'firefox']) {
  test(`ARIA-AT toggle extraction, announcement, and operation agree through ${engine}`,
    { skip }, async () => {
      const root = tempDir(`tawb-aria-at-${engine}-`);
      const native = path.join(root, 'native');
      const other = path.join(root, 'javascript');
      const fixture = path.join(root, 'toggle.html');
      fs.writeFileSync(fixture, PAGE);
      const url = `file://${fixture}`;
      const env = {
        ...process.env,
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
      };
      fs.mkdirSync(env.HOME, { recursive: true });
      try {
        // The native browser is launched by the native reader and kept, so
        // the extraction can be asked of it afterwards, exactly as the view
        // differentials ask it.
        const launched = await run(BINARY, [
          '--dump', '--keep-browser', '--browser', engine, '--profile', native, url,
        ], { cwd: ROOT, env });
        assert.equal(launched.status, 0, launched.stderr);
        const endpoint = engine === 'firefox'
          ? ''
          : `http://127.0.0.1:${portFrom(native)}`;
        const [crystal, javascript] = await Promise.all([
          callAsync('aria.scenario', {
            endpoint, engine, profile: native, url, ...CONTROL, probe: PROBE,
          }, { timeoutMs: 120000 }),
          javascriptAnswer(engine, other, url),
        ]);
        assert.deepEqual(crystal, javascript);
        assert.equal(crystal.found, true);

        // The product-independent ARIA-AT assertions: the role, name, and
        // pressed state are conveyed, and operating the control conveys the
        // changed state.
        assert.equal(crystal.before.item.role, 'button');
        assert.equal(crystal.before.item.name, 'Mute');
        assert.equal(crystal.before.item.pressed, false);
        assert.equal(crystal.before.line, '[*Mute, not pressed]');
        assert.equal(crystal.activation.how, 'default-action');
        assert.equal(crystal.activation.status, null);
        assert.equal(crystal.after.item.pressed, true);
        assert.equal(crystal.after.line, '[*Mute, pressed]');
        assert.equal(crystal.probe, 'true');
      } finally {
        killProfile(native);
        killProfile(other);
        removeTempDir(root);
      }
    });
}
