'use strict';

// The browser, reduced to what a reader actually needs from it.
//
// Everything above this file talks in pages and frames. That shape came from
// Playwright and outlived it: page/frame/handle is a reasonable contract in
// its own right, and the subset used here is small — url, goto, evaluate,
// evaluateHandle, frames, mainFrame, waitForFunction, waitForLoadState, $$,
// contentFrame, dispose. Both engines satisfy that shape themselves now
// (cdp_page.js and driver_firefox.js), which is what lets a second engine
// arrive without rewriting everything that reads pages.
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
//                     Both engines use ax_own.js, computed in the page.
//                     Items, not text: inventing a serialisation just to
//                     parse it back would be the only reason to.
//   axElementHandle() locating the element an AX line came from, which is how
//                     the line is activated. The tree kept a reference to the
//                     node, so the item says which element it came from and
//                     there is nothing to search the page for.
//   attachAuth()      answering the password prompt a 401 raises, which is
//                     drawn by browser chrome and so cannot be read or
//                     reached from the page. Chromium hands it over through
//                     Fetch and pauses every request to do it; Firefox has an
//                     auth-only intercept and pauses nothing. Both are
//                     answered with a username and password rather than a
//                     header, so the engine performs basic, digest and
//                     whatever else it knows. The handler is told the
//                     challenge, the request it belongs to and the tab it was
//                     raised in. A challenge still unanswered when the driver
//                     closes is cancelled, because the prompt became ours the
//                     moment the interception was armed: a browser that
//                     outlives the session would otherwise hold that tab
//                     mid-request with no dialog anyone could answer.
//   armAuth()         one tab covered by the above. Chromium needs it per
//                     tab, since a browser can be shared with another reader;
//                     on Firefox it is already true and answers so.
//   readLibrary()     the browser's own bookmarks, history and downloads,
//                     which is the sharpest difference of the lot. Neither
//                     protocol answers for them — both describe documents, and
//                     a record of where you have been is not one — so each
//                     engine is asked the way that engine can be asked.
//                     Chromium has pages of its own for all three, and CDP can
//                     attach to them: a background tab is opened on
//                     chrome://bookmarks, chrome://history or
//                     chrome://downloads, the interface the browser implements
//                     for that page is called through the binding the page's
//                     own module publishes, and the tab is closed. Firefox has no such page and no such
//                     protocol call; its answer comes from a privileged agent
//                     installed while the browser starts, which calls
//                     PlacesUtils and Downloads directly. Both return entries
//                     of one shape, described in library.js. The second
//                     argument is a page to ask through, which Firefox needs
//                     and Chromium ignores.
//   realClick()       a click the browser treats as a person's, which only
//                     the protocol can produce: real input dispatched above
//                     content, so the events are trusted and carry user
//                     activation. Both drivers perform the pointer actions
//                     themselves, the same road their keyboards take.
//
// A driver is a plain object, not a class hierarchy. It holds the browser it
// opened and answers those questions.

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
