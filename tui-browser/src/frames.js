'use strict';

const { buildBlocks, foldSeparatorBlocks } = require('./blocks');
const { snapshotDomBlocks } = require('./dom');
const { snapshotRenderBlocks } = require('./render_html');
const { snapshotSourceBlocks } = require('./source_html');
const { log } = require('./log');

// Renders embedded frames inline, where they sit in the parent page.
//
// Neither view descends into frames on its own: ariaSnapshot emits a bare
// `- iframe` stub with no contents (even same-origin), and a DOM walk stops
// at the frame boundary because the child document is a separate document.
// So an embedded video, map or comment thread simply is not there. Driving
// the browser rather than injecting a content script is what makes this
// fixable at all — Playwright can read cross-origin frames that page-side
// JavaScript could never touch.
//
// Child frames are spliced in directly after the iframe line that owns them,
// so reading order matches the page.

const MAX_DEPTH = 4;
const MAX_FRAMES = 25;
// No single frame may hold up a snapshot. On a page mid ad-storm, an
// ariaSnapshot of the main document and a query for its child frames were
// each measured taking 23 seconds, producing a 46 second snapshot during
// which the interface had nothing new to show. A partial view now, built
// from the frames that answered promptly, beats a complete one much later.
const FRAME_BUDGET_MS = 4000;

function withDeadline(promise, ms, onTimeout) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeout), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function isFrameItem(item) {
  return item && (item.role === 'iframe' || item.tag === 'iframe' || item.tag === 'frame');
}

// The three DOM-derived views are pure injected JavaScript and work on any
// engine. Only the AX view needs the driver, which is the one that knows how
// the accessibility tree is computed for the browser in hand.
async function blocksForFrame(frame, source, driver = null) {
  // Raw HTML mode stays unfolded on purpose: it is the inspection view, so
  // it should show what is there rather than a tidied version of it. The
  // same goes double for the source view, where tidying would be a lie.
  if (source === 'source') return snapshotSourceBlocks(frame);
  if (source === 'html') return snapshotDomBlocks(frame);
  if (source === 'render') return foldSeparatorBlocks(await snapshotRenderBlocks(frame));
  if (!driver) throw new Error('the AX view needs a driver to read the accessibility tree');
  const blocks = buildBlocks(await driver.axItems(frame));
  // AX items carry no element reference, so record the frame they came from;
  // activation resolves role/name against that frame, not the main page.
  for (const block of blocks) {
    if (block.item) block.item.frame = frame;
  }
  return blocks;
}

// Read a document with a page-side extractor, and read it again with the
// closed shadow roots supplied if the first answer suggests there was
// something the page could not show us.
//
// The second attempt is not free — a piercing scan of the node tree measured
// 4ms on a Turnstile widget frame but 146ms on a Wikipedia article and 329ms
// on Reddit, neither of which contains a single closed shadow root — so it is
// made only when the first answer came back empty. A document that renders
// and says nothing is the signature of exactly this and of very little else.
//
// `isEmpty` is the caller's, because what "nothing" means depends on what was
// being read: no accessibility items, no tokens, no lines.
async function readDocument(frame, pageFunction, driver, isEmpty) {
  const first = await frame.evaluate(pageFunction);
  if (!isEmpty(first)) return first;
  if (!driver || typeof driver.pierceAndRun !== 'function') return first;
  const second = await driver.pierceAndRun(frame, pageFunction).catch(() => null);
  return second || first;
}

// A key that means "the same document" across two listings of it. Playwright
// hands back the same Frame object every time and can be compared directly;
// the BiDi driver builds a fresh object per call, so its context id is what
// stays the same.
function frameKey(frame) {
  return frame && frame.contextId ? frame.contextId : frame;
}

// Every child document, however it got there. Asked of the browser rather
// than of the page's own markup, which is the whole point: an <iframe> inside
// a closed shadow root cannot be found by querySelectorAll, so a walker that
// only ever looks at elements will never learn that document exists at all.
async function everyChildFrame(frame) {
  if (typeof frame.childFrames !== 'function') return [];
  try {
    const children = frame.childFrames();
    return Array.isArray(children) ? children : await children;
  } catch {
    return [];
  }
}

// Child frames in document order, paired with the iframe element that hosts
// each one. Ordering is what lets us match the Nth iframe line to the Nth
// child frame without needing an element reference in AX mode.
//
// `limit` is not cosmetic. Ad-heavy pages accumulate hundreds of tracking
// iframes — timeanddate.com reaches 435 — and every contentFrame() call is a
// round trip to the browser. Resolving them all pushed a single snapshot from
// 0.4s to 9s. We resolve only as many as the caller can actually descend into.
async function orderedChildFrames(frame, limit = Infinity) {
  const handles = await frame.$$('iframe, frame');
  const children = [];

  for (const handle of handles) {
    if (children.length >= limit) {
      await handle.dispose().catch(() => {});
      continue;
    }
    try {
      const child = await handle.contentFrame();
      if (child) children.push(child);
    } catch {
      // Inaccessible frame (detached, or a sandbox we cannot reach).
    }
    await handle.dispose().catch(() => {});
  }

  return children;
}

// `visited` collects the frames that actually contributed content, so the
// caller can observe exactly what it displays.
async function snapshotFrameTree(page, source, { visited = null, driver = null } = {}) {
  const budget = { remaining: MAX_FRAMES };
  return walk(page.mainFrame(), source, 0, budget, new Set(), visited, driver);
}

