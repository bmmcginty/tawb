'use strict';

const { launchOwnBrowser, connectToBrowser, defaultProfileDir } = require('./browser');
const { parseAriaSnapshot } = require('./aria');

// Chromium, attached to over the DevTools protocol.
//
// This is the path that works and is not to be disturbed: it clears bot
// checks because the browser is an ordinary one that happens to be observed.
// The accessibility tree comes from Playwright, which computes it with an
// injected script of its own — good enough that there is no reason to
// replace it here just because another engine needs its own.

async function openChromium({
  connect = null, profile = null, keepBrowser = false, log = () => {},
} = {}) {
  let browser;
  let context;
  let child = null;
  let owned = false;
  let port = null;
  let rejoined = false;

  if (connect) {
    const connected = await connectToBrowser(connect);
    ({ browser, context } = connected);
    port = connected.port;
    rejoined = true;
  } else {
    const started = await launchOwnBrowser({ profileDir: profile || defaultProfileDir(), log });
    ({ browser, context } = started);
    child = started.child;
    owned = !!started.owned;
    port = started.port;
    rejoined = !!started.rejoined;
  }

  return {
    name: 'chromium',
    browser,
    context,
    child,
    owned,
    port,
    rejoined,

    // A tab's identity as the browser knows it — the only name for a tab that
    // means the same thing in another session's process.
    async targetIdFor(page) {
      try {
        const session = await context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        await session.detach().catch(() => {});
        return (targetInfo && targetInfo.targetId) || null;
      } catch {
        return null;
      }
    },

    // The accessibility tree, flattened into reading order. Playwright's own,
    // by design: it computes the tree with an injected script, we parse its
    // YAML, and neither half is worth replacing here just because another
    // engine needs an implementation of its own.
    async axItems(frame) {
      return parseAriaSnapshot(await frame.locator('body').ariaSnapshot());
    },

    // Every tab the browser has, across all its windows. Order is creation
    // order rather than the order they sit in the tab strip, which is the
    // only ordering the protocol offers.
    listTabs() {
      return context.pages().filter((page) => !page.isClosed());
    },

    // A tab opening is how target="_blank" arrives, and the reader wants to
    // follow it the way a sighted user's browser already has.
    onNewTab(handler) {
      context.on('page', handler);
    },

    async newTab() {
      return context.newPage();
    },

    // A click the browser treats as a person's.
    //
    // Everything else here activates through the DOM's own default action,
    // which is right for reading: it needs no viewport and reaches controls
    // that are off-screen. What it cannot produce is user activation — the
    // browser knows nobody touched anything — so a page that gates on a real
    // gesture (audio, fullscreen, the clipboard, a popup) refuses.
    //
    // Playwright's click is real input over the DevTools protocol, dispatched
    // above content, so the events are trusted and carry activation. It also
    // brings the element into view and refuses to click one that something
    // else is covering, which is exactly the honesty wanted here: a click
    // that lands on a modal instead of the button is worse than no click.
    async realClick(scope, handle, { timeoutMs = 5000 } = {}) {
      await handle.click({ timeout: timeoutMs });
    },

    // Whoever computed the tree resolves against it. Playwright's items carry
    // no element reference, so this goes back through role and name.
    async axElementHandle(scope, item) {
      return scope.getByRole(item.role, { name: item.name, exact: true }).first().elementHandle();
    },

    async close() {
      await browser.close().catch(() => {});
      // Only tear down a browser we started; one the user was already running
      // is theirs to keep. --keep-browser leaves even ours running, so the
      // next session rejoins it in 50ms instead of cold-starting in four
      // seconds.
      if (child && !keepBrowser) {
        try { child.kill(); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { openChromium };
