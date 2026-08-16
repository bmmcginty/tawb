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

function wrapWithOffsets(text, width) {
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