async function walk(frame, source, depth, budget, seen, visited, driver) {
  let blocks;
  const tBlocks = Date.now();
  try {
    blocks = await withDeadline(blocksForFrame(frame, source, driver), FRAME_BUDGET_MS, null);
  } catch {
    log('frame.blocks.error', { depth, url: frame.url().slice(0, 80) });
    return []; // frame navigated or detached mid-snapshot
  }
  if (blocks === null) {
    log('frame.blocks.timeout', { depth, ms: Date.now() - tBlocks, url: frame.url().slice(0, 100) });
    return [];
  }
  const blocksMs = Date.now() - tBlocks;
  if (visited && blocks.length) visited.push(frame);
  // Engines that build frame objects per snapshot rather than tracking a live
  // tree need telling what was reached, so page.frames() can report it.
  if (frame.page && typeof frame.page.noteFrame === 'function') frame.page.noteFrame(frame);
  if (blocksMs > 100) {
    log('frame.blocks.slow', { depth, ms: blocksMs, blocks: blocks.length, url: frame.url().slice(0, 100) });
  }

  if (depth >= MAX_DEPTH || budget.remaining <= 0) return blocks;

  let children;
  const tKids = Date.now();
  try {
    children = await withDeadline(orderedChildFrames(frame, budget.remaining), FRAME_BUDGET_MS, null);
  } catch {
    return blocks;
  }
  if (children === null) {
    log('frame.children.timeout', { depth, ms: Date.now() - tKids, url: frame.url().slice(0, 100) });
    return blocks;
  }
  const kidsMs = Date.now() - tKids;
  if (kidsMs > 100) {
    log('frame.children.slow', { depth, ms: kidsMs, found: children.length, url: frame.url().slice(0, 100) });
  }
  // Deliberately not returning when no iframe element was found. That used to
  // mean "no child documents", and on a page that hides its iframe in a closed
  // shadow root it is exactly wrong: there are no elements to find and there
  // is a document all the same.

  const out = [];
  let childIndex = 0;
  const placed = new Set();

  for (const block of blocks) {
    out.push(block);
    if (!isFrameItem(block.item)) continue;

    const child = children[childIndex];
    childIndex += 1;
    if (!child) continue;
    placed.add(frameKey(child));

    const url = child.url();
    // about:blank frames are placeholders, and a frame that reappears at the
    // same URL inside itself would recurse forever.
    if (!url || url === 'about:blank' || seen.has(url)) continue;

    budget.remaining -= 1;
    if (budget.remaining < 0) break;

    const nested = await walk(child, source, depth + 1, budget, new Set([...seen, url]), visited, driver);
    out.push(...nested);
  }

  // Documents the page's own markup never mentioned.
  //
  // Splicing a child frame in after the element that hosts it only works when
  // the element can be found, and an <iframe> inside a closed shadow root
  // cannot be: querySelectorAll does not cross that boundary and neither does
  // any walk built on it. Cloudflare's challenge is exactly this — the widget
  // frame is real, the browser lists it, and the host page reports zero
  // iframe elements — so the reader was shown nothing at all where a bot
  // check was standing.
  //
  // There is no way to know where such a frame belongs, so it goes at the
  // end, named, rather than being dropped. A frame the reader can reach at
  // the wrong place beats one they cannot reach at all.
  const hidden = (await everyChildFrame(frame)).filter((child) => !placed.has(frameKey(child)));
  for (const child of hidden) {
    if (budget.remaining <= 0) break;
    let url = '';
    try { url = child.url() || ''; } catch { url = ''; }
    if (!url || url === 'about:blank' || seen.has(url)) continue;

    budget.remaining -= 1;
    const nested = await walk(child, source, depth + 1, budget, new Set([...seen, url]), visited, driver);

    // The marker goes in even when nothing could be read out of the frame.
    // A document whose contents are behind a closed shadow root reads as
    // empty, and "there is a Cloudflare frame here that I cannot see into" is
    // a great deal more use to a reader than silence where a bot check is.
    let host = url;
    try { host = new URL(url).host || url; } catch { /* keep the raw url */ }
    log('frame.hidden', { depth, url: url.slice(0, 100), blocks: nested.length });

    // A frame nothing could be read out of is still something the reader may
    // need to press — a challenge behind a closed shadow root is exactly
    // that, and on an engine that cannot pierce one it is the only way in. So
    // the marker becomes a control, carrying the frame itself, and activating
    // it aims a real click into the middle of that document.
    if (nested.length) {
      out.push({ text: `<frame: ${host}>`, item: { role: 'iframe', name: host } });
      out.push(...nested);
    } else {
      out.push({
        text: `[*frame: ${host} — press to reach it]`,
        item: { role: 'button', name: `frame: ${host}`, pressFrame: child },
      });
    }
  }

  return out;
}

module.exports = {
  snapshotFrameTree, isFrameItem, blocksForFrame, orderedChildFrames, everyChildFrame,
  readDocument, frameKey,
  // The reader's own views and the edbrowse page descend the same tree, so
  // they must not disagree about how far or how wide. These numbers were
  // measured on real pages; a second set beside them would drift.
  MAX_DEPTH, MAX_FRAMES, FRAME_BUDGET_MS,
};
