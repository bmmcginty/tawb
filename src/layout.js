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

function layoutLines(blocks, width) {
  const lines = [];
  blocks.forEach((block, blockIndex) => {
    const wrapped = wrapWithOffsets(block.text, width);
    wrapped.forEach((w, i) => {
      lines.push({
        blockIndex,
        text: w.text,
        start: w.start,
        end: w.end,
        continuation: i > 0,
      });
    });
  });
  return lines;
}

module.exports = { layoutLines, wrapWithOffsets };
