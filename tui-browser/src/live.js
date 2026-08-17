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
//
// There is one way round that without node identity, and it covers the case
// that hurts most: a clock, a counter, a score. Those replace text and change
// nothing else, and the page knows both the old text and the new one. Sent
// across as a pair, the old text names the line by content — the same way the
// cursor is already tracked across refreshes — and the driver can splice in
// the new text for a fraction of a millisecond instead of a whole snapshot.

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
// How long after a keystroke the reader still counts as "reading", during
// which the buffer is not swapped underneath them.
//
// This has to be longer than the gap between keystrokes, not shorter. At
// 200ms someone arrowing at a normal pace (~450ms per key) looked idle
// between every single press, so refreshes fired continuously mid-read and
// each one risked relocating the cursor. Screen readers do not reflow a
// virtual buffer while you move through it either; they hold it steady,
// announce live regions, and rebuild when you are done. Staleness while
// reading is the correct trade.
//
// Watching a page — a clock, a ticker — means not touching keys at all, so
// the same signal separates the two uses without the reader configuring
// anything: idle updates freely, active reading holds still.
const INPUT_GRACE_MS = 2500;

const OBSERVER_SCRIPT = (force) => {
  if (window.__twebObserver) return;

  // Documents are armed one of two ways. Frames we actually render are armed
  // explicitly, with force, whatever their origin — an embedded video player
  // is cross-origin and its elapsed time is content the reader can see.
  // Everything else is armed only if it is the top document or same-origin
  // with it: an ad-heavy page spawns hundreds of cross-origin tracking
  // iframes, and observing all of them means hundreds of MutationObservers
  // calling back over a single connection, queueing ahead of our own
  // snapshots and stalling them for seconds.
  if (!force) {
    try {
      if (window.top !== window.self) {
        // Throws for cross-origin parents, which is exactly the test we want.
        void window.top.document;
      }
    } catch {
      return;
    }
  }

  // Coalesce inside the page. Calling the binding on every mutation batch
  // means an IPC round trip several times a second for information that only
  // needs to arrive once per tick.
  const NOTIFY_INTERVAL_MS = 250;
  // More replacements than this in one batch is not a ticking clock, it is
  // the page rewriting itself, and a snapshot is the honest way to read it.
  const MAX_PATCHES = 8;
  let pendingAnnouncements = [];
  let pendingMutations = 0;
  let pendingPatches = [];
  // Whether every mutation seen this batch was a plain text replacement. One
  // that was not means the structure may have moved, so the driver must not
  // trust the patches alone.
  let pendingPure = true;
  let notifyTimer = null;

  const flush = () => {
    notifyTimer = null;
    const announcements = pendingAnnouncements;
    const mutations = pendingMutations;
    const patches = pendingPatches;
    const pureText = pendingPure && patches.length > 0;
    pendingAnnouncements = [];
    pendingMutations = 0;
    pendingPatches = [];
    pendingPure = true;
    if (!mutations && announcements.length === 0) return;
    window.__twebNotify({ announcements: announcements.slice(0, 5), mutations, patches, pureText });
  };

  const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();

  // The old and new text of a mutation that only replaced text. Anything
  // structural — an element added, an attribute changed, text that appeared
  // from nothing or vanished entirely — returns null, because the line count
  // can change and only a snapshot can say how.
  const textReplacement = (record) => {
    let from;
    let to;
    if (record.type === 'characterData') {
      from = clean(record.oldValue);
      to = clean(record.target.data);
    } else if (record.type === 'childList') {
      const nodes = [...record.removedNodes, ...record.addedNodes];
      if (nodes.length === 0 || nodes.some((n) => n.nodeType !== 3)) return null;
      from = clean([...record.removedNodes].map((n) => n.data).join(' '));
      to = clean([...record.addedNodes].map((n) => n.data).join(' '));
    } else {
      return null;
    }
    if (!from || !to || from === to) return null;
    return { from, to };
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

      const replacement = textReplacement(record);
      if (replacement && pendingPatches.length < MAX_PATCHES) pendingPatches.push(replacement);
      else pendingPure = false;

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
    // The text that was there before is what names the line to patch, and
    // the record is the only place it still exists.
    characterDataOldValue: true,
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

// Frames we have already armed. The observer script is idempotent in the
// page, but the round trip to get there is not free, and an unresponsive ad
// frame can sit on the shared connection for seconds — re-arming on every
// refresh pushed a snapshot from 0.6s to 33s.
const armedFrames = new WeakSet();

// A frame that never answers must not hold up everything behind it.
const ARM_TIMEOUT_MS = 2000;

async function armFrame(frame, { force = false } = {}) {
  if (armedFrames.has(frame)) return false;
  try {
    let timer;
    const guard = new Promise((_r, reject) => {
      timer = setTimeout(() => reject(new Error('arm timeout')), ARM_TIMEOUT_MS);
    });
    await Promise.race([frame.evaluate(OBSERVER_SCRIPT, force), guard])
      .finally(() => clearTimeout(timer));
    armedFrames.add(frame);
    return true;
  } catch {
    return false; // detached, unresponsive, or not ours to script
  }
}

// Arms the frames a snapshot actually drew content from, regardless of
// origin. This is the "observe what you display" rule: it reaches an
// embedded player's timer without reaching an ad iframe we never showed.
// Already-armed frames cost nothing, so this is safe to call after every
// snapshot; in practice it does real work only when a new frame appears.
async function armRenderedFrames(frames, limit = 8) {
  let armed = 0;
  for (const frame of frames.slice(0, limit)) {
    if (await armFrame(frame, { force: true })) armed += 1;
  }
  return armed;
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
  installLive, armFrame, armRenderedFrames, refreshDue, createLiveState,
  TICK_MS, MIN_INTERVAL_MS, DUTY_CYCLE, INPUT_GRACE_MS,
};
