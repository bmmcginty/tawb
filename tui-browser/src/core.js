'use strict';

const { snapshotFrameTree } = require('./frames');
const { armRenderedFrames } = require('./live');
const { activateDomItem, domElementHandle } = require('./dom');
const { clickThrough, prepareRealClick } = require('./click');
const { renderElementHandle } = require('./render_html');
const { remapIndex } = require('./remap');
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
// Keeping the reader's place
//
// All of this used to be worked out in line space, over the terminal's
// wrapped lines. It is worked out in block space now, which is not merely
// tidier: a block is what the page produced, so the same buffer re-read at a
// different terminal width gives the same answer, and the arithmetic remap
// below can no longer be thrown off by a line that rewrapped when nothing
// about the page had changed at all.
// ---------------------------------------------------------------------------

// How far from the old position a re-anchor will look. A live update must
// never relocate the reader across the page: past this, staying put is the
// better answer.
const REANCHOR_WINDOW = 250;
// How many neighbours on each side identify a position. Block text is
// routinely duplicated — an HTML view is full of repeated <svg> and
// <option> — so what tells two identical blocks apart is what sits around
// them.
const CONTEXT_RADIUS = 3;

// ---------------------------------------------------------------------------
// Acting on the page
//
// Nothing in here decides what to say about what happened; it reports what
// happened and leaves the wording to whoever has a reader to tell. That is
// not tidiness — a front end that is not a terminal has its own idea of how
// to say "that control cannot be clicked", and edbrowse would say it in a
// buffer rather than on a status line.
// ---------------------------------------------------------------------------

// Nothing the reader triggers may block the interface indefinitely.
// Playwright's default timeout is 30 seconds, so a click that cannot resolve
// — a control inside a bot-check frame, an element that vanished mid-page —
// froze the whole terminal for half a minute with no way out. Bound it, and
// report the failure to whoever asked instead.
const ACTION_TIMEOUT_MS = 6000;

