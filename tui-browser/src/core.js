'use strict';

const { snapshotFrameTree } = require('./frames');
const { armRenderedFrames, createLiveState, installLive, collect, INPUT_GRACE_MS } = require('./live');
const { activateDomItem, domElementHandle } = require('./dom');
const { clickThrough, prepareRealClick } = require('./click');
const { renderElementHandle } = require('./render_html');
const { remapIndex } = require('./remap');
const { claimTab } = require('./session');
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

// How long something that changed stays worth being told about, how many such
// places are remembered, and what separates news from a thing that simply
// ticks.
//
// The last is the one that matters. Every path used to *replace* the record
// of what had changed, so a clock rewriting itself once a second erased the
// fact that a menu had opened at the other end of the page — press c and you
// went to the clock, every time, for ever. A block that has changed this many
// times inside this window is a clock, a countdown or a view counter: it goes
// on being patched and goes on being readable, it just stops being reported
// as news.
const CHANGE_MEMORY_MS = 60000;
const CHANGE_LIMIT = 20;
const TICKER_WINDOW_MS = 10000;
const TICKER_REPEATS = 3;

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
// What a page itself is given: longer, because a load is allowed to take
// longer than a control is allowed to take to answer.
const OPERATION_TIMEOUT_MS = 8000;
const NAVIGATION_TIMEOUT_MS = 20000;

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
// Reaching the end of a feed
// ---------------------------------------------------------------------------

// How long to wait for a feed to answer, when scrolling actually took us
// somewhere new and a fetch is plausible. Long enough for a slow connection.
const LOAD_MORE_TIMEOUT_MS = 2500;
// How long when it did not — we were already at the bottom, so whatever a
// scroll was going to trigger has had its chance. Waiting the full time here
// is what makes the end of an ordinary page feel like a hang.
const LOAD_MORE_SETTLED_MS = 800;

