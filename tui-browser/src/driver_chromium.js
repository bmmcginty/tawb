'use strict';

const { launchOwnBrowser, connectToBrowser, defaultProfileDir } = require('./browser');

// Chromium, attached to over the DevTools protocol.
//
// This is the path that works and is not to be disturbed: it clears bot
// checks because the browser is an ordinary one that happens to be observed.
// The accessibility tree comes from Playwright, which computes it with an
// injected script of its own — good enough that there is no reason to
// replace it here just because another engine needs its own.

async function openChromium({ connect = null, profile = null, log = () => {} } = {}) {
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

    // The accessibility tree as YAML. Playwright's own, by design.
    async axSnapshot(frame) {
      return frame.locator('body').ariaSnapshot();
    },

    // Whoever computed the tree resolves against it.
    async elementByRole(scope, role, name) {
      return scope.getByRole(role, { name, exact: true }).first().elementHandle();
    },

    async close() {
      await browser.close().catch(() => {});
      // Only tear down a browser we started; one the user was already running
      // is theirs to keep.
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
      }
    },
  };
}

module.exports = { openChromium };
