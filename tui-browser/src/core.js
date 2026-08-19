'use strict';

const { snapshotFrameTree } = require('./frames');
const { armRenderedFrames } = require('./live');
const { log } = require('./log');

// The core: everything about a page that is not about a terminal.
//
// The reader in index.js owns a terminal — a width to wrap to, a cursor on a
// row, a scroll position, four prompt modes. None of that is true of
// edbrowse, which owns its own buffer and its own line numbers, and none of
// it would be true of a port that kept this program and threw the front end
// away. What both front ends need is the same: a page, a view of it, a list
// of blocks with stable identity, and the policy that decides when that list
// is allowed to change under a reader.
//
// That is what lives here. The dividing line is deliberately drawn at the
// *block*, not the line:
//
//   blocks  — one per thing on the page (a link, a heading, a paragraph).
//             Core. Width-independent. Carries the item behind it, which is
//             what activation resolves against.
//   lines   — blocks wrapped to a terminal width, with continuations.
//             Front end. A block may be one line or nine; edbrowse would
//             wrap differently, or not at all.
//
// Every position that crosses this boundary is therefore a block index. The
// front end maps it to and from its own lines, and nothing here ever needs
// to know how wide anything is.
//
// ## The shadow cursor
//
// Several of the rules this program exists for need to know where the reader
// is: a text patch must never rewrite the line under them, a rebuild must
// re-anchor rather than teleport, and a change region is only worth
// reporting relative to somewhere. The cursor belongs to the front end — it
// is a terminal artefact, and edbrowse's would be its own — so the core
// cannot read it, and asking for it per decision would make the boundary
// chatty in exactly the place it must not be.
//
// Instead the front end *tells* the core, with `at(blockIndex)`, whenever
// the reader moves. It is one-way and unacknowledged: over a socket it would
// be a single line of JSON, about 25 microseconds, with nothing awaiting it.
// The core keeps the last one it was told and uses it to make its decisions.
// A stale shadow cursor costs at worst one refused patch, which is the safe
// direction to be wrong in.
//
// ## What is not here yet
//
// Live-update policy, the four actions (activate, click, type, more) and tab
// handling are still in index.js and move here next. The event surface those
// need — `announce`, `changed`, `navigated`, `tab-opened`, `tab-closed` —
// arrives with them rather than ahead of them.

// The views of a page, cycled by backslash. Which are available depends on
// the engine: everything but AX is injected JavaScript and works anywhere,
// while the accessibility tree needs the driver to compute it.
const ALL_SOURCES = ['ax', 'render', 'html', 'source'];
const SOURCE_LABELS = { ax: 'AX', render: 'PAGE', html: 'HTML', source: 'SOURCE' };
// The two views built from a DOM walk keep their own page-side node array
// and are activated through it, rather than by matching role and name.
const DOM_SOURCES = new Set(['html', 'source']);

async function snapshotBlocks(page, source = 'ax', { visited = null, driver = null } = {}) {
  const t0 = Date.now();
  const blocks = await snapshotFrameTree(page, source, { visited, driver });
  log('snapshot', { source, ms: Date.now() - t0, blocks: blocks.length, frames: page.frames().length });
  return blocks;
}

// Identity of the element behind a block, where the view has one. The
// DOM-derived views number the nodes they walk, which survives a re-snapshot
// as long as the document structure has not shifted — far stronger evidence
// than the block's text, which is routinely duplicated.
function identityOf(block) {
  if (!block || !block.item) return null;
  const index = block.item.domIndex != null ? block.item.domIndex : block.item.renderIndex;
  if (index == null) return null;
  const frameUrl = block.item.frame ? block.item.frame.url() : '';
  return `${frameUrl}#${index}`;
}

function diffBlocks(previousTexts, blocks) {
  const before = new Set(previousTexts);
  const changed = [];
  blocks.forEach((block, index) => {
    if (!before.has(block.text)) changed.push(index);
  });

  // Collapse consecutive indices into regions; one edit usually replaces a
  // run of lines and should be reported as a single place to go.
  const regions = [];
  for (const index of changed) {
    const last = regions[regions.length - 1];
    if (last && index === last.end + 1) last.end = index;
    else regions.push({ start: index, end: index });
  }
  return regions;
}

// Where a piece of text sits in the buffer, but only if it sits in exactly
// one place. Ambiguity is the whole risk in patching by content: "12:04"
// appearing twice means we cannot say which one the page rewrote.
function soleBlockContaining(blocks, needle) {
  let found = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    const at = blocks[i].text.indexOf(needle);
    if (at < 0) continue;
    // Twice inside one line is just as ambiguous as once in two lines.
    if (found >= 0 || blocks[i].text.indexOf(needle, at + needle.length) >= 0) return -1;
    found = i;
  }
  return found;
}

// The block holding a piece of text, searched by content in both directions:
// the buffer's line can be longer than the snippet (prose runs together) or
// shorter (a link renders as just its name).
function findBlockWithText(blocks, needle) {
  const trimmed = (needle || '').trim();
  if (!trimmed) return -1;

  const direct = blocks.findIndex((b) => b.text.includes(trimmed));
  if (direct >= 0) return direct;

  // Long enough that a common word cannot match the wrong place.
  return blocks.findIndex((b) => {
    const text = b.text.trim();
    return text.length >= 10 && trimmed.includes(text);
  });
}

