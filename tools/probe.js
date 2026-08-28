'use strict';

// What a page can tell about us.
//
//   npm run probe                       # against a page of your choosing
//   npm run probe -- --connect 46213    # against the tab a browser is on
//   npm run probe -- https://example.com
//
// Two kinds of question, and the second is the one that has actually caught
// us out. The first is the usual fingerprint an anti-bot script reads:
// automation flags, whether the DevTools Runtime domain is leaking, whether
// the tab admits to being in the background. The second is what *we* have
// left lying about inside the page — a walker that registers nodes, an
// observer that watches for changes and a shadow root hung off an element
// all leave traces, and a challenge frame is the one document where a
// stray global with our name on it is the whole ballgame.
//
// The debugging port is not 9222 unless you said so. tweb starts its own
// browser on a port of the moment; a --log run records it as `browser.spawn`
// or `browser.rejoin`.

const path = require('path');
const { openDriver } = require(path.join(__dirname, '..', 'src', 'driver.js'));
const { normaliseEndpoint } = require(path.join(__dirname, '..', 'src', 'browser.js'));
const { Core } = require(path.join(__dirname, '..', 'src', 'core.js'));

// Everything of ours a page could notice.
const OURS = () => {
  const suspicious = /^(__tweb|_+playwright|_+puppeteer|cdc_|__driver|__selenium|__webdriver|__nightmare)/i;
  const globals = Object.getOwnPropertyNames(window).filter((n) => suspicious.test(n));
  const onBody = document.body
    ? Object.getOwnPropertyNames(document.body).filter((n) => suspicious.test(n)) : [];
  // Anything of ours hung on an element anywhere, which is worse than a
  // global: it is a mark on the page's own objects.
  let marked = 0;
  for (const el of document.querySelectorAll('*')) {
    for (const name of Object.getOwnPropertyNames(el)) {
      if (suspicious.test(name)) { marked += 1; break; }
    }
  }
  return { globals, onBody, markedElements: marked };
};

// The ordinary fingerprint.
const SIGNALS = () => {
  let runtimeLeak = false;
  try {
    const err = new Error('probe');
    Object.defineProperty(err, 'stack', { get() { runtimeLeak = true; return ''; }, configurable: true });
    console.debug(err);
  } catch { /* console gone */ }

  let webgl = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl && info) {
      webgl = `${gl.getParameter(info.UNMASKED_VENDOR_WEBGL)} / ${gl.getParameter(info.UNMASKED_RENDERER_WEBGL)}`;
    }
  } catch { /* blocked */ }

  return {
    webdriver: navigator.webdriver,
    runtimeEnableLeak: runtimeLeak,
    // A challenge waits for a tab it believes a person is looking at.
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    // Emulated media pins these; a browser answers them for itself.
    hover: matchMedia('(hover: hover)').matches,
    pointerFine: matchMedia('(pointer: fine)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    plugins: navigator.plugins.length,
    languages: navigator.languages.join(','),
    hardwareConcurrency: navigator.hardwareConcurrency,
    // A window smaller than the screen it claims, or one with no chrome
    // around it, is a headless giveaway.
    window: `${window.innerWidth}x${window.innerHeight} in ${window.outerWidth}x${window.outerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    webgl,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

function parseArgs(argv) {
  const options = { url: null, engine: 'chromium', connect: null, settleMs: 3000, snapshot: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--connect') { options.connect = normaliseEndpoint(argv[i + 1] || ''); i += 1; }
    else if (arg.startsWith('--connect=')) options.connect = normaliseEndpoint(arg.slice('--connect='.length));
    else if (arg === '--browser') { options.engine = argv[i + 1]; i += 1; }
    else if (arg.startsWith('--browser=')) options.engine = arg.slice('--browser='.length);
    else if (arg === '--settle') { options.settleMs = Number(argv[i + 1]); i += 1; }
    else if (arg === '--no-read') options.snapshot = false;
    else if (!arg.startsWith('-') && !options.url) options.url = arg;
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const driver = await openDriver({ engine: options.engine, connect: options.connect, log: () => {} });

  try {
    const pages = driver.context.pages();
    let page = pages[0] || await driver.context.newPage();
    if (options.connect && pages.length > 1) {
      for (const candidate of pages) {
        const showing = await candidate.evaluate(() => document.visibilityState === 'visible').catch(() => false);
        if (showing) { page = candidate; break; }
      }
    }
    if (options.url) await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, options.settleMs));

    console.log(`page: ${page.url()}`);
    console.log('');
    console.log('signals a bot check reads');
    const signals = await page.evaluate(SIGNALS).catch((e) => ({ error: String(e.message) }));
    for (const [key, value] of Object.entries(signals)) {
      const flag = (key === 'webdriver' && value !== false)
        || (key === 'runtimeEnableLeak' && value === true)
        || (key === 'visibility' && value !== 'visible')
        || (key === 'plugins' && value === 0);
      console.log(`  ${flag ? '!!' : '  '} ${key.padEnd(20)} ${JSON.stringify(value)}`);
    }

    // Reading the page is what leaves traces, so look before and after.
    console.log('');
    console.log('what we have left in each document — before reading it');
    await report(page);
    if (options.snapshot) {
      const core = new Core({ driver, page, source: 'ax', sources: ['ax'] });
      // Exactly what the reader does, in the order it does it. Attaching the
      // live observer is part of reading a page and it is the part that
      // leaves the most behind, so a probe that only took a snapshot reported
      // a page far cleaner than the reader ever leaves it.
      await core.attachLive(page, () => {});
      await core.rescan();
      console.log('');
      console.log(`after reading it (${core.blocks.length} blocks)`);
      await report(page);
    }
  } finally {
    await driver.close().catch(() => {});
  }
}

async function report(page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(OURS).catch((e) => ({ error: String(e.message).slice(0, 50) }));
    const dirty = found.globals && (found.globals.length || found.onBody.length || found.markedElements);
    console.log(`  ${dirty ? '!!' : '  '} ${String(frame.url()).slice(0, 66).padEnd(68)}`
      + (found.error ? found.error : `globals=[${found.globals.join(' ')}] onBody=[${found.onBody.join(' ')}] markedElements=${found.markedElements}`));
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
