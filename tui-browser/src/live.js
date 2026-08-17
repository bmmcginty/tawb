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
  // An observer only ever watches the document it was attached to. A page
  // that replaces its document in place — `document.open()`, or swapping
  // documentElement, which is what a bot check does the moment it is
  // satisfied — leaves the observer bound to a document nobody is looking at
  // any more. The window survives, so a plain "already installed" check
  // would refuse to re-arm and the page would go silent for good. Re-arm
  // whenever the root we are watching is no longer the live one.
  if (window.__twebObserver) {
    if (window.__twebObserverRoot === document.documentElement) return;
    try { window.__twebObserver.disconnect(); } catch { /* already dead */ }
  }

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
  window.__twebObserverRoot = document.documentElement;
};

// Asked once a second, so it has to be cheap: is the observer still watching
// the document on screen, and does the page still hold what it held? An
// element count, the title and the URL are enough to notice a document being
// swapped out from under us — and cost a fraction of what a snapshot does.
const PULSE_SCRIPT = () => ({
  observing: !!(window.__twebObserver && window.__twebObserverRoot === document.documentElement),
  href: location.href,
  print: [
    document.getElementsByTagName('*').length,
    document.title,
    location.href,
  ].join('|'),
});

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

async function armFrame(frame, { force = false, again = false } = {}) {
  // `again` is for a frame we know needs re-arming despite having been armed
  // before: the frame object outlives the document, so the record of having
  // armed it says nothing about the document now loaded in it.
  if (armedFrames.has(frame) && !again) return false;
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

// Some changes arrive with nobody to announce them.
//
// Both of our signals can go quiet at the same time. A page that replaces
// its document in place kills the observer — it is still watching the old
// document — and produces no navigation event either, because nothing
// navigated. Measured against a page doing exactly that, the reader sat on a
// one-line buffer indefinitely while the real page had been there since four
// seconds in. Reddit's bot check behaves this way, and the reader's only way
// out was to cycle views by hand and force a snapshot.
//
// So once a second we ask the page directly. Not what it says — that is a
// snapshot, and the expensive thing we are avoiding — just whether it is
// still the page we think it is, and whether anyone is still listening.
const PULSE_MS = 1000;
const PULSE_TIMEOUT_MS = 1000;

function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('pulse timeout')), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

async function pulse(page, live, now = Date.now()) {
  if (!live.enabled) return null;
  if (now - live.lastPulseMs < PULSE_MS) return null;
  live.lastPulseMs = now;

  const started = Date.now();
  let reading;
  try {
    reading = await withTimeout(page.mainFrame().evaluate(PULSE_SCRIPT), PULSE_TIMEOUT_MS);
  } catch {
    live.pulseErrors = (live.pulseErrors || 0) + 1;
    return null; // navigating, detached, or too busy to answer — try later
  }
  const ms = Date.now() - started;

  let rearmed = false;
  if (!reading.observing) {
    rearmed = await armFrame(page.mainFrame(), { force: true, again: true });
  }

  // The first reading is a baseline, not a change.
  const changed = live.print !== null && reading.print !== live.print;
  // A different URL is not a changed page, it is a different one. The buffer
  // describes a document that no longer exists, so every line in it refers to
  // an element that is gone.
  const navigated = live.href !== null && reading.href !== live.href;
  live.print = reading.print;
  live.href = reading.href;
  if (changed) live.dirty = true;
  if (navigated) live.navigated = true;

  return { changed, navigated, rearmed, ms };
}

// Whether a buffer refresh is due, judged against what the last snapshot
// actually cost rather than a fixed interval.
function refreshDue(live, now = Date.now()) {
  if (!live.enabled || !live.dirty || live.refreshing) return false;
  // The reading freeze holds a document still while it is being read. It has
  // nothing to hold when the document has been replaced: waiting then leaves
  // the reader moving around a page that is gone, and the longer they keep
  // pressing keys the longer it lasts — which is exactly when it is least
  // likely to look like the page's fault. Measured at 9 seconds of stale
  // buffer after following a link, ended only by refreshing by hand.
  if (live.navigated) return true;
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
    lastPulseMs: 0,
    print: null,
    href: null,
    navigated: false,
    snapshotCostMs: 0,
    ticker: null,
    queue: [],
  };
}

module.exports = {
  installLive, armFrame, armRenderedFrames, refreshDue, createLiveState, pulse,
  TICK_MS, MIN_INTERVAL_MS, DUTY_CYCLE, INPUT_GRACE_MS, PULSE_MS,
};
