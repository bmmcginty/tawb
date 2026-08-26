'use strict';

const { log } = require('./log');

// Keeping the reader's place when the view changes.
//
// The four views describe the same page in four completely different line
// lists — 135 lines of accessibility tree against 1500 of markup on the same
// album page — so a line number means nothing across a switch. Matching the
// text does not work either, because the views do not render the same thing:
// a play button that reads `[*Play Weird Fish]` in the accessibility tree is
// paired with `<a aria-label=Play Weird Fish>` in INSPECT and, in SOURCE, an
// `<a role="button" aria-label="Play Weird Fish">` several lines away from
// the `<div class="playbutton">` inside it. Matching on the item's *name* is
// worse still: in the DOM-derived views a name is often just the tag, so
// "keep me on this line" degenerated into "find the first line containing
// the letter a", which is line one of the page.
//
// What all four views do have in common is the element each line came from.
// Their extractors stash those elements page-side because that is how a line
// is activated later; AX and INSPECT share the accessibility extractor's
// references. So a place is an element, not a line: ask
// the view we are leaving which element the reader is on, then ask the view
// we are entering which of its lines that element produced.
//
// Two things stop that being the whole story:
//
//   Prose has no element of its own in most views — it is a text node, and
//   the views number elements. The nearest element above the cursor is used
//   as the anchor and the reader's own line is then found again by its text,
//   searching down from where that element landed rather than from the top
//   of the document, which is what makes repeated text harmless.
//
//   Some semantic lines, such as generated text, carry no element reference.
//   Entering one falls back to the nearest element's label and, where several
//   lines match, to the one nearest its position in document order. That is a
//   guess, but not line-number arithmetic between lists of different lengths.

// Where each view stashes the elements its lines came from, and the property
// on an item that indexes into it.
//
// Named by symbol rather than by a plain property, here and everywhere else
// this program keeps something on a page's window. A string property is
// listed by Object.keys, by for...in and by getOwnPropertyNames, so anything
// we leave behind is there to be found by name — and the documents this
// program most needs to be unremarkable in are the ones looking hardest.
const NODE_ARRAY = {
  render: 'tweb.render',
  source: 'tweb.dom',
  ax: 'tweb.ax',
  inspect: 'tweb.ax',
};
const INDEX_KEY = {
  render: 'renderIndex', source: 'domIndex', ax: 'axIndex', inspect: 'axIndex',
};

// How far back to look for an element to anchor to when the cursor is on
// prose, and how far down from it to look for the prose again afterwards. A
// run of text between two elements is short; a paragraph that needs 400 lines
// of markup to describe it is not, which is the direction the numbers have to
// cover.
const LOOKBACK_BLOCKS = 200;
const REFINE_LINES = 400;
// Short strings match everywhere, so a partial match is only trusted from
// something long enough to mean something.
const MIN_NEEDLE = 4;

// Runs in the page against the element the reader is on. `ordinal` is its
// position in document order, which is the one number that means the same
// thing in every view.
function describeElement(el) {
  if (!el || !el.tagName) return null;
  const attr = (name) => (el.getAttribute && el.getAttribute(name)) || '';
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const all = el.ownerDocument.getElementsByTagName('*');
  const ordinal = Array.prototype.indexOf.call(all, el);
  return {
    label: attr('aria-label') || attr('alt') || attr('title') || text.slice(0, 200)
      || attr('placeholder') || attr('name') || '',
    ordinal: ordinal >= 0 ? ordinal : null,
    total: all.length,
  };
}

// Runs in the page after the new view has been built: which entry of that
// view's node array is this element?
//
// An element can be missing from the view being entered — PAGE lists only
// visible content, while AX and INSPECT skip semantically empty containers —
// so the answer is allowed to be an ancestor of it, and failing that the
// nearest entry above it in document order. Landing just before where the
// reader was is a much smaller move than landing wherever the text happened
// to match first.
function locateElement({ el, arrayName }) {
  const nodes = window[Symbol.for(arrayName)];
  if (!nodes || !nodes.length || !el) return null;

  const positions = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    if (!positions.has(nodes[i])) positions.set(nodes[i], i);
  }

  for (let node = el; node; node = node.parentElement) {
    const found = positions.get(node);
    if (found != null) return { index: found, exact: node === el };
  }

  const all = document.getElementsByTagName('*');
  const order = new Map();
  for (let i = 0; i < all.length; i += 1) order.set(all[i], i);
  const target = order.get(el);
  if (target == null) return null;

  let best = null;
  for (let i = 0; i < nodes.length; i += 1) {
    const at = order.get(nodes[i]);
    if (at == null || at > target) continue;
    if (!best || at > best.at) best = { index: i, at };
  }
  return best ? { index: best.index, exact: false } : null;
}

