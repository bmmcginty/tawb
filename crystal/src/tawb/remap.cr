# The native port of src/remap.js: maps a cursor position from an old line
# list onto a new one, by arithmetic rather than by searching for the line
# again.
#
# Searching is what a text-matching re-anchor does, and it is unreliable for
# two reasons that show up constantly in practice: block text repeats (a
# SOURCE view full of <svg>, <h4>, <option value=30>), and the very line the
# reader is on may be the one whose text changed (a clock rewrites itself
# every second, so it never matches what was anchored).
#
# A page update almost always rewrites one contiguous region and leaves the
# rest alone, so comparing the old and new lists from both ends identifies
# that region exactly:
#
#     [ common prefix ][ changed ][ common suffix ]
#
#   * a cursor in the common prefix keeps its index, unchanged;
#   * a cursor in the common suffix shifts by (newLength - oldLength);
#   * only a cursor inside the changed region is ambiguous, and even then
#     an unchanged region size means position within it is preserved —
#     which is exactly the ticking-clock case.
#
# This is the same technique an editor uses to keep your cursor when the
# file changes underneath it.

module Tawb
  module Remap
    # Where an old position lands in the new list. `exact` is false only when
    # the old position sat inside the rewritten region and the region changed
    # size, which is the one case where no arithmetic answer exists.
    record Remapped, index : Int32, exact : Bool

    def self.common_prefix_length(a : Array(String), b : Array(String)) : Int32
      limit = Math.min(a.size, b.size)
      i = 0
      while i < limit && a[i] == b[i]
        i += 1
      end
      i
    end

    def self.common_suffix_length(a : Array(String), b : Array(String), prefix : Int32) : Int32
      limit = Math.min(a.size, b.size) - prefix
      i = 0
      while i < limit && a[a.size - 1 - i] == b[b.size - 1 - i]
        i += 1
      end
      i
    end

    def self.remap_index(old_texts : Array(String), new_texts : Array(String), index : Int32) : Remapped
      return Remapped.new(0, false) if old_texts.empty?

      clamp_old = Math.min(Math.max(index, 0), old_texts.size - 1)
      prefix = common_prefix_length(old_texts, new_texts)

      # Before the first difference: the line is untouched and so is its index.
      return Remapped.new(clamp_old, true) if clamp_old < prefix

      suffix = common_suffix_length(old_texts, new_texts, prefix)
      old_suffix_start = old_texts.size - suffix

      # At or after the start of the trailing common run: everything from here
      # moved by the same amount.
      if clamp_old >= old_suffix_start
        return Remapped.new(clamp_old + (new_texts.size - old_texts.size), true)
      end

      # Inside the rewritten region. If it kept its size, the offset within it
      # still means the same thing — a clock line stays the clock line.
      old_region = old_suffix_start - prefix
      new_region = (new_texts.size - suffix) - prefix
      offset = clamp_old - prefix

      return Remapped.new(prefix + offset, true) if old_region == new_region

      # The region resized under the cursor; clamp into it and say so, letting
      # the caller decide whether to fall back to something fuzzier.
      Remapped.new(prefix + Math.min(offset, Math.max(new_region - 1, 0)), false)
    end
  end
end
