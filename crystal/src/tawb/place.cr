# The native port of src/place.js: keeping the reader's place when the view
# changes, worked out over the wrapped lines and over the element each line
# came from.
#
# The four views describe the same page in four completely different line
# lists — 135 lines of accessibility tree against 1500 of markup on the same
# album page — so a line number means nothing across a switch. Matching the
# text does not work either, because the views do not render the same thing:
# a play button that reads `[*Play Weird Fish]` in the accessibility tree is
# paired with `<a aria-label=Play Weird Fish>` in INSPECT and, in SOURCE, an
# `<a role="button" aria-label="Play Weird Fish">` several lines away from
# the `<div class="playbutton">` inside it. Matching on the item's *name* is
# worse still: in the DOM-derived views a name is often just the tag, so
# "keep me on this line" degenerated into "find the first line containing
# the letter a", which is line one of the page.
#
# What all four views do have in common is the element each line came from.
# Their extractors stash those elements page-side because that is how a line
# is activated later; AX and INSPECT share the accessibility extractor's
# references. So a place is an element, not a line.
#
# The element half lives here as `capture_place`, `locate_by_element` and
# `restore_place`. The element handles those three work through do not: the
# page-side scripts are `Actions::DESCRIBE_ELEMENT` and
# `Actions::LOCATE_ELEMENT`, and the holding of one element across a view
# switch belongs to whatever implements `Place::Elements` — the real core
# against a browser, a scripted one under the conformance harness.
#
# Two things the element half leans on:
#
#   Prose has no element of its own in most views — it is a text node, and
#   the views number elements. The nearest element above the cursor is used
#   as the anchor and the reader's own line is then found again by its text,
#   searching down from where that element landed rather than from the top
#   of the document, which is what makes repeated text harmless.
#
#   Some semantic lines, such as generated text, carry no element reference.
#   Entering one falls back to the nearest element's label and, where several
#   lines match, to the one nearest its position in document order. That is a
#   guess, but not line-number arithmetic between lists of different lengths.

require "json"
require "./core"