function indexOfItem(source, item) {
  const key = INDEX_KEY[source];
  if (!key || !item) return null;
  return item[key] != null ? item[key] : null;
}

// Whether this line can be turned back into an element. Playwright's AX items
// carry no reference and are resolved by role and name instead, which needs
// both — and text is not a role anything can be found by.
function hasElement(source, item) {
  if (!item) return false;
  if (indexOfItem(source, item) != null) return true;
  return source === 'ax' && !!item.role && item.role !== 'text' && !!item.name;
}

function lineOfBlock(state, blockIndex) {
  return state.lines.findIndex((line) => line.blockIndex === blockIndex && !line.continuation);
}

function blockAtLine(state, lineIndex) {
  const line = state.lines[lineIndex];
  return line ? state.blocks[line.blockIndex] : null;
}

// The element the reader is on, or the nearest one above it, described well
// enough to be found again in a view that numbers its lines differently.
// `resolveHandle` is how the caller turns an item into an element, which is
// the one thing this module cannot know: it is per view and per engine.
async function capturePlace(state, resolveHandle) {
  const line = state.lines[state.cursor];
  if (!line) return null;

  const block = state.blocks[line.blockIndex];
  const place = {
    source: state.source,
    text: block ? block.text : '',
    col: state.col || 0,
    ratio: state.lines.length ? state.cursor / state.lines.length : 0,
    handle: null,
    frame: null,
    onElement: false,
    label: '',
    ordinal: null,
    total: null,
  };

  let anchor = null;
  for (let i = line.blockIndex; i >= 0 && line.blockIndex - i <= LOOKBACK_BLOCKS; i -= 1) {
    if (hasElement(state.source, state.blocks[i].item)) { anchor = state.blocks[i]; break; }
  }
  if (!anchor) return place;

  try {
    const handle = await resolveHandle(anchor.item);
    if (!handle) return place;
    const described = await handle.evaluate(describeElement);
    if (!described) {
      await handle.dispose().catch(() => {});
      return place;
    }
    place.handle = handle;
    place.frame = anchor.item.frame || null;
    place.onElement = anchor === block;
    Object.assign(place, described);
  } catch {
    // No reference to be had. The text fallbacks still apply.
  }
  return place;
}

// Puts the cursor on the line that block produced, then — when the reader was
// on prose rather than on the element itself — looks down from there for the
// text they were actually reading.
function landOn(state, blockIndex, place, exactElement) {
  const line = lineOfBlock(state, blockIndex);
  if (line < 0) return null;

  if (place.onElement) {
    state.cursor = line;
    state.col = sameLineText(state, line, place) ? place.col : 0;
    return exactElement ? 'exact' : 'near';
  }

  const refined = refineToText(state, line, place);
  state.cursor = refined.line;
  state.col = refined.col;
  return exactElement && refined.exact ? 'exact' : 'near';
}

function sameLineText(state, lineIndex, place) {
  const block = blockAtLine(state, lineIndex);
  return !!block && block.text === place.text;
}

function refineToText(state, from, place) {
  const wanted = (place.text || '').trim();
  if (!wanted) return { line: from, col: 0, exact: false };

  const limit = Math.min(state.lines.length, from + REFINE_LINES);
  for (let i = from; i < limit; i += 1) {
    const line = state.lines[i];
    if (line.continuation) continue;
    if (state.blocks[line.blockIndex].text === place.text) {
      return { line: i, col: Math.min(place.col, Math.max(line.text.length - 1, 0)), exact: true };
    }
  }

  if (wanted.length >= MIN_NEEDLE) {
    for (let i = from; i < limit; i += 1) {
      const line = state.lines[i];
      if (line.continuation) continue;
      const at = line.text.indexOf(wanted);
      if (at >= 0) return { line: i, col: at, exact: false };
    }
  }

  return { line: from, col: 0, exact: false };
}

