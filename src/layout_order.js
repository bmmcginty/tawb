'use strict';

// Diagnostic alternatives to semantic document order.
//
// These functions only permute block objects. The item, frame, DOM index and
// activation metadata stay on the same object, so changing order cannot turn a
// readable line into a different control.

const ROW_TOLERANCE = 2;
const OVERLAP_RATIO = 0.6;

function rectOf(block) {
  const rect = block && block.item && block.item.visual && block.item.visual.rect;
  if (!rect) return null;
  const { top, left, width, height } = rect;
  if (![top, left, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { top, left, width, height, right: left + width, bottom: top + height };
}

function inlineDirection(block) {
  return block?.item?.visual?.direction === 'rtl' ? 'rtl' : 'ltr';
}

function writingMode(block) {
  return String(block?.item?.visual?.writingMode || 'horizontal-tb');
}

function overlapRatio(a, b) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (width * height) / smaller : 0;
}

function sameBand(row, entry, vertical) {
  const rect = entry.rect;
  const start = vertical ? rect.left : rect.top;
  const size = vertical ? rect.width : rect.height;
  const tolerance = Math.max(ROW_TOLERANCE, Math.min(8, Math.min(row.size, size) / 2));
  return Math.abs(start - row.start) <= tolerance;
}

function sortBand(entries, vertical) {
  const direction = inlineDirection(entries[0]?.block);
  return entries.sort((a, b) => {
    if (overlapRatio(a.rect, b.rect) >= OVERLAP_RATIO) return a.index - b.index;
    const av = vertical ? a.rect.top : a.rect.left;
    const bv = vertical ? b.rect.top : b.rect.left;
    const sign = !vertical && direction === 'rtl' ? -1 : 1;
    return sign * (av - bv) || a.index - b.index;
  });
}

function rectangleEntries(blocks) {
  const placed = [];
  blocks.forEach((block, index) => {
    const rect = rectOf(block);
    if (rect) placed.push({ block, index, rect });
  });
  if (placed.length < 2) return placed;

  const mode = writingMode(placed[0].block);
  const vertical = mode.startsWith('vertical');
  placed.sort((a, b) => {
    const av = vertical ? a.rect.left : a.rect.top;
    const bv = vertical ? b.rect.left : b.rect.top;
    // vertical-rl advances columns from right to left.
    const sign = vertical && mode.endsWith('-rl') ? -1 : 1;
    return sign * (av - bv) || a.index - b.index;
  });

  const rows = [];
  for (const entry of placed) {
    let row = rows[rows.length - 1];
    if (!row || !sameBand(row, entry, vertical)) {
      row = {
        start: vertical ? entry.rect.left : entry.rect.top,
        size: vertical ? entry.rect.width : entry.rect.height,
        entries: [],
      };
      rows.push(row);
    }
    row.entries.push(entry);
  }
  return rows.flatMap((row) => sortBand(row.entries, vertical));
}

// Keep geometry-less blocks beside the document-order item that introduced
// them. Generated accessibility nodes and frame fallbacks often have no box;
// moving all of them to the end would be a larger lie than leaving them near
// their semantic parent.
function attachUnplaced(blocks, ordered) {
  if (!ordered.length) return blocks.slice();
  const placed = new Set(ordered.map((entry) => entry.index));
  const leading = [];
  const after = new Map();
  let anchor = null;
  blocks.forEach((block, index) => {
    if (placed.has(index)) {
      anchor = index;
    } else if (anchor == null) {
      leading.push(block);
    } else {
      if (!after.has(anchor)) after.set(anchor, []);
      after.get(anchor).push(block);
    }
  });
  const out = leading.slice();
  for (const entry of ordered) {
    out.push(entry.block);
    out.push(...(after.get(entry.index) || []));
  }
  return out;
}

function orderRectangle(blocks) {
  return attachUnplaced(blocks, rectangleEntries(blocks));
}

function orderBlocks(blocks, mode = 'default') {
  if (mode === 'rectangle') return orderRectangle(blocks);
  return blocks.slice();
}

module.exports = {
  ROW_TOLERANCE,
  OVERLAP_RATIO,
  rectOf,
  rectangleEntries,
  attachUnplaced,
  orderRectangle,
  orderBlocks,
};
