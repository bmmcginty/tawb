'use strict';

// The browser, reduced to what a reader actually needs from it.
//
// Everything above this file talks in pages and frames, and today every one
// of those calls lands on a Playwright object. That is fine — Playwright's
// page/frame/handle shape is a reasonable contract in its own right, and the
// subset used here is small: url, goto, evaluate, evaluateHandle, frames,
// mainFrame, waitForFunction, waitForLoadState, $$, contentFrame, dispose.
// A second engine can satisfy that shape rather than forcing a rewrite of
// everything that reads pages.
//
// What cannot be duck-typed is the handful of operations where the engines
// genuinely differ, and those are the reason this file exists:
//
//   open()            getting hold of a browser at all. Chromium is attached
//                     to over the DevTools protocol; Firefox speaks
//                     WebDriver BiDi and nothing else, since Mozilla removed
//                     CDP.
//   targetIdFor()     a tab's identity as the browser knows it, which is how
//                     two sessions avoid reading the same tab. CDP calls it a
//                     target; BiDi calls it a browsing context.
//   axSnapshot()      the accessibility tree as YAML. Playwright computes
//                     this with an injected script of its own, so the
//                     Chromium driver hands the job to Playwright and the
//                     Firefox driver brings its own — deliberately, so that
//                     the working Chromium path is not disturbed by a second
//                     implementation of the hardest part of this program.
//   elementByRole()   locating an element by role and accessible name, which
//                     is how an AX-view line is activated. Same split: the
//                     Chromium driver asks Playwright, and whoever computes
//                     the tree must also resolve against it.
//
// A driver is a plain object, not a class hierarchy. It holds the browser it
// opened and answers those four questions.

const { openChromium } = require('./driver_chromium');
const { openFirefox } = require('./driver_firefox');

const ENGINES = {
  chromium: openChromium,
  chrome: openChromium,
  firefox: openFirefox,
};

const DEFAULT_ENGINE = 'chromium';

function engineNames() {
  return Object.keys(ENGINES);
}

// `engine` names which browser to drive; everything else is passed through to
// the driver, which knows what it needs.
async function openDriver(options = {}) {
  const engine = options.engine || DEFAULT_ENGINE;
  const open = ENGINES[engine];
  if (!open) {
    throw new Error(`Unknown browser "${engine}". Known: ${engineNames().join(', ')}.`);
  }
  return open(options);
}

module.exports = { openDriver, engineNames, DEFAULT_ENGINE };