async function locateByElement(state, page, place) {
  if (!place.handle) return null;
  const arrayName = NODE_ARRAY[state.source];
  if (!arrayName) return null;

  const target = place.frame || page;
  const found = await target.evaluate(locateElement, { el: place.handle, arrayName });
  if (!found) return null;

  const key = INDEX_KEY[state.source];
  const blockIndex = state.blocks.findIndex((block) => block.item
    && block.item[key] === found.index
    && (!place.frame || !block.item.frame || block.item.frame === place.frame));
  if (blockIndex < 0) return null;

  return landOn(state, blockIndex, place, found.exact);
}

// The line nearest `estimate` that satisfies `test`. Nearest, not first: text
// repeats — a page of `<div class="play-button">` offers a dozen identical
// candidates — and the one the reader wants is the one where they were.
function nearestLine(state, test, estimate) {
  let best = null;
  for (let i = 0; i < state.lines.length; i += 1) {
    const line = state.lines[i];
    if (line.continuation) continue;
    const block = state.blocks[line.blockIndex];
    if (!test(block, line)) continue;
    const distance = Math.abs(i - estimate);
    if (!best || distance < best.distance) best = { line: i, distance };
  }
  return best ? best.line : -1;
}

// For a view with no element references to match against — Playwright's
// accessibility tree — and for anything the element lookup could not place.
function locateByText(state, place) {
  if (!state.lines.length) return null;

  const fraction = place.total ? place.ordinal / place.total : place.ratio;
  const estimate = Math.round(fraction * state.lines.length);
  const text = (place.text || '').trim();
  const label = (place.label || '').trim();

  const land = (line, col, quality) => {
    state.cursor = line;
    state.col = col;
    return quality;
  };

  if (text) {
    const same = nearestLine(state, (block) => block.text === place.text, estimate);
    if (same >= 0) return land(same, place.col, 'exact');
  }

  if (label.length >= MIN_NEEDLE) {
    const named = nearestLine(
      state, (block) => block.item && String(block.item.name).trim() === label, estimate);
    if (named >= 0) return land(named, 0, 'exact');

    const within = nearestLine(state, (block) => block.text.includes(label), estimate);
    if (within >= 0) return land(within, Math.max(state.lines[within].text.indexOf(label), 0), 'near');
  }

  if (text.length >= MIN_NEEDLE) {
    const within = nearestLine(state, (block) => block.text.includes(text), estimate);
    if (within >= 0) return land(within, Math.max(state.lines[within].text.indexOf(text), 0), 'near');
  }

  if (place.total != null) {
    return land(Math.min(Math.max(estimate, 0), state.lines.length - 1), 0, 'near');
  }
  return null;
}

// Moves the cursor to wherever the captured place now is. Returns 'exact'
// when the element itself was found, 'near' when it was located by
// surroundings or by text, and null when the view has nothing to match — in
// which case the caller keeps whatever fallback it had.
async function restorePlace(state, page, place) {
  if (!place) return null;

  const started = Date.now();
  let quality = null;
  try {
    quality = await locateByElement(state, page, place);
    // An element match that had to settle for an ancestor, or for whatever
    // sits above the element in document order, is only a guess at where the
    // reader was. A line whose text is exactly what they were reading is not,
    // so it wins — but only when it is exact. Anything less and the element's
    // own neighbourhood is the better answer.
    if (quality !== 'exact') {
      const fromElement = { cursor: state.cursor, col: state.col };
      const byText = locateByText(state, place);
      if (byText !== 'exact' && quality) {
        state.cursor = fromElement.cursor;
        state.col = fromElement.col;
      } else if (byText) {
        quality = byText;
      }
    }
  } catch {
    quality = null;
  } finally {
    if (place.handle) {
      await place.handle.dispose().catch(() => {});
      place.handle = null;
    }
  }

  log('view.place', {
    from: place.source, to: state.source, quality, ms: Date.now() - started, cursor: state.cursor,
  });
  return quality;
}

module.exports = {
  capturePlace, restorePlace, describeElement, locateElement, hasElement,
  NODE_ARRAY, INDEX_KEY,
};
