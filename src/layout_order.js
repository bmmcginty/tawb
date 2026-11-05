'use strict';

// Diagnostic alternatives to semantic document order.
//
// These functions only permute block objects. The item, frame, DOM index and
// activation metadata stay on the same object, so changing order cannot turn a
// readable line into a different control.

const ROW_TOLERANCE = 2;
const OVERLAP_RATIO = 0.6;

// What the reader hears for each order. The action id carries the same name,
// so a command typed as layout-rectangle and the status line a moment later
// call the mode the same thing.
const LAYOUT_LABELS = Object.freeze({
  default: 'document order',
  container: 'container order',
  rectangle: 'rectangle order',
});

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

const pathOf = (block) => {
  const path = block?.item?.visual?.path;
  return Array.isArray(path) ? path : [];
};

function validRawRect(rect) {
  if (!rect) return null;
  const { top, left, width, height } = rect;
  if (![top, left, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { top, left, width, height, right: left + width, bottom: top + height };
}

function groupRows(groups, direction, writing = 'horizontal-tb') {
  if (groups.length < 2) return groups.slice();
  const vertical = writing.startsWith('vertical');
  const sign = vertical && writing.endsWith('-rl') ? -1 : 1;
  const sorted = groups.slice().sort((a, b) => {
    const av = vertical ? a.rect.left : a.rect.top;
    const bv = vertical ? b.rect.left : b.rect.top;
    return sign * (av - bv) || a.first - b.first;
  });
  const rows = [];
  for (const group of sorted) {
    let row = rows[rows.length - 1];
    const entry = { rect: group.rect };
    if (!row || !sameBand(row, entry, vertical)) {
      row = {
        start: vertical ? group.rect.left : group.rect.top,
        size: vertical ? group.rect.width : group.rect.height,
        entries: [],
      };
      rows.push(row);
    }
    row.entries.push(group);
  }
  return rows.flatMap((row) => row.entries.sort((a, b) => {
    if (overlapRatio(a.rect, b.rect) >= OVERLAP_RATIO) return a.first - b.first;
    const av = vertical ? a.rect.top : a.rect.left;
    const bv = vertical ? b.rect.top : b.rect.left;
    const inlineSign = !vertical && direction === 'rtl' ? -1 : 1;
    return inlineSign * (av - bv) || a.first - b.first;
  }));
}

function orderGroups(groups, container) {
  const placed = groups.filter((group) => group.rect);
  if (placed.length < 2) return groups;
  let ordered;
  if (container.kind === 'columns') {
    const sign = container.direction === 'rtl' ? -1 : 1;
    ordered = placed.slice().sort((a, b) => sign * (a.rect.left - b.rect.left)
      || a.rect.top - b.rect.top || a.first - b.first);
  } else {
    ordered = groupRows(placed, container.direction, container.writingMode);
  }
  const placedIds = new Set(ordered.map((group) => group.id));
  const leading = [];
  const after = new Map();
  let anchor = null;
  for (const group of groups) {
    if (placedIds.has(group.id)) anchor = group.id;
    else if (anchor == null) leading.push(group);
    else {
      if (!after.has(anchor)) after.set(anchor, []);
      after.get(anchor).push(group);
    }
  }
  const out = leading.slice();
  for (const group of ordered) {
    out.push(group);
    out.push(...(after.get(group.id) || []));
  }
  return out;
}

function containerCensus(blocks) {
  const containers = new Map();
  blocks.forEach((block, index) => {
    pathOf(block).forEach((entry, depth) => {
      if (entry == null || entry.container == null || entry.group == null) return;
      let container = containers.get(entry.container);
      if (!container) {
        container = {
          id: entry.container,
          depth,
          kind: entry.kind || 'grid',
          direction: entry.direction === 'rtl' ? 'rtl' : 'ltr',
          writingMode: entry.writingMode || 'horizontal-tb',
          first: index,
          slots: [],
          groupsById: new Map(),
        };
        containers.set(entry.container, container);
      }
      container.depth = Math.max(container.depth, depth);
      container.slots.push(index);
      let group = container.groupsById.get(entry.group);
      if (!group) {
        group = {
          id: entry.group,
          first: index,
          rect: validRawRect(entry.rect),
          slots: [],
        };
        container.groupsById.set(entry.group, group);
      }
      group.slots.push(index);
    });
  });
  return Array.from(containers.values()).sort((a, b) => b.depth - a.depth || b.first - a.first);
}

function applyContainer(blocks, container) {
  if (container.groupsById.size < 2) return blocks;
  // Descendant containers only permute these fixed slots. Reading the current
  // occupants preserves those inner permutations without searching every
  // block again for every ancestor container.
  const groups = Array.from(container.groupsById.values())
    .sort((a, b) => a.first - b.first)
    .map((group) => ({ ...group, blocks: group.slots.map((slot) => blocks[slot]) }));
  const flattened = orderGroups(groups, container).flatMap((group) => group.blocks);
  const out = blocks.slice();
  container.slots.forEach((slot, index) => { out[slot] = flattened[index]; });
  return out;
}

function orderContainer(blocks) {
  let out = blocks.slice();
  for (const container of containerCensus(blocks)) out = applyContainer(out, container);
  return out;
}

function orderBlocks(blocks, mode = 'default') {
  if (mode === 'rectangle') return orderRectangle(blocks);
  if (mode === 'container') return orderContainer(blocks);
  return blocks.slice();
}

module.exports = {
  ROW_TOLERANCE, LAYOUT_LABELS,
  OVERLAP_RATIO,
  rectOf,
  rectangleEntries,
  attachUnplaced,
  orderRectangle,
  containerCensus,
  applyContainer,
  orderContainer,
  orderBlocks,
};