const SCROLL_TO_BOTTOM = () => {
  const root = document.scrollingElement || document.documentElement;
  const targets = [];
  if (root.scrollHeight > root.clientHeight + 50) targets.push(root);

  // Plenty of feeds scroll an inner container rather than the document, and
  // scrolling the document then does nothing at all. Find the tallest one
  // that actually scrolls. The cheap size test comes first so that style
  // resolution — the expensive half — runs on a handful of elements rather
  // than every element on the page.
  let best = null;
  for (const el of document.querySelectorAll('*')) {
    if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
    if (!best || el.scrollHeight > best.scrollHeight) best = el;
  }
  if (best && best !== root) targets.push(best);

  // Where everything was, so a scroll that gained nothing can be undone.
  window[Symbol.for('tweb.scroll')] = targets.map((el) => ({ el, top: el.scrollTop }));

  let moved = false;
  for (const el of targets) {
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    if (el.scrollTop !== before) moved = true;
  }

  // Which element was actually scrolled, in a form a log can carry. When a
  // feed does not respond on a real site, the first question is always
  // whether we scrolled the thing the feed is in.
  const name = (el) => {
    if (!el || el === root) return 'document';
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  return {
    elements: document.getElementsByTagName('*').length,
    // Nothing on the page scrolls, so no amount of waiting will produce
    // anything: this is the end of the page and we can say so at once.
    scrollable: targets.length > 0,
    moved,
    target: targets.map(name).join(' + ') || 'nothing',
  };
};

// Scrolling is not free of consequences even when it gains nothing. Sent to
// the bottom of a Wikipedia article, the sticky table of contents collapses
// and the page loses 216 lines — content the reader had and did not ask to
// give up. So a scroll that produced nothing is put back.
const RESTORE_SCROLL = () => {
  const undo = window[Symbol.for('tweb.scroll')];
  if (!undo) return false;
  for (const entry of undo) {
    try { entry.el.scrollTop = entry.top; } catch { /* detached since */ }
  }
  window[Symbol.for('tweb.scroll')] = null;
  return true;
};

// ---------------------------------------------------------------------------

class Core {
  constructor({ driver, page, source, sources, browserPort = null }) {
    this.driver = driver;
    this.page = page;
    this.browserPort = browserPort;
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
    // How often each place has changed lately, so a ticker can be told from
    // news. Keyed by block index, which holds still for as long as only text
    // is being replaced — which is exactly the case this is about.
    this.tickers = new Map();
    // An open dropdown, whose entries are spliced into the block list under
    // the control they belong to. See openChooser().
    this.chooser = null;
    // The popup the reader has open, if any, named by the id its control
    // points at. See relocatePopup().
    this.popup = null;
    this.snapshotCostMs = 0;
    // When the page last changed under us, whether a refresh is owed, how
    // recently the reader touched anything. The rules that read it live in
    // live.js; what is here is the orchestration those rules drive.
    this.live = createLiveState();
    // What the page looked like the last time asking it for more produced
    // nothing. See noMoreToLoad().
    this.exhausted = null;
  }

  // Whether asking this page for more has already been tried and answered no.
  //
  // Without this, every press of the down key at the last line paid the full
  // scroll-and-wait again — measured at 2.5 seconds per keypress, for ever,
  // on any page at all. The trap is that "can this page scroll" is nearly
  // always yes: a document taller than the window scrolls, which is most
  // documents, and it has nothing to do with whether more content exists.
  // The buffer already holds the whole document either way, because the walk
  // reads the DOM and not the viewport. Only lazily loaded content is ever at
  // stake, and the only way to find out is to try — so try once, and remember.
  //
  // The answer stops applying the moment the page is a different page or has
  // a different number of blocks in it, which covers both a navigation and a
  // feed that finally delivered something.
  noMoreToLoad() {
    return !!this.exhausted
      && this.exhausted.url === this.renderedUrl
      && this.exhausted.blocks === this.blocks.length;
  }

  // Ask the page for more content: scroll whatever scrolls to the bottom and
  // watch for elements to appear. Puts the scroll back when nothing does,
  // because scrolling is not free of consequences even when it gains nothing
  // — sent to the bottom of a Wikipedia article, the sticky table of contents
  // collapses and the page loses 216 lines the reader had and did not ask to
  // give up.
  async askForMore(page = this.page) {
    const probe = await page.evaluate(SCROLL_TO_BOTTOM);
    let grew = false;

    if (probe.scrollable) {
      try {
        await page.waitForFunction(
          (n) => document.getElementsByTagName('*').length > n,
          probe.elements,
          { timeout: probe.moved ? LOAD_MORE_TIMEOUT_MS : LOAD_MORE_SETTLED_MS, polling: 250 },
        );
        grew = true;
      } catch {
        grew = false; // nothing arrived; this really is the end
      }
    }

    if (!grew) {
      await page.evaluate(RESTORE_SCROLL).catch(() => {});
      this.exhausted = { url: this.renderedUrl, blocks: this.blocks.length };
    }
    return { grew, scrollable: probe.scrollable, moved: probe.moved, target: probe.target };
  }

  // The reader did something. Live refreshes hold off while this is recent,
  // so the buffer is never swapped mid-keystroke. Over a socket this is the
  // same one-way notification as at(): the arrival of a request is itself the
  // evidence that somebody is reading.
  markInput() {
    this.live.lastInputMs = Date.now();
  }

  // Whether the reader is close enough behind their last keystroke to be
  // owed the buffer holding still.
  reading() {
    return Date.now() - this.live.lastInputMs < INPUT_GRACE_MS;
  }

  async attachLive(page, onMutation) {
    const t0 = Date.now();
    this.onMutation = onMutation;
    const info = await installLive(page);
    return { ms: Date.now() - t0, ...info };
  }

  // Take what the observers have seen and hand it on. The page is asked
  // rather than pushing to us, so this has to be called; the reader's ticker
  // does it, on the same beat that pulses the page.
  async collectLive(page = this.page) {
    if (!this.onMutation) return 0;
    const payloads = await collect(page).catch(() => []);
    for (const payload of payloads) this.onMutation(payload);
    return payloads.length;
  }

  // What a batch of mutations means, without acting on any of it. The caller
  // gets the announcements to speak and, when the batch was nothing but text
  // replacement, the patches that might be spliced in; anything else marks
  // the buffer dirty and a whole-page refresh follows in its own time.
  classify(payload) {
    if (!payload) return { announcements: [], patches: null };
    this.live.notifies += 1;
    const announcements = this.live.enabled ? (payload.announcements || []) : [];
    if (!this.live.enabled) return { announcements, patches: null };

    // Only while nothing else is rewriting the buffer: a refresh in flight is
    // about to replace these blocks wholesale.
    const patches = payload.pureText && !this.live.refreshing ? (payload.patches || null) : null;
    return { announcements, patches, mutations: payload.mutations || 0 };
  }

  // Everything a live rebuild is except drawing it: read the page again, work
  // out where the reader belongs in the new buffer, and record what changed.
  async rebuild(anchor, { page = this.page, keepPlace = true } = {}) {
    const previousTexts = this.texts();
    await this.rescan({ page });
    const settled = keepPlace
      ? this.reanchor(anchor, previousTexts)
      : { block: -1, exact: false };
    const regions = this.recordChanges(diffBlocks(previousTexts, this.blocks));
    return { settled, regions, previousTexts };
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
    // Every re-read puts a portaled popup back at the end of the document,
    // so every re-read has to bring it back.
    this.relocatePopup();
    this.snapshotCostMs = Date.now() - started;
    return this.blocks;
  }

  setView(source) {
    this.source = source;
    // A different view numbers its blocks differently, so what was known
    // about which of them tick means nothing here.
    this.tickers.clear();
    this.changes = [];
    this.changeIndex = -1;
  }

  // Whether this place has changed often enough lately to be a ticker rather
  // than news.
  ticking(index, now) {
    const entry = this.tickers.get(index);
    const fresh = entry && now - entry.last <= TICKER_WINDOW_MS
      ? { count: entry.count + 1, last: now }
      : { count: 1, last: now };
    this.tickers.set(index, fresh);
    return fresh.count > TICKER_REPEATS;
  }

  // Add to what is known to have changed, rather than replacing it. Returns
  // only what was worth reporting, which is what the reader is told about.
  //
  // Each entry remembers its text as well as its position, because the next
  // rebuild renumbers everything; the position is where to start looking and
  // the text is what to look for. See changeTargets().
  recordChanges(regions) {
    const now = Date.now();
    const news = [];
    for (const region of regions) {
      if (this.ticking(region.start, now)) continue;
      news.push({
        start: region.start,
        end: region.end,
        text: this.blockText(region.start),
        at: now,
      });
    }
    if (!news.length) return [];

    const superseded = new Set(news.map((entry) => entry.text));
    this.changes = this.changes
      .filter((entry) => !superseded.has(entry.text) && now - entry.at < CHANGE_MEMORY_MS)
      .concat(news)
      .slice(-CHANGE_LIMIT);
    this.changeIndex = -1;
    return news;
  }

  noteChanges(previousTexts) {
    return this.recordChanges(diffBlocks(previousTexts, this.blocks));
  }

  // The nearest block to `start` whose text still matches, or -1.
  findNear(start, text) {
    if (!this.blocks.length) return -1;
    const from = Math.min(Math.max(start, 0), this.blocks.length - 1);
    for (let distance = 0; distance < this.blocks.length; distance += 1) {
      for (const index of (distance === 0 ? [from] : [from - distance, from + distance])) {
        if (index < 0 || index >= this.blocks.length) continue;
        if (this.blocks[index].text === text) return index;
      }
    }
    return -1;
  }

  // Everywhere worth going, in document order, resolved against the buffer as
  // it stands now. Entries whose text is nowhere to be found have been
  // overwritten again since, and are dropped rather than pointing somewhere
  // arbitrary.
  changeTargets() {
    const now = Date.now();
    const out = [];
    for (const entry of this.changes) {
      if (now - entry.at >= CHANGE_MEMORY_MS) continue;
      const block = this.findNear(entry.start, entry.text);
      if (block < 0) continue;
      out.push({ block, size: entry.end - entry.start + 1, at: entry.at });
    }
    out.sort((a, b) => a.block - b.block);
    return out;
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

  // -------------------------------------------------------------------------
  // Tabs
  //
  // Which tabs exist, which one is ours, and taking one over. What a tab
  // switch then *means* — that the buffer describes a different document now,
  // so there is no place to keep — is decided by whoever asked for it.
  // -------------------------------------------------------------------------

  tabs() {
    return this.driver.listTabs().filter((page) => {
      try { return !page.isClosed(); } catch { return true; }
    });
  }

  async tabLabel(page) {
    try {
      const title = await page.title();
      if (title) return title.replace(/\s+/g, ' ').trim().slice(0, 60);
    } catch { /* closed or navigating */ }
    try {
      return page.url().slice(0, 60);
    } catch {
      return 'untitled';
    }
  }

  // Whether this tab is the one the browser is actually showing. A background
  // tab reports itself hidden, which is the same answer in both engines and
  // needs no protocol support of its own.
  async isForeground(page) {
    try {
      return await page.evaluate(() => document.visibilityState === 'visible');
    } catch {
      return false;
    }
  }

  where(page = this.page) {
    const tabs = this.tabs();
    return { position: tabs.indexOf(page) + 1, of: tabs.length };
  }

  // The tab `>` or `<` would move to, or null when there is only one.
  nextTab(direction) {
    const tabs = this.tabs();
    if (tabs.length < 2) return null;
    const current = tabs.indexOf(this.page);
    const from = current < 0 ? 0 : current;
    return tabs[(from + direction + tabs.length) % tabs.length];
  }

  // The tab closing would leave you on: the one `>` would have taken you to,
  // so closing repeatedly walks forward rather than doubling back.
  tabAfter(page) {
    const tabs = this.tabs();
    if (tabs.length < 2) return null;
    const index = tabs.indexOf(page);
    return tabs[((index < 0 ? 0 : index) + 1) % tabs.length];
  }

  // Take a tab as ours. The claim moves with us, so another reader knows
  // which tab is ours now and stops avoiding the one we left.
  async adoptTab(page) {
    const targetId = await this.driver.targetIdFor(page).catch(() => null);
    if (targetId && this.browserPort != null) claimTab(this.browserPort, targetId);
    page.setDefaultTimeout(OPERATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    this.page = page;
    return targetId;
  }

  async closeTab(page) {
    await withTimeout(page.close(), ACTION_TIMEOUT_MS, 'Closing the tab');
  }

  // -------------------------------------------------------------------------
  // Popups that are not where their control is
  //
  // A menu or listbox is very often rendered into the end of <body> rather
  // than next to the button that opens it — a "portal", done so that no
  // ancestor's overflow or stacking can clip it. On a screen that is
  // invisible: the menu appears under the mouse. In a line list it is
  // catastrophic, because the reader presses a button and the thing they
  // asked for appears hundreds of lines below them with nothing to say it is
  // theirs. Re-reading the page finds it; it does not help them reach it.
  //
  // So it is moved. ax_own.js tags everything inside a popup with the id its
  // control points at, and this puts those blocks back where the reader is
  // standing. Nothing about the page changes — this is the buffer's reading
  // order, which is the only thing here that was ever the reader's.
  // -------------------------------------------------------------------------

  // Start following a popup. Deliberately does not move anything yet: this is
  // called the moment the control is pressed, when the buffer still describes
  // the page as it was before, and the popup it names does not exist in it.
  // The next read is what finds it.
  followPopup(controls) {
    this.popup = controls ? { controls } : null;
    return this.popup;
  }

  forgetPopup() {
    this.popup = null;
  }

  // Move the open popup's blocks to sit directly after the control that owns
  // them. Answers how many blocks moved, and forgets the popup when the page
  // has closed it.
  relocatePopup() {
    const id = this.popup && this.popup.controls;
    if (!id) return 0;

    const owned = [];
    let control = -1;
    this.blocks.forEach((block, index) => {
      const item = block.item;
      if (!item) return;
      if (item.popup === id) owned.push(index);
      else if (item.controls === id) control = index;
    });

    if (!owned.length) {
      // Nothing of it in the buffer. That is either "the page has closed it",
      // which the control will say, or "we have not read the page since it
      // opened", which is the ordinary case one read after pressing — and
      // forgetting on that would mean never finding it at all.
      const closed = control >= 0 && this.blocks[control].item.expanded === false;
      if (closed || control < 0) this.popup = null;
      return 0;
    }
    if (control < 0) return 0;
    // Already in the right place: the popup is not portaled on this page, or
    // we moved it on a previous read.
    if (owned[0] === control + 1) return 0;

    const moved = owned.map((index) => this.blocks[index]);
    for (let i = owned.length - 1; i >= 0; i -= 1) this.blocks.splice(owned[i], 1);
    const before = owned.filter((index) => index < control).length;
    this.blocks.splice(control - before + 1, 0, ...moved);
    return moved.length;
  }

  // Where the open popup's entries begin, or -1.
  popupAt() {
    const id = this.popup && this.popup.controls;
    if (!id) return -1;
    return this.blocks.findIndex((block) => block.item && block.item.popup === id);
  }

  // -------------------------------------------------------------------------
  // Dropdowns
  //
  // A native <select> is not a text field and never was, and the popup it
  // opens is drawn by the browser rather than by the page — no click can
  // reach it and no amount of walking the DOM will find it. What *is* in the
  // DOM is the list of options, all of it, always. So there is nothing to
  // open: the entries are read straight off the element and spliced into the
  // buffer underneath the control, where they can be moved through and
  // filtered like anything else the reader can see.
  // -------------------------------------------------------------------------

  // The entries of a native select, or null if this item is not one.
  async optionsFor(item, page = this.page) {
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating the control');
    return handle.evaluate((el) => {
      if (!el || el.tagName !== 'SELECT') return null;
      return {
        multiple: !!el.multiple,
        selectedIndex: el.selectedIndex,
        options: Array.from(el.options).map((option) => ({
          text: (option.textContent || '').replace(/\s+/g, ' ').trim() || option.value,
          disabled: !!option.disabled,
          selected: !!option.selected,
        })),
      };
    });
  }

  // Choose the nth entry, in the one way that is both exact and trusted.
  //
  // Every obvious route is wrong. Clicking the option cannot work: measured
  // on both engines, an <option> of a closed select has no box to click and
  // the attempt times out, because the open popup is browser chrome rather
  // than page content. Setting `selected` and dispatching the events by hand
  // works but the page can see they are not a person's. Typing the entry's
  // name cannot express which entry is meant — "United States" is a strict
  // prefix of "United States Minor Outlying Islands" — and a widget built on
  // a framework has no key handler to type at in the first place. Walking
  // there with arrow keys is trusted and exact, but a closed select fires a
  // change event for every entry passed on the way: measured at forty change
  // events to move forty places, which on a country field that reloads its
  // region list is forty page loads.
  //
  // What works is to move silently to the entry *next to* the target — a
  // script assignment fires nothing at all — and then send one real arrow
  // key. Measured on Chromium and on Firefox: the page sees exactly one
  // input and one change, both trusted, carrying the right value.
  async chooseOption(item, index, page = this.page) {
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating the control');

    const key = await handle.evaluate((el, target) => {
      if (!el || el.tagName !== 'SELECT') return null;
      el.focus();
      if (el.selectedIndex === target) return 'already';
      // Land next to it, from whichever side exists, and let the real key
      // make the move the page is told about.
      el.selectedIndex = target > 0 ? target - 1 : target + 1;
      return target > 0 ? 'ArrowDown' : 'ArrowUp';
    }, index);

    if (key === null) return { changed: false, reason: 'not a select' };
    if (key === 'already') return { changed: false, reason: 'already chosen' };
    await page.keyboard.press(key);
    return { changed: true };
  }

  // Splice a dropdown's entries into the buffer under its control. They are
  // ordinary blocks from here on, so moving through them, wrapping them and
  // finding text in them all work without knowing anything about dropdowns.
  openChooser(blockIndex, listing) {
    this.closeChooser();
    this.chooser = {
      blockIndex,
      at: blockIndex + 1,
      count: 0,
      filter: '',
      shown: [],
      options: listing.options,
      multiple: listing.multiple,
    };
    this.showChooser();
    return this.chooser;
  }

  // (Re)draw the entries, honouring the filter. Filtering happens here and
  // never at the page: these are our lines, and typing at the control would
  // reach a widget that may have no key handler at all.
  showChooser(filter = null) {
    const chooser = this.chooser;
    if (!chooser) return 0;
    if (filter !== null) chooser.filter = filter;
    if (chooser.count) this.blocks.splice(chooser.at, chooser.count);

    const needle = chooser.filter.trim().toLowerCase();
    const shown = [];
    const blocks = [];
    chooser.options.forEach((option, index) => {
      if (needle && !option.text.toLowerCase().includes(needle)) return;
      shown.push(index);
      blocks.push({
        text: `    ${option.selected ? '(*)' : '( )'} ${option.text}`
          + (option.disabled ? ' — unavailable' : ''),
        item: { role: 'option', name: option.text, chooserIndex: index, disabled: option.disabled },
      });
    });

    this.blocks.splice(chooser.at, 0, ...blocks);
    chooser.count = blocks.length;
    chooser.shown = shown;
    return blocks.length;
  }

  closeChooser() {
    if (this.chooser && this.chooser.count) this.blocks.splice(this.chooser.at, this.chooser.count);
    this.chooser = null;
  }

  // Whether a block index is one of the open dropdown's entries.
  inChooser(blockIndex) {
    const chooser = this.chooser;
    return !!chooser && blockIndex >= chooser.at && blockIndex < chooser.at + chooser.count;
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

  // How much of the remembered neighbourhood a candidate still agrees with.
  contextScore(index, anchor) {
    let score = 0;
    for (let offset = -CONTEXT_RADIUS; offset <= CONTEXT_RADIUS; offset += 1) {
      if (offset === 0) continue;
      const expected = anchor.context[offset + CONTEXT_RADIUS];
      if (expected && expected === this.blockText(index + offset)) score += 1;
    }
    return score;
  }

  // Searched outward from where the reader was, so the nearest of several
  // identical blocks wins and context breaks the tie. `accept` returns a
  // score, or null for "not a candidate at all".
  //
  // Outward rather than from the top is the whole point. Block text repeats
  // constantly — two buttons both called "Open", a page of <option value=30>
  // — and the first match from the top can be the length of the document away
  // from the one the reader was actually standing on.
  searchOutward(start, accept, window = REANCHOR_WINDOW) {
    let best = null;
    for (let distance = 0; distance <= window; distance += 1) {
      const candidates = distance === 0 ? [start] : [start - distance, start + distance];
      let anyInRange = false;
      for (const index of candidates) {
        if (index < 0 || index >= this.blocks.length) continue;
        anyInRange = true;
        const score = accept(index);
        if (score == null) continue;
        if (!best || score > best.score) best = { index, score };
        if (best.score === CONTEXT_RADIUS * 2) return best;
      }
      // Both ends have run off the buffer; nothing further to visit.
      if (!anyInRange && distance > 0) break;
    }
    return best;
  }

  // Putting the reader back after a change they asked for — a view switch, a
  // refresh they pressed for, the page redrawing after they pressed
  // something. Always answers with somewhere, falling back to the same
  // proportion of a buffer whose block count may be wildly different, because
  // the reader asked for this and has to arrive somewhere.
  //
  // The search spans the whole buffer, because they asked and it must find
  // the thing if the thing is there — but it still runs outward from where
  // they were, so that of two blocks reading exactly the same it chooses the
  // one they were standing on rather than the first one on the page.
  restore(anchor) {
    if (!anchor || !this.blocks.length) return 0;
    const needle = (anchor.name || anchor.text || '').trim();
    const start = Math.min(Math.max(anchor.block, 0), this.blocks.length - 1);
    const whole = this.blocks.length;

    if (needle) {
      const exact = this.searchOutward(start,
        (i) => (this.blocks[i].text === anchor.text ? this.contextScore(i, anchor) : null), whole);
      if (exact) return exact.index;

      const partial = this.searchOutward(start,
        (i) => (this.blocks[i].text.includes(needle) ? this.contextScore(i, anchor) : null), whole);
      if (partial) return partial.index;
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

    // Matching a single block is not enough when the text repeats — a page of
    // <option value=30> entries offers dozens of equally good candidates. The
    // neighbours disambiguate: the right one sits in the same surroundings it
    // did before.
    const byText = this.searchOutward(start, (index) => (
      this.blocks[index].text === anchor.text ? this.contextScore(index, anchor) : null));
    if (byText) return { block: byText.index, exact: false };

    // Nothing matched by text — which is the normal case for a block whose
    // own content is what changed. A clock rewrites itself every second, so
    // its text is never the text we anchored on, yet its neighbours are
    // unchanged. Locate it by surroundings alone, ignoring the centre.
    const MIN_CONTEXT_SCORE = 3;
    const byContext = this.searchOutward(start, (index) => {
      const score = this.contextScore(index, anchor);
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
    if (item.pressFrame) return this.pressFrame(item);
    if (item.nativeControl && typeof this.driver.activateNativeControl === 'function') {
      const scope = item.frame || page;
      const pressed = await this.driver.activateNativeControl(scope, item);
      return {
        how: 'native-control',
        status: pressed ? null : `The browser's ${item.name} control is no longer visible.`,
      };
    }
    if (DOM_SOURCES.has(this.source)) {
      return { how: 'dom', status: await activateDomItem(page, item) };
    }

    // Something behind a closed shadow root gets a real click rather than the
    // DOM's own default action. A closed shadow root is what a bot check is
    // built out of, and a challenge does not care what the DOM would have
    // done — it wants to know a person pressed it. Falling back if the click
    // cannot be placed, because that is still better than nothing and the
    // reader can be told why.
    if (item.pierced && this.canRealClick()) {
      const clicked = await this.realClick(item, page).catch(() => null);
      if (clicked && clicked.ok) return { how: 'real-click', status: null };
    }
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating element');
    return this.activateHandle(handle, page);
  }

  // The acting half, once something has been resolved to an element. Split
  // out because not every front end finds its elements the same way: the
  // reader resolves an accessibility item, the edbrowse server resolves a
  // descriptor it handed out in a form. What happens next is the same, and
  // so are the bounds on how long it may take.
  async activateHandle(handle, page = this.page) {
    await withTimeout(Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      handle.evaluate(clickThrough),
    ]), ACTION_TIMEOUT_MS, 'Activating');
    return { how: 'default-action', status: null };
  }

  // Press into a document we cannot read.
  //
  // Content behind a closed shadow root is unreachable by any means the page
  // offers, and on Firefox unreachable by any means at all — but hit testing
  // does not care about shadow boundaries, so a real pointer action aimed at
  // the frame lands on whatever is drawn there. It is aimed at the middle,
  // because there is nothing to aim at more precisely: we cannot see what is
  // in it. That is a poor substitute for reading it and it is a great deal
  // better than a reader stuck at a bot check with nothing to press.
  async pressFrame(item, page = this.page) {
    const frame = item.pressFrame;
    if (!frame || typeof this.driver.clickInFrame !== 'function') {
      return { how: 'frame', status: `Cannot reach into ${item.name} with this browser.` };
    }
    const size = await frame.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
      .catch(() => null);
    if (!size || !size.w || !size.h) {
      return { how: 'frame', status: `${item.name} has nothing on screen to press.` };
    }
    await withTimeout(
      this.driver.clickInFrame(frame, size.w / 2, size.h / 2), ACTION_TIMEOUT_MS, 'Pressing the frame');
    return { how: 'frame', status: `Pressed the middle of ${item.name}.` };
  }

  canRealClick() {
    return typeof this.driver.realClick === 'function';
  }

  // A click the browser accounts a person's, at real coordinates, carrying
  // user activation. Refuses rather than guesses when the element cannot be
  // brought somewhere a mouse could reach it.
  async realClick(item, page = this.page) {
    if (item.nativeControl && typeof this.driver.activateNativeControl === 'function') {
      const pressed = await this.driver.activateNativeControl(item.frame || page, item);
      return {
        ok: !!pressed,
        reason: pressed ? null : `the browser's ${item.name} control is no longer visible`,
      };
    }
    const handle = await withTimeout(
      this.handleFor(item, page), ACTION_TIMEOUT_MS, 'Locating element');
    return this.realClickHandle(handle, page, item.frame || page);
  }

  // As activateHandle: the acting half, for whoever already has the element.
  async realClickHandle(handle, page = this.page, scope = null) {
    const ready = await withTimeout(
      handle.evaluate(prepareRealClick), ACTION_TIMEOUT_MS, 'Bringing it on screen');
    if (!ready || !ready.ok) {
      return { ok: false, reason: ready ? ready.reason : 'could not be found on the page' };
    }

    await withTimeout(Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      this.driver.realClick(scope || page, handle, { timeoutMs: ACTION_TIMEOUT_MS }),
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
  Core, ActionTimeout, withTimeout, readFieldState,
  ACTION_TIMEOUT_MS, OPERATION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS,
  REANCHOR_WINDOW, CONTEXT_RADIUS,
  ALL_SOURCES, SOURCE_LABELS, DOM_SOURCES,
  snapshotBlocks, identityOf, diffBlocks, soleBlockContaining, findBlockWithText,
  sameDocumentFragment,
};