class ActionTimeout extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ActionTimeout(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Reads the field's live text + caret straight from the DOM. Real
// <input>/<textarea> elements expose selectionStart, which is the source of
// truth (handles autoformatting, IME, etc.). contenteditable/custom widgets
// don't, so we fall back to textContent and track the caret locally.
//
// Takes an ElementHandle, not a Locator: a locator re-resolves by role+name
// on every call, and a field's accessible name can change while you type
// (Wikipedia's search box renames itself once suggestions open), which makes
// the locator stop matching mid-edit.
async function readFieldState(handle) {
  return handle.evaluate((el) => {
    if ('value' in el && typeof el.value === 'string') {
      return {
        text: el.value,
        caret: el.selectionStart != null ? el.selectionStart : el.value.length,
        native: true,
      };
    }
    const text = el.textContent || '';
    return { text, caret: text.length, native: false };
  });
}

const TEXT_AT_FRAGMENT = (hash) => {
  let target = null;
  try {
    target = document.getElementById(hash) || document.querySelector(`[name="${CSS.escape(hash)}"]`);
  } catch { /* not a usable selector */ }
  if (!target) return null;

  // The first readable text at or after the target. A skip link usually
  // points at a container — <main id="main-content"> — whose own text is the
  // entire rest of the page, so what identifies the place is the first thing
  // inside it, not the container.
  //
  // Readable is the load-bearing word. Reddit's #main-content opens with a
  // <script> whose source is the first text node in it; matching on that
  // looks for `SML.load([...])` in the buffer, which no view will ever show.
  const UNRENDERED = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'HEAD']);
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || UNRENDERED.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if ((node.data || '').replace(/\s+/g, ' ').trim().length < 2) return NodeFilter.FILTER_REJECT;
      const style = window.getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  walker.currentNode = target;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    return (node.data || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  return null;
};

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

  blockText(index) {
    const block = this.blocks[index];
    return block ? block.text : '';
  }

  // Where the reader is, described well enough to find again in a buffer
  // that has been rebuilt: by the element if the view knows one, by the text
  // otherwise, by the neighbours when the text repeats, and by proportion
  // when nothing else survived.
  anchor() {
    const index = this.cursorBlock;
    const block = this.blocks[index] || null;
    return {
      text: block ? block.text : '',
      name: block && block.item ? block.item.name : '',
      identity: identityOf(block),
      block: index,
      context: Array.from(
        { length: CONTEXT_RADIUS * 2 + 1 },
        (_, i) => this.blockText(index + i - CONTEXT_RADIUS),
      ),
      ratio: this.blocks.length ? index / this.blocks.length : 0,
    };
  }

  // Putting the reader back after a change they asked for — a view switch, a
  // refresh they pressed for. Always answers with somewhere, falling back to
  // the same proportion of a buffer whose line count may be wildly different,
  // because the reader asked for this and has to arrive somewhere.
  restore(anchor) {
    if (!anchor || !this.blocks.length) return 0;
    const needle = (anchor.name || anchor.text || '').trim();

    if (needle) {
      const exact = this.blocks.findIndex((b) => b.text === anchor.text);
      if (exact >= 0) return exact;

      const partial = this.blocks.findIndex((b) => b.text.includes(needle));
      if (partial >= 0) return partial;
    }

    return Math.min(
      Math.round(anchor.ratio * this.blocks.length),
      this.blocks.length - 1,
    );
  }

  // Putting the reader back after a change they did not ask for.
  //
  // Unlike restore(), this never falls back to a proportional guess, and
  // answers -1 for "stay exactly where you are": if what they were reading
  // has gone, standing still is far less disorienting than being silently
  // moved somewhere proportional. Nor does it search from the top of the
  // document — block text is often not unique, so the first match can be
  // thousands of blocks from where the reader actually is.
  //
  // In order: the arithmetic answer, which is right whenever the page
  // rewrote one contiguous region and is the only thing that gets a ticking
  // clock right; then the element itself; then the nearest matching text,
  // searched outward; then the surroundings alone.
  reanchor(anchor, previousTexts = null) {
    if (!anchor) return { block: -1, exact: false };

    if (previousTexts) {
      const remap = remapIndex(previousTexts, this.texts(), anchor.block);
      if (remap.exact) return { block: remap.index, exact: true };
    }

    if (anchor.identity != null) {
      const found = this.blocks.findIndex((b) => identityOf(b) === anchor.identity);
      // Node numbering comes from walk order, so inserting an element earlier
      // in the document renumbers everything after it and the same number can
      // name a different node. Trust the match only when a second signal
      // agrees: the text is unchanged, or it is somewhere plausibly nearby.
      if (found >= 0) {
        const sameText = this.blocks[found].text === anchor.text;
        if (sameText || Math.abs(found - anchor.block) <= REANCHOR_WINDOW) {
          return { block: found, exact: false };
        }
      }
    }

    const start = Math.min(Math.max(anchor.block, 0), Math.max(this.blocks.length - 1, 0));

    // How much of the remembered neighbourhood a candidate still agrees with.
    const contextScore = (index) => {
      let score = 0;
      for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
        if (offset === 0) continue;
        const expected = anchor.context[offset + CONTEXT_RADIUS];
        if (expected && expected === this.blockText(index + offset)) score += 1;
      }
      return score;
    };

    // Searched outward from where they were, so the nearest of several
    // identical blocks wins, with context breaking the tie.
    const search = (accept) => {
      let best = null;
      for (let distance = 0; distance <= REANCHOR_WINDOW; distance += 1) {
        const candidates = distance === 0 ? [start] : [start - distance, start + distance];
        for (const index of candidates) {
          if (index < 0 || index >= this.blocks.length) continue;
          const score = accept(index);
          if (score == null) continue;
          if (!best || score > best.score) best = { index, score };
          if (best.score === CONTEXT_RADIUS * 2) return best;
        }
      }
      return best;
    };

    const byText = search((index) => (
      this.blocks[index].text === anchor.text ? contextScore(index) : null));
    if (byText) return { block: byText.index, exact: false };

    // Nothing matched by text — which is the normal case for a block whose
    // own content is what changed. A clock rewrites itself every second, so
    // its text is never the text we anchored on, yet its neighbours are
    // unchanged. Locate it by surroundings alone, ignoring the centre.
    const MIN_CONTEXT_SCORE = 3;
    const byContext = search((index) => {
      const score = contextScore(index);
      return score >= MIN_CONTEXT_SCORE ? score : null;
    });
    if (byContext) return { block: byContext.index, exact: false };

    return { block: -1, exact: false };
  }

  // The element behind an item, in whichever view produced it. The two views
  // built from a DOM walk keep their own page-side node array and are
  // resolved through it; the accessibility tree is resolved by the driver,
  // in the frame the item came from.
  async handleFor(item, page = this.page) {
    if (DOM_SOURCES.has(this.source)) return domElementHandle(page, item);
    if (this.source === 'render') return renderElementHandle(page, item);
    const scope = item.frame || page;
    return this.driver.axElementHandle(scope, item);
  }

  // The DOM's own default action, rather than a mouse-coordinate click: a
  // blind user has no viewport, and legitimate targets (skip links, visually
  // hidden controls) sit off-screen. The click is still aimed where a mouse
  // would land — see click.js — since a site is free to listen below the
  // control it labelled.
  async activate(item, page = this.page) {
    if (DOM_SOURCES.has(this.source)) {
      return { how: 'dom', status: await activateDomItem(page, item) };
    }
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating element');
    await withTimeout(Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      handle.evaluate(clickThrough),
    ]), ACTION_TIMEOUT_MS, 'Activating');
    return { how: 'default-action', status: null };
  }

  canRealClick() {
    return typeof this.driver.realClick === 'function';
  }

  // A click the browser accounts a person's, at real coordinates, carrying
  // user activation. Refuses rather than guesses when the element cannot be
  // brought somewhere a mouse could reach it.
  async realClick(item, page = this.page) {
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating element');

    const ready = await withTimeout(
      handle.evaluate(prepareRealClick), ACTION_TIMEOUT_MS, 'Bringing it on screen');
    if (!ready || !ready.ok) {
      return { ok: false, reason: ready ? ready.reason : 'could not be found on the page' };
    }

    await withTimeout(Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      this.driver.realClick(item.frame || page, handle, { timeoutMs: ACTION_TIMEOUT_MS }),
    ]), ACTION_TIMEOUT_MS, 'Clicking');
    return { ok: true };
  }

  // The href of the element we are about to activate, so a fragment link can
  // be followed even when the page cancels the click and handles it in
  // script — in which case the URL never changes and there is nothing else
  // to go on.
  async fragmentOf(item, page = this.page) {
    let href = null;
    if (DOM_SOURCES.has(this.source)) {
      href = item.attrs && item.attrs.href;
    } else {
      try {
        const handle = await withTimeout(
          this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating link');
        href = await handle.evaluate((el) => el.getAttribute('href'));
      } catch {
        return null;
      }
    }
    if (!href || !href.startsWith('#') || href.length < 2) return null;
    return decodeURIComponent(href.slice(1));
  }

  // Which block a fragment points at, found through the text at the target:
  // the buffer has no ids in it, and the anchor itself is usually an empty
  // element with nothing to match on.
  async blockAtFragment(hash, page = this.page) {
    const snippet = await page.evaluate(TEXT_AT_FRAGMENT, hash).catch(() => null);
    if (!snippet) return -1;
    return findBlockWithText(this.blocks, snippet);
  }
}

module.exports = {
  Core, ActionTimeout, withTimeout, readFieldState, ACTION_TIMEOUT_MS,
  REANCHOR_WINDOW, CONTEXT_RADIUS,
  ALL_SOURCES, SOURCE_LABELS, DOM_SOURCES,
  snapshotBlocks, identityOf, diffBlocks, soleBlockContaining, findBlockWithText,
  sameDocumentFragment,
};
