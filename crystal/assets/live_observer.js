// Generated from src/live.js OBSERVER_SCRIPT; update with tools/update_crystal_assets.js.
(force) => {
  // The document, not documentElement.
  //
  // This runs at document-start when it runs from addInitScript, and at
  // document-start there is no documentElement yet — the parser has not
  // reached the <html> tag. Observing it threw, the script died on the spot,
  // and the observer was never installed on any page at all. What kept live
  // updates working was the once-a-second pulse noticing nothing was
  // observing and arming it by hand, a second late, every single navigation:
  // long enough to miss anything a page announces while it loads.
  //
  // Watching the document instead is what the rest of this was reaching for
  // anyway. A page that replaces its document in place — `document.open()`,
  // or swapping documentElement, which is what a bot check does the moment it
  // is satisfied — used to leave the observer bound to a tree nobody was
  // looking at any more. The document node outlives both, so one observation
  // covers the page it had before and the page it has after.
  if (window[Symbol.for('tweb.observer')]) {
    if (window[Symbol.for('tweb.observerRoot')] === document) return;
    try { window[Symbol.for('tweb.observer')].disconnect(); } catch { /* already dead */ }
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
    // Left in the page for the reader to come and take, rather than pushed
    // out through a callback. See installLive.
    const key = Symbol.for('tweb.queue');
    const queue = window[key] || (window[key] = []);
    queue.push({ announcements: announcements.slice(0, 5), mutations, patches, pureText });
    // A reader that has stopped asking must not make the page grow.
    if (queue.length > 40) queue.splice(0, queue.length - 40);
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

  // Only a live region has anything to announce, and the caller drops
  // everything else on the floor — so the question is asked in that order.
  // Reading innerText forces layout, and this runs once per mutation record:
  // now that the observer is armed while the page is still being parsed, that
  // is once per element the parser inserts, on a page that is at its busiest.
  const summarise = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) return null;
    const live = el.closest('[aria-live], [role="alert"], [role="status"], output');
    if (!live) return null;
    let politeness = live.getAttribute('aria-live')
      || (live.getAttribute('role') === 'alert' ? 'assertive' : 'polite');
    if (politeness === 'off') return null;
    const text = (live.innerText || live.textContent || '')
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

  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    // The text that was there before is what names the line to patch, and
    // the record is the only place it still exists.
    characterDataOldValue: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-live', 'value', 'src', 'href', 'alt', 'title', 'hidden'],
  });

  window[Symbol.for('tweb.observer')] = observer;
  window[Symbol.for('tweb.observerRoot')] = document;
}
