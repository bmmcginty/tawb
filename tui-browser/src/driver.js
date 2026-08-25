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
//   axItems()         the accessibility tree, flattened into reading order.
//                     Both engines now use ax_own.js, computed in the page.
//                     Playwright's own tree stays reachable as a separate
//                     engine name, because it is what ours was validated
//                     against. Items, not text: inventing a serialisation
//                     just to parse it back would be the only reason to.
//   axElementHandle() locating the element an AX line came from, which is how
//                     the line is activated. Whoever computed the tree
//                     resolves against it — directly, for an implementation
//                     that kept a reference to the node, and by role and name
//                     for Playwright's, whose items carry none.
//   attachAuth()      answering the password prompt a 401 raises, which is
//                     drawn by browser chrome and so cannot be read or
//                     reached from the page. Chromium hands it over through
//                     Fetch and pauses every request to do it; Firefox has an
//                     auth-only intercept and pauses nothing. Both are
//                     answered with a username and password rather than a
//                     header, so the engine performs basic, digest and
//                     whatever else it knows. The handler is told the
//                     challenge, the request it belongs to and the tab it was
//                     raised in.
//   armAuth()         one tab covered by the above. Chromium needs it per
//                     tab, since a browser can be shared with another reader;
//                     on Firefox it is already true and answers so.
//   realClick()       a click the browser treats as a person's, which only
//                     the protocol can produce: real input dispatched above
//                     content, so the events are trusted and carry user
//                     activation. Playwright's own click does it for
//                     Chromium; the Firefox driver performs the pointer
//                     actions itself, the same road its keyboard takes.
//
// A driver is a plain object, not a class hierarchy. It holds the browser it
// opened and answers those questions.

const { openChromium } = require('./driver_chromium');
const { openFirefox } = require('./driver_firefox');

const ENGINES = {
  chromium: openChromium,
  chrome: openChromium,
  firefox: openFirefox,
  // The same browser reading the page with Playwright's accessibility tree
  // instead of ours. Not a browser anyone should choose to read with — it
  // has to search the page by role and name to activate a line — but it is
  // the implementation ours was validated against, and keeping it selectable
  // is what lets `compare` go on judging a disagreement between the two.
  'chromium-playwright': (options) => openChromium({ ...options, ax: 'playwright' }),
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
