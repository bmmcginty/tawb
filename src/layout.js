'use strict';

// Turns blocks into display lines, one per terminal row.
//
// Prose blocks are long, and a line that wraps would occupy several rows —
// silently breaking the row math the cursor positioning depends on, and with
// it a braille display's ability to track where it is. So we word-wrap here
// and treat each wrapped line as its own navigable row.
//
// Each line carries the character offset range it covers inside its block
// (`start`/`end`), which is what lets a caret column map back to an inline
// link span.

// A row is one terminal row, so it must not contain a control character. A
// newline written into the middle of a row moves the terminal down a line by
// itself: every row below it then sits one place lower than the buffer
// believes, and the cursor — the only thing telling a braille display where
// the reader is — lands on the wrong text.
//
// Most content cannot do this, because every view collapses whitespace as it
// extracts text. Two routes survive that: a <textarea>'s value, which is its
// live content rather than extracted text, and an attribute written across
// several lines, which SOURCE prints verbatim. Both are real, and both
// reached the screen.
//
// Newlines become row breaks, which is what they mean, and every other
// control character becomes a space. Substituting rather than deleting keeps
// each character in place, so the offsets a caret column maps through still
// point where they did.
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

function wrapSegment(text, width) {
  const out = [];
  if (width <= 0) return [{ text, start: 0, end: text.length }];

  let lineStart = 0;
  let i = 0;

  while (i < text.length) {
    // Skip leading whitespace at the start of a new line.
    while (i < text.length && text[i] === ' ') i++;
    lineStart = i;

    let breakAt = -1;
    let j = i;
    while (j < text.length && j - lineStart < width) {
      if (text[j] === ' ') breakAt = j;
      j++;
    }

    let lineEnd;
    if (j >= text.length) {
      lineEnd = text.length;
    } else if (breakAt > lineStart) {
      lineEnd = breakAt; // break at the last space that fits
    } else {
      lineEnd = j; // a single word longer than the width; hard-break it
    }

    out.push({ text: text.slice(lineStart, lineEnd), start: lineStart, end: lineEnd });
    i = lineEnd;
  }

  if (out.length === 0) out.push({ text: '', start: 0, end: 0 });
  return out;
}

function wrapWithOffsets(text, width) {
  const safe = text.replace(CONTROL_EXCEPT_NEWLINE, ' ');
  if (!safe.includes('\n')) return wrapSegment(safe, width);

  const out = [];
  let base = 0;
  for (const segment of safe.split('\n')) {
    for (const line of wrapSegment(segment, width)) {
      out.push({ text: line.text, start: base + line.start, end: base + line.end });
    }
    base += segment.length + 1; // the newline occupies a position too
  }
  return out;
}

// The part of each span that falls on one wrapped row, with its offsets made
// relative to that row's text. A merged table row is one block whose spans
// point at the blocks the cells came from, and wrapping it must not lose that:
// the same mapping is what activation, search and the number prompt read.
function spansWithin(spans, start, end) {
  const out = [];
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    out.push({
      ...span,
      start: Math.max(span.start, start) - start,
      end: Math.min(span.end, end) - start,
    });
  }
  return out;
}

function layoutLines(blocks, width) {
  const lines = [];
  blocks.forEach((block, position) => {
    // A merged table row was built from several blocks; its declared index is
    // the first of them, so a line still names a real block in the list the
    // reader's cursor, searches and activation resolve against.
    const blockIndex = block.sourceIndex != null ? block.sourceIndex : position;
    const prefix = block.displayPrefix || '';
    const suffix = block.displaySuffix || '';
    const indent = block.displayIndent || 0;
    // Markers and margins are display metadata rather than block text. Reserve
    // their cells while wrapping, but leave offsets in the rendered item.
    const wrapped = wrapWithOffsets(
      block.text, Math.max(1, width - indent - prefix.length - suffix.length));
    wrapped.forEach((w, i) => {
      const line = {
        blockIndex,
        text: w.text,
        start: w.start,
        end: w.end,
        continuation: i > 0,
        displayNumber: block.displayNumber || null,
        displayIndent: block.displayAlign === 'center'
          ? Math.max(0, Math.floor((width - w.text.length) / 2)) : indent,
        displayPrefix: i === 0 ? prefix : '',
        displaySuffix: i === wrapped.length - 1 ? suffix : '',
      };
      if (block.spans && block.spans.length) line.spans = spansWithin(block.spans, w.start, w.end);
      lines.push(line);
    });
  });
  return lines;
}

module.exports = { layoutLines, wrapWithOffsets, spansWithin };