// Whether two URLs are the same document reached at a different fragment.
function sameDocumentFragment(before, after) {
  try {
    const a = new URL(before);
    const b = new URL(after);
    if (!b.hash) return false;
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

class Core {
  constructor({ driver, page, source, sources }) {
    this.driver = driver;
    this.page = page;
    this.sources = sources;
    this.source = source;
    this.blocks = [];
    // Bumped whenever the block list is replaced wholesale. A front end that
    // holds its own copy — which every front end does, and a front end
    // across a socket must — needs to know that a patch it is being handed
    // was computed against the buffer it still has. Patches name the
    // generation they belong to; one that names an older generation is
    // dropped rather than misapplied.
    this.generation = 0;
    this.renderedUrl = '';
    // Where the front end last said the reader was, as a block index. See
    // the shadow cursor note above; -1 means it has not said yet.
    this.cursorBlock = -1;
    this.changes = [];
    this.changeIndex = -1;
    this.snapshotCostMs = 0;
  }

  // The front end reporting a move. One way, no reply, cheap enough to send
  // on every arrow key.
  at(blockIndex) {
    this.cursorBlock = Number.isInteger(blockIndex) ? blockIndex : -1;
  }

  block(index) {
    return this.blocks[index] || null;
  }

  texts() {
    return this.blocks.map((b) => b.text);
  }

  // Re-read the page into a new block list. Everything about where the
  // reader ends up afterwards is the caller's, because it is decided in line
  // space; all this does is replace the buffer and say so.
  // `page` is an argument rather than always `this.page` because switching
  // tabs re-reads the tab being moved to before it becomes the current one.
  async rescan({ page = this.page } = {}) {
    const started = Date.now();
    const visited = [];
    this.blocks = await snapshotBlocks(page, this.source, { visited, driver: this.driver });
    this.generation += 1;
    this.renderedUrl = page.url();
    // Observe what we display: a frame that contributed lines may keep
    // changing them — an embedded player's elapsed time, for instance — and
    // it is often cross-origin, so nothing else would arm it.
    armRenderedFrames(visited).catch(() => {});
    this.snapshotCostMs = Date.now() - started;
    return this.blocks;
  }

  setView(source) {
    this.source = source;
  }

  noteChanges(previousTexts) {
    this.changes = diffBlocks(previousTexts, this.blocks);
    this.changeIndex = -1;
    return this.changes;
  }

  // Splices replaced text straight into the buffer, skipping the snapshot.
  //
  // A clock costs a whole-page snapshot per tick otherwise — 150ms on a
  // plain page and seconds on a heavy one — to change eight characters. When
  // the page tells us the exact text it replaced, and that text names one
  // block and one block only, we can rewrite that block for a fraction of a
  // millisecond.
  //
  // Returns the block indices it changed together with the undo that puts
  // them back, or null if the patches could not be accounted for. The undo
  // matters because the caller has one more test to apply that cannot be
  // made here: a patch whose new text wraps to a different number of lines
  // would reflow the buffer, and reflowing the buffer moves the reader,
  // which is the one thing a live update may not do. Only the front end
  // knows how wide a line is, so only the front end can see that coming —
  // and it needs a way back when it does.
  patchText(patches, { protect = true } = {}) {
    if (!patches || !patches.length || !this.blocks.length) return null;

    const undoLog = [];
    const touched = [];
    const undo = () => {
      for (const entry of undoLog.reverse()) {
        entry.block.text = entry.text;
        if (entry.name !== null) entry.block.item.name = entry.name;
      }
      undoLog.length = 0;
    };

    for (const patch of patches) {
      const { from, to } = patch || {};
      if (!from || !to || from === to) { undo(); return null; }

      // Resolved one at a time, against the buffer as the previous patch
      // left it: two patches can land on the same block.
      const index = soleBlockContaining(this.blocks, from);
      if (index < 0) { undo(); return null; }

      const block = this.blocks[index];
      const item = block.item;
      const hadName = item && typeof item.name === 'string' && item.name.includes(from);
      undoLog.push({ block, text: block.text, name: hadName ? item.name : null });

      block.text = block.text.replace(from, to);
      // The name is what activation resolves against, so it cannot be left
      // describing text that is no longer on the page.
      if (hadName) item.name = item.name.replace(from, to);
      if (!touched.includes(index)) touched.push(index);
    }

    // The block the reader is on is theirs while they are reading it. A
    // clock elsewhere on the page may tick — that moves nothing — but
    // rewriting the words under them mid-sentence is exactly what the freeze
    // exists to prevent. This is the shadow cursor's whole job.
    if (protect && this.cursorBlock >= 0 && touched.includes(this.cursorBlock)) {
      undo();
      return null;
    }

    return { touched, undo, generation: this.generation };
  }
}

module.exports = {
  Core,
  ALL_SOURCES, SOURCE_LABELS, DOM_SOURCES,
  snapshotBlocks, identityOf, diffBlocks, soleBlockContaining, findBlockWithText,
  sameDocumentFragment,
};
