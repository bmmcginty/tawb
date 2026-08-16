'use strict';

// Maps a cursor position from an old line list onto a new one, by arithmetic
// rather than by searching for the line again.
//
// Searching is what a text-matching re-anchor does, and it is unreliable for
// two reasons that show up constantly in practice: block text repeats (an
// HTML view full of <svg>, <h4>, <option value=30>), and the very line the
// reader is on may be the one whose text changed (a clock rewrites itself
// every second, so it never matches what was anchored).
//
// A page update almost always rewrites one contiguous region and leaves the
// rest alone, so comparing the old and new lists from both ends identifies
// that region exactly:
//
//     [ common prefix ][ changed ][ common suffix ]
//
//   * a cursor in the common prefix keeps its index, unchanged;
//   * a cursor in the common suffix shifts by (newLength - oldLength);
//   * only a cursor inside the changed region is ambiguous, and even then
//     an unchanged region size means position within it is preserved —
//     which is exactly the ticking-clock case.
//
// This is the same technique an editor uses to keep your cursor when the
// file changes underneath it.

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i += 1;
  return i;
}

function commonSuffixLength(a, b, prefix) {
  const limit = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i;
}

// Returns { index, exact }. `exact` is false only when the old position sat
// inside the rewritten region and the region changed size, which is the one
// case where no arithmetic answer exists.
function remapIndex(oldTexts, newTexts, index) {
  if (oldTexts.length === 0) return { index: 0, exact: false };

  const clampOld = Math.min(Math.max(index, 0), oldTexts.length - 1);
  const prefix = commonPrefixLength(oldTexts, newTexts);

  // Before the first difference: the line is untouched and so is its index.
  if (clampOld < prefix) return { index: clampOld, exact: true };

  const suffix = commonSuffixLength(oldTexts, newTexts, prefix);
  const oldSuffixStart = oldTexts.length - suffix;

  // At or after the start of the trailing common run: everything from here
  // moved by the same amount.
  if (clampOld >= oldSuffixStart) {
    return { index: clampOld + (newTexts.length - oldTexts.length), exact: true };
  }

  // Inside the rewritten region. If it kept its size, the offset within it
  // still means the same thing — a clock line stays the clock line.
  const oldRegion = oldSuffixStart - prefix;
  const newRegion = (newTexts.length - suffix) - prefix;
  const offset = clampOld - prefix;

  if (oldRegion === newRegion) return { index: prefix + offset, exact: true };

  // The region resized under the cursor; clamp into it and say so, letting
  // the caller decide whether to fall back to something fuzzier.
  return {
    index: prefix + Math.min(offset, Math.max(newRegion - 1, 0)),
    exact: false,
  };
}

module.exports = { remapIndex, commonPrefixLength, commonSuffixLength };
