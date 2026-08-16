'use strict';

const { renderLine, LINK_ROLES } = require('./aria');

// Turns flattened accessibility items into blocks — one per line of output.
//
// Every item gets its own line: a link is a line, the text that follows it
// starts the next line, a heading starts a line. Prose is not reflowed
// around inline links. That keeps a link's position fixed and predictable
// instead of drifting to wherever it happens to land inside a wrapped
// paragraph, so navigating to a link and reading its surrounding text stay
// separate, deliberate actions.
//
// Block-level container boundaries (`__break__`) already sit between groups
// after the parser collapses nested runs, so a group of repeated containers
// contributes one boundary rather than one per nesting level. With one item
// per line those boundaries need no extra separator — they are implied.
//
// The one exception is separator text — the `|` between a row of nav links,
// a stray comma or bracket. It carries no letters or digits, so it says
// nothing on a line of its own and only pads the list with rows to step
// past. Such text is appended to the preceding link's line instead. The
// line's item is still the link, so activating it is unaffected.
//
// Long text still wraps to the terminal width in layout.js; a wrapped
// remainder is a continuation of the same block, not a new item.

// Text with no letters and no digits: punctuation, pipes, bullets, dashes.
const SEPARATOR_ONLY = /^[^\p{L}\p{N}]+$/u;
// An opening bracket or quote introduces what comes next, so it joins the
// following line rather than dangling off the end of the previous one
// ("{Asus Bike Booster} (" reads as a mistake; "( {asus.com} )" does not).
const OPENING_ONLY = /^[([{«‹"'`¿¡]+$/u;

function isSeparatorText(item) {
  return item.role === 'text' && SEPARATOR_ONLY.test(item.name);
}

function buildBlocks(items) {
  const blocks = [];
  let pendingPrefix = '';
  // A container boundary means the next block begins a new paragraph-level
  // run, which is what paragraph navigation (p/P) steps between.
  let atBoundary = true;

  for (const item of items) {
    if (item.role === '__break__') { atBoundary = true; continue; }
    const text = renderLine(item);
    if (!text) continue;

    if (isSeparatorText(item)) {
      if (OPENING_ONLY.test(item.name)) {
        pendingPrefix = pendingPrefix ? `${pendingPrefix} ${text}` : text;
        continue;
      }
      const previous = blocks[blocks.length - 1];
      if (previous && LINK_ROLES.has(previous.item.role)) {
        previous.text += ' ' + text;
        continue;
      }
    }

    blocks.push({
      kind: 'control',
      text: pendingPrefix ? `${pendingPrefix} ${text}` : text,
      item,
      spans: [],
      startsBlock: atBoundary,
    });
    pendingPrefix = '';
    atBoundary = false;
  }

  return blocks;
}

// Same separator folding, applied to blocks that were built directly rather
// than from AX items (the DOM-derived views).
function foldSeparatorBlocks(blocks) {
  const out = [];
  let pendingPrefix = '';

  for (const block of blocks) {
    const isSeparator = block.item.role === 'text' && SEPARATOR_ONLY.test(block.text);

    if (isSeparator) {
      if (OPENING_ONLY.test(block.text)) {
        pendingPrefix = pendingPrefix ? `${pendingPrefix} ${block.text}` : block.text;
        continue;
      }
      const previous = out[out.length - 1];
      if (previous && LINK_ROLES.has(previous.item.role)) {
        previous.text += ' ' + block.text;
        continue;
      }
    }

    if (pendingPrefix) {
      block.text = `${pendingPrefix} ${block.text}`;
      pendingPrefix = '';
    }
    out.push(block);
  }

  return out;
}

// The interactive item on a line. With one item per line there is no span
// lookup to do — the whole line is the item — but text blocks are not
// activatable.
function itemAtOffset(block) {
  if (!block || !block.item) return null;
  return block.item.role === 'text' ? null : block.item;
}

module.exports = { buildBlocks, itemAtOffset, foldSeparatorBlocks };