module Tawb
  module Place
    # Where each view stashes the elements its lines came from, and the
    # property on an item that indexes into it. Page-side these are named by
    # symbol rather than by a plain property — a string property is listed by
    # Object.keys, and the documents this program most needs to be
    # unremarkable in are the ones looking hardest. The names matter here only
    # as data; the stashing itself stays page-side.
    NODE_ARRAY = {
      "render"  => "tweb.render",
      "source"  => "tweb.dom",
      "ax"      => "tweb.ax",
      "inspect" => "tweb.ax",
    }
    INDEX_KEY = {
      "render"  => "renderIndex",
      "source"  => "domIndex",
      "ax"      => "axIndex",
      "inspect" => "axIndex",
    }

    # How far back to look for an element to anchor to when the cursor is on
    # prose, and how far down from it to look for the prose again afterwards. A
    # run of text between two elements is short; a paragraph that needs 400 lines
    # of markup to describe it is not, which is the direction the numbers have to
    # cover.
    LOOKBACK_BLOCKS = 200
    REFINE_LINES    = 400
    # Short strings match everywhere, so a partial match is only trusted from
    # something long enough to mean something.
    MIN_NEEDLE = 4

    # One spot on a wrapped line: the column it starts at, the block it came
    # from. A whole-line position is one; a line over a block boundary is as
    # many as the blocks it carries.
    record Position, line : Int32, col : Int32, stop : Int32,
      block_index : Int32, block : Core::Block?

    # What the reader was reading, described well enough to be looked for
    # again: the text, the column within it, whether the reader was on the
    # element itself, and — when the page could describe the element — its
    # label and its position in document order.
    #
    # `source` is the view the place was taken in, `held` says whether an
    # element is being held for it, and `frame` is the frame the held element
    # belongs to. A block of the view being entered only answers for a held
    # element when the two agree about the frame.
    record Kept, text : String, col : Int32, on_element : Bool, label : String,
      ordinal : Int64?, total : Int64?, ratio : Float64,
      source : String = "", held : Bool = false, frame : JSON::Any? = nil

    # The page side of a place: the element the reader was standing on, held
    # from the capture until the restore is over. One element is held at a
    # time, exactly as the typing field's is.
    module Elements
      # Resolve the element this item came from, hold it, and answer what the
      # page says about it: {"label", "ordinal", "total"}. Nil when the item
      # carries no reference, when the page will not describe it, or when the
      # resolution fails — nothing is held in any of those cases, and the
      # text fallbacks are what the restore then has to work with.
      abstract def describe_place_element(item : JSON::Any) : JSON::Any?
      # Which entry of `array_name` the held element is now:
      # {"index", "exact"}. Nil when nothing is held, when the view has no
      # such node array, or when neither the element nor anything above it in
      # document order appears in that array.
      abstract def locate_place_element(array_name : String) : JSON::Any?
      # Let go of the held element. Called once per capture that held one.
      abstract def release_place_element : Nil
    end

    # Where a text search left the cursor: the line and column, and whether
    # the answer was the reader's own line or merely the same words.
    record Refined, line : Int32, col : Int32, exact : Bool

    # The reader's view: the wrapped lines, the blocks behind them, and where
    # the cursor sits. The lines are the shape Layout.lines hands back; the
    # blocks are the core's.
    class View
      property lines : Array(JSON::Any)
      property blocks : Array(Core::Block)
      property cursor : Int32
      property col : Int32
      property source : String

      def initialize(@lines : Array(JSON::Any), @blocks : Array(Core::Block),
                     @cursor : Int32, @col : Int32, @source : String)
      end
    end

    def self.index_of_item(source : String, item : JSON::Any) : Int64?
      key = INDEX_KEY[source]?
      return nil unless key && !item.raw.nil?
      object = item.as_h?
      return nil unless object
      raw = object[key]?
      return nil if raw.nil?
      raw.as_i64?
    end

    # Whether this line can be turned back into an element. AX items with no
    # element reference are resolved by role and name instead, which needs
    # both — and text is not a role anything can be found by.
    def self.has_element?(source : String, item : JSON::Any) : Bool
      return false if item.raw.nil?
      return true if index_of_item(source, item)
      return false unless source == "ax"
      object = item.as_h? || return false
      role = object["role"]?.try(&.as_s?)
      name = object["name"]?.try(&.as_s?)
      !!role && role != "text" && !!name && !name.empty?
    end

    def self.positions_at_line(view : View, line_index : Int32) : Array(Position)
      line = view.lines[line_index]?
      return [] of Position unless line
      object = line.as_h
      spans = object["spans"]?.try(&.as_a?)
      if spans && !spans.empty?
        return spans.map do |span|
          span_object = span.as_h
          block_index = span_object["blockIndex"]?.try(&.as_i?) || 0
          Position.new(line_index, span_object["start"]?.try(&.as_i?) || 0,
            span_object["end"]?.try(&.as_i?) || 0, block_index,
            view.blocks[block_index]?)
        end
      end
      return [] of Position if object["continuation"]?.try(&.as_bool?)
      [Position.new(line_index, 0, utf16_size(string(object, "text")),
        object["blockIndex"]?.try(&.as_i?) || 0,
        view.blocks[object["blockIndex"]?.try(&.as_i?) || 0]?)]
    end

    def self.position_of_block(view : View, block_index : Int32) : Position?
      (0...view.lines.size).each do |line|
        found = positions_at_line(view, line).find { |position| position.block_index == block_index }
        return found if found
      end
      nil
    end

    def self.block_index_at_line(view : View, line_index : Int32, col : Int32 = 0) : Int32
      positions = positions_at_line(view, line_index)
      if positions.empty?
        line = view.lines[line_index]?
        return line ? line.as_h["blockIndex"]?.try(&.as_i?) || -1 : -1
      end
      chosen = positions[0]
      positions.each do |position|
        chosen = position if position.col <= col
      end
      chosen.block_index
    end

    # The element the reader is on, or the nearest one above it — the block
    # capturePlace resolves into an element. Prose has no element of its own,
    # so the search walks back; how far it may walk is the LOOKBACK window.
    def self.anchor_block(view : View, block_index : Int32) : Core::Block?
      i = block_index
      while i >= 0 && block_index - i <= LOOKBACK_BLOCKS
        block = view.blocks[i]?
        return block if block && has_element?(view.source, block.item)
        i -= 1
      end
      nil
    end

    # What the reader is reading, taken before the view changes. The text and
    # the column within it are always there; an element is held as well
    # whenever the cursor's own block, or the nearest element-bearing block
    # above it, resolves to one the page will describe.
    def self.capture_place(view : View, elements : Elements) : Kept?
      return nil unless view.lines[view.cursor]?

      block_index = block_index_at_line(view, view.cursor, view.col)
      # A line that names no block at all answers -1, and a negative index
      # counts from the end of a Crystal array where JavaScript's answers
      # undefined. Nothing is the right answer here.
      block = block_index >= 0 ? view.blocks[block_index]? : nil
      position = position_of_block(view, block_index)
      text = block ? block.text : ""
      col = Math.max(0, view.col - (position ? position.col : 0))
      ratio = view.lines.empty? ? 0.0 : view.cursor / view.lines.size
      without_element = Kept.new(text: text, col: col, on_element: false,
        label: "", ordinal: nil, total: nil, ratio: ratio, source: view.source,
        held: false, frame: nil)

      anchor = anchor_block(view, block_index)
      return without_element unless anchor

      described = begin
        elements.describe_place_element(anchor.item)
      rescue
        # No reference to be had. The text fallbacks still apply.
        nil
      end
      return without_element unless described && !described.raw.nil?

      object = described.as_h
      frame = anchor.item.as_h?.try(&.["frame"]?)
      Kept.new(
        text: text, col: col,
        on_element: !!block.try { |current| anchor.same?(current) },
        label: string(object, "label"),
        ordinal: object["ordinal"]?.try(&.as_i64?),
        total: object["total"]?.try(&.as_i64?),
        ratio: ratio, source: view.source, held: true,
        frame: frame && !frame.raw.nil? ? frame : nil)
    end

    # The line nearest `estimate` that satisfies `test`. Nearest, not first:
    # text repeats — a page of `<div class="play-button">` offers a dozen
    # identical candidates — and the one the reader wants is the one where
    # they were.
    def self.nearest_line(view : View, estimate : Int32, &test : Position, JSON::Any -> Bool) : Position?
      best = nil
      (0...view.lines.size).each do |i|
        line = view.lines[i]
        positions_at_line(view, i).each do |position|
          next unless test.call(position, line)
          distance = (i - estimate).abs
          if best.nil? || distance < best.not_nil![:distance]
            best = {position: position, distance: distance}
          end
        end
      end
      best.try(&.[:position])
    end

    # Puts the cursor on the line that block produced, then — when the reader
    # was on prose rather than on the element itself — looks down from there
    # for the text they were actually reading. Answers 'exact' when the
    # element itself was matched, 'near' otherwise, nil when the block has no
    # line in this view.
    def self.land_on(view : View, block_index : Int32, place : Kept, exact_element : Bool) : String?
      position = position_of_block(view, block_index)
      return nil unless position

      if place.on_element
        view.cursor = position.line
        if same_line_text(view, block_index, place)
          view.col = position.col + Math.min(place.col, Math.max(position.stop - position.col - 1, 0))
        else
          view.col = position.col
        end
        return exact_element ? "exact" : "near"
      end

      refined = refine_to_text(view, position.line, place)
      view.cursor = refined.line
      view.col = refined.col
      exact_element && refined.exact ? "exact" : "near"
    end

    private def self.same_line_text(view : View, block_index : Int32, place : Kept) : Bool
      block = view.blocks[block_index]?
      !!block && block.text == place.text
    end

    # Looks down from `from` for the text the reader was actually reading —
    # first as a block's own text, then as a substring long enough to trust.
    def self.refine_to_text(view : View, from : Int32, place : Kept) : Refined
      wanted = place.text.strip
      return Refined.new(from, 0, false) if wanted.empty?

      limit = Math.min(view.lines.size, from + REFINE_LINES)
      (from...limit).each do |i|
        positions_at_line(view, i).each do |position|
          block = position.block
          next unless block && block.text == place.text
          return Refined.new(i,
            position.col + Math.min(place.col, Math.max(position.stop - position.col - 1, 0)),
            true)
        end
      end

      if utf16_size(wanted) >= MIN_NEEDLE
        (from...limit).each do |i|
          line = view.lines[i].as_h
          next if line["continuation"]?.try(&.as_bool?)
          at = utf16_index(string(line, "text"), wanted)
          return Refined.new(i, at, false) if at >= 0
        end
      end

      Refined.new(from, 0, false)
    end

    # For a view with no element references to match against — and for
    # anything the element lookup could not place. The estimate is the
    # element's own position in document order when the page gave one, and
    # the reader's proportion of the old view when it did not.
    def self.locate_by_text(view : View, place : Kept) : String?
      return nil if view.lines.empty?

      # JavaScript's truthiness and its null arithmetic, both load-bearing:
      # a total of 0 would fall back to the reader's own ratio in the
      # estimate but still allow the estimate landing, and a missing ordinal
      # divides as 0 rather than crashing.
      fraction = if place.total && place.total != 0
                   (place.ordinal || 0_i64) / place.total.not_nil!
                 else
                   place.ratio
                 end
      estimate = Core.js_round(fraction * view.lines.size)
      text = place.text.strip
      label = place.label.strip

      if !text.empty?
        same = nearest_line(view, estimate) { |position, _line| position.block.try(&.text) == place.text }
        return land_line(view, same, same.col + place.col, "exact") if same
      end

      if utf16_size(label) >= MIN_NEEDLE
        named = nearest_line(view, estimate) do |position, _line|
          block = position.block
          next false unless block && !block.item.raw.nil?
          string(block.item.as_h? || {} of String => JSON::Any, "name").strip == label
        end
        return land_line(view, named, named.col, "exact") if named

        within = nearest_line(view, estimate) { |position, _line| position.block.try(&.text.includes?(label)) || false }
        return land_line(view, within, within.col, "near") if within
      end

      if utf16_size(text) >= MIN_NEEDLE
        within = nearest_line(view, estimate) { |position, _line| position.block.try(&.text.includes?(text)) || false }
        return land_line(view, within, within.col, "near") if within
      end

      unless place.total.nil?
        return land_estimate(view, estimate)
      end
      nil
    end

    # The held element, found again in the view being entered: ask the page
    # which entry of this view's node array the element is now, then find the
    # block of this view carrying that entry and land on it.
    def self.locate_by_element(view : View, elements : Elements,
                               place : Kept) : String?
      return nil unless place.held
      array_name = NODE_ARRAY[view.source]? || return nil
      key = INDEX_KEY[view.source]? || return nil

      found = elements.locate_place_element(array_name)
      return nil unless found && !found.raw.nil?
      object = found.as_h
      index = object["index"]?.try(&.as_i64?) || return nil
      exact = object["exact"]?.try(&.as_bool?) || false

      wanted_frame = place.frame
      block_index = view.blocks.index do |candidate|
        item = candidate.item.as_h?
        next false unless item
        next false unless item[key]?.try(&.as_i64?) == index
        frame = item["frame"]?
        next true if wanted_frame.nil? || frame.nil? || frame.raw.nil?
        frame == wanted_frame
      end
      return nil unless block_index

      land_on(view, block_index, place, exact)
    end

    # Moves the cursor to wherever the captured place now is. Answers
    # "exact" when the element itself was found, "near" when it was located
    # by its surroundings or by text, and nil when the view has nothing to
    # match — in which case the caller keeps whatever fallback it had.
    #
    # An element match that had to settle for an ancestor, or for whatever
    # sits above the element in document order, is only a guess at where the
    # reader was. A line whose text is exactly what they were reading is not,
    # so that line wins — but only when the text match is exact. Anything
    # less and the element's own neighbourhood is the better answer.
    def self.restore_place(view : View, elements : Elements,
                           place : Kept?) : String?
      return nil unless place
      quality = nil.as(String?)
      begin
        quality = locate_by_element(view, elements, place)
        if quality != "exact"
          from_element = {cursor: view.cursor, col: view.col}
          by_text = locate_by_text(view, place)
          if by_text != "exact" && quality
            view.cursor = from_element[:cursor]
            view.col = from_element[:col]
          elsif by_text
            quality = by_text
          end
        end
      rescue
        quality = nil
      ensure
        elements.release_place_element if place.held
      end
      quality
    end

    private def self.land_line(view : View, position : Position, col : Int32, quality : String) : String
      view.cursor = position.line
      view.col = col
      quality
    end

    private def self.land_estimate(view : View, estimate : Int32) : String
      view.cursor = Math.min(Math.max(estimate, 0), view.lines.size - 1)
      view.col = 0
      "near"
    end

    private def self.string(object : Hash(String, JSON::Any), key : String) : String
      object[key]?.try(&.as_s?) || ""
    end

    # The same UTF-16 bridge layout.cr uses: a line's columns are code units,
    # so text searches answer in units too, and a character beyond the basic
    # plane counts as the two cells it occupies.
    private def self.utf16_size(value : String) : Int32
      count = 0
      value.each_char do |character|
        count += character.ord <= 0xffff ? 1 : 2
      end
      count
    end

    private def self.utf16_units(value : String) : Array(UInt16)
      units = [] of UInt16
      value.each_char do |character|
        codepoint = character.ord
        if codepoint <= 0xffff
          units << codepoint.to_u16
        else
          rest = codepoint - 0x10000
          units << (0xd800 + (rest >> 10)).to_u16
          units << (0xdc00 + (rest & 0x3ff)).to_u16
        end
      end
      units
    end

    # First occurrence of `needle` in `value`, in UTF-16 units: JavaScript's
    # indexOf, which is the column arithmetic the reader's cursor counts in.
    private def self.utf16_index(value : String, needle : String) : Int32
      return 0 if needle.empty?
      haystack = utf16_units(value)
      units = utf16_units(needle)
      return -1 if units.size > haystack.size
      (0..haystack.size - units.size).each do |start|
        matched = true
        (0...units.size).each do |offset|
          if haystack[start + offset] != units[offset]
            matched = false
            break
          end
        end
        return start if matched
      end
      -1
    end
  end
end
