'use strict';

const { parseAriaSnapshot } = require('./aria');
const { buildBlocks, foldSeparatorBlocks } = require('./blocks');
const { snapshotDomBlocks } = require('./dom');
const { snapshotRenderBlocks } = require('./render_html');
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

function isFrameItem(item) {
  return item && (item.role === 'iframe' || item.tag === 'iframe' || item.tag === 'frame');
}

async function blocksForFrame(frame, source) {
  // Raw HTML mode stays unfolded on purpose: it is the inspection view, so
  // it should show what is there rather than a tidied version of it.
  if (source === 'html') return snapshotDomBlocks(frame);
  if (source === 'render') return foldSeparatorBlocks(await snapshotRenderBlocks(frame));
  const yamlText = await frame.locator('body').ariaSnapshot();
  const blocks = buildBlocks(parseAriaSnapshot(yamlText));
  // AX items carry no element reference, so record the frame they came from;
  // activation resolves role/name against that frame, not the main page.
  for (const block of blocks) {
    if (block.item) block.item.frame = frame;
  }
  return blocks;
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

async function snapshotFrameTree(page, source) {
  const budget = { remaining: MAX_FRAMES };
  return walk(page.mainFrame(), source, 0, budget, new Set());
}

async function walk(frame, source, depth, budget, seen) {
  let blocks;
  const tBlocks = Date.now();
  try {
    blocks = await blocksForFrame(frame, source);
  } catch {
    log('frame.blocks.error', { depth, url: frame.url().slice(0, 80) });
    return []; // frame navigated or detached mid-snapshot
  }
  const blocksMs = Date.now() - tBlocks;
  if (blocksMs > 100) {
    log('frame.blocks.slow', { depth, ms: blocksMs, blocks: blocks.length, url: frame.url().slice(0, 100) });
  }

  if (depth >= MAX_DEPTH || budget.remaining <= 0) return blocks;

  let children;
  const tKids = Date.now();
  try {
    children = await orderedChildFrames(frame, budget.remaining);
  } catch {
    return blocks;
  }
  const kidsMs = Date.now() - tKids;
  if (kidsMs > 100) {
    log('frame.children.slow', { depth, ms: kidsMs, found: children.length, url: frame.url().slice(0, 100) });
  }
  if (children.length === 0) return blocks;

  const out = [];
  let childIndex = 0;

  for (const block of blocks) {
    out.push(block);
    if (!isFrameItem(block.item)) continue;

    const child = children[childIndex];
    childIndex += 1;
    if (!child) continue;

    const url = child.url();
    // about:blank frames are placeholders, and a frame that reappears at the
    // same URL inside itself would recurse forever.
    if (!url || url === 'about:blank' || seen.has(url)) continue;

    budget.remaining -= 1;
    if (budget.remaining < 0) break;

    const nested = await walk(child, source, depth + 1, budget, new Set([...seen, url]));
    out.push(...nested);
  }

  return out;
}

module.exports = { snapshotFrameTree, isFrameItem, blocksForFrame, orderedChildFrames };
