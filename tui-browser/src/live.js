'use strict';

// Live content updates.
//
// Two very different problems hide behind "the page changed", and conflating
// them is what makes naive implementations unusable:
//
//   1. Announcements. A page says something — a status message, an error, a
//      search-results count. Screen readers handle this with aria-live, and
//      only aria-live: they do not read out every mutation. The observer can
//      report the live region's text directly, so this path costs nothing
//      and can fire immediately.
//
//   2. Buffer freshness. The list we are displaying drifts out of date as
//      the page mutates. Fixing that needs a new snapshot, and a snapshot
//      costs 120ms to 1.3s depending on view and page. A ticking clock would
//      peg the CPU if every tick triggered one, so this path is throttled
//      against its own measured cost.
//
// The asymmetry between views matters here. The DOM-based views hold real
// element references, so a mutation could map to a specific block.
// `ariaSnapshot()` returns a flat YAML string with no node identity at all,
// so the AX view can only ever be refreshed wholesale — which is exactly the
// view with the worst snapshot cost.

const BOUND = Symbol('tweb.liveBound');

const MIN_INTERVAL_MS = 400;
// Refresh at most this fraction of the time, measured against how long the
// last snapshot actually took. A 1.3s AX snapshot therefore refreshes at most
// once every ~6.5s rather than continuously.
const DUTY_CYCLE = 0.2;
// How often the driver checks whether a refresh is due. This is a steady
// tick, not a debounce: a timer restarted by every mutation never fires at
// all on a page that mutates continuously, which is precisely what a page
// with a clock does.
const TICK_MS = 250;
// Interactive input wins. If the reader pressed a key very recently, the
// refresh waits rather than repainting under their hands.
const INPUT_GRACE_MS = 200;

const OBSERVER_SCRIPT = () => {
  if (window.__twebObserver) return;

  // Only observe documents that are actually ours to read: the top document
  // and same-origin children. An ad-heavy page spawns hundreds of
  // cross-origin tracking iframes, and arming each one means hundreds of
  // MutationObservers all calling back over a single connection — which
  // queues ahead of our own snapshots and stalls them for seconds. None of
  // that traffic describes content the reader can see.
  try {
    if (window.top !== window.self) {
      // Throws for cross-origin parents, which is exactly the test we want.
      void window.top.document;
    }
  } catch {
    return;
  }

  // Coalesce inside the page. Calling the binding on every mutation batch
  // means an IPC round trip several times a second for information that only
  // needs to arrive once per tick.
  const NOTIFY_INTERVAL_MS = 250;
  let pendingAnnouncements = [];
  let pendingMutations = 0;
  let notifyTimer = null;

  const flush = () => {
    notifyTimer = null;
    const announcements = pendingAnnouncements;
    const mutations = pendingMutations;
    pendingAnnouncements = [];
    pendingMutations = 0;
    if (!mutations && announcements.length === 0) return;
    window.__twebNotify({ announcements: announcements.slice(0, 5), mutations });
  };

  const summarise = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    const live = el.closest('[aria-live], [role="alert"], [role="status"], output');
    let politeness = null;
    if (live) {
      politeness = live.getAttribute('aria-live')
        || (live.getAttribute('role') === 'alert' ? 'assertive' : 'polite');
      if (politeness === 'off') politeness = null;
    }
    const source = live || el;
    const text = (source.innerText || source.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 240);
    return { politeness, text };
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      pendingMutations += 1;
      const info = summarise(record.target);
      if (!info || !info.politeness || !info.text) continue;
      const key = info.politeness + ' ' + info.text;
      if (pendingAnnouncements.some((a) => a.politeness + ' ' + a.text === key)) continue;
      pendingAnnouncements.push({ politeness: info.politeness, text: info.text });
    }

    // Fixed-rate flush, never rescheduled, for the same reason the driver
    // uses a steady tick instead of a debounce.
    if (!notifyTimer) notifyTimer = setTimeout(flush, NOTIFY_INTERVAL_MS);
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-live', 'value', 'src', 'href', 'alt', 'title', 'hidden'],
  });

  window.__twebObserver = observer;
};

// The callback binding lives on the BrowserContext, not on a frame: only
// Page and BrowserContext expose bindings, and a context-level one reaches
// every frame including cross-origin children. addInitScript then arms the
// observer in every document created from now on, which is what keeps it
// working across navigations; the documents that already exist are armed by
// hand, since addInitScript only applies to future loads.
async function installLive(page, onEvent) {
  const context = page.context();
  let boundNow = false;

  if (!context[BOUND]) {
    context[BOUND] = true;
    boundNow = true;
    await context.exposeBinding('__twebNotify', (_source, payload) => onEvent(payload));
    await context.addInitScript(OBSERVER_SCRIPT);
  }

  // Arm the main frame only. Same-origin children get the observer from
  // addInitScript when they load; cross-origin ones are deliberately left
  // alone. Walking every frame here costs one round trip per frame, against
  // a frame count that keeps growing on its own.
  const armed = (await armFrame(page.mainFrame())) ? 1 : 0;
  return { boundNow, armed, frames: page.frames().length };
}

// Arms a single frame. Frames arrive continuously on ad-heavy pages, so
// re-scanning every frame each time one appears is quadratic work — several
// hundred evaluations per new tracking iframe. The observer script is
// idempotent, so arming just the new frame is both correct and cheap.
async function armFrame(frame) {
  try {
    await frame.evaluate(OBSERVER_SCRIPT);
    return true;
  } catch {
    return false; // detached, or a frame we are not allowed to script
  }
}

// Whether a buffer refresh is due, judged against what the last snapshot
// actually cost rather than a fixed interval.
function refreshDue(live, now = Date.now()) {
  if (!live.enabled || !live.dirty || live.refreshing) return false;
  if (now - live.lastInputMs < INPUT_GRACE_MS) return false;
  const cost = live.snapshotCostMs || MIN_INTERVAL_MS;
  const interval = Math.max(MIN_INTERVAL_MS, cost / DUTY_CYCLE);
  return now - live.lastRefreshMs >= interval;
}

function createLiveState() {
  return {
    enabled: true,
    dirty: false,
    refreshing: false,
    mutations: 0,
    notifies: 0,
    refreshes: 0,
    lastRefreshMs: 0,
    lastInputMs: 0,
    snapshotCostMs: 0,
    ticker: null,
    queue: [],
  };
}

module.exports = {
  installLive, armFrame, refreshDue, createLiveState,
  TICK_MS, MIN_INTERVAL_MS, DUTY_CYCLE, INPUT_GRACE_MS,
};
