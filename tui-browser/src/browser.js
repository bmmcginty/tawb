'use strict';

const { chromium } = require('playwright');

// Getting hold of a browser to read.
//
// Launching one through Playwright is not equivalent to using one. A
// Playwright-launched browser carries automation instrumentation — the
// --enable-automation family of flags, navigator.webdriver set to true — and
// sites treat it differently as a result. Measured against pastebin.com's
// Cloudflare challenge:
//
//   Playwright-launched, headless   challenge never clears
//   Playwright-launched, headed     challenge never clears
//   Chromium launched normally      clears in ~4s, earns cf_clearance
//
// Attaching to a browser that was started normally reports
// navigator.webdriver === false and behaves like what it is: an ordinary
// browser someone happens to be observing. That is also the honest position
// — we are not disguising anything, so nothing needs to be spoofed.

// Attaches to an already-running browser over the DevTools protocol. The
// browser must have been started with --remote-debugging-port.
async function connectToBrowser(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error(`No browser context available at ${endpoint}`);
  }
  return { browser, context: contexts[0], owned: false };
}

// Normalises the various things someone might reasonably pass: a port, a
// host:port, or a full URL.
function normaliseEndpoint(value) {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return `http://127.0.0.1:${text}`;
  if (/^https?:\/\//.test(text)) return text;
  return `http://${text}`;
}

module.exports = { connectToBrowser, normaliseEndpoint };
