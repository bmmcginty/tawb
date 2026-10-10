require "./aria"
require "./reader"

module Tawb
  # Quick navigation follows the JAWS vocabulary: h headings, f form fields,
  # b buttons, n non-link text, p paragraphs. Uppercase goes backwards except
  # for links, whose L is the live-update switch. JAWS puts links on k, which
  # is taken by line movement here, so forward links are on l and backward
  # starts unbound in the configurable registry.
  #
  # What lives here is the search over the display lines; the drawing that
  # follows a hit is the reader's, and the key each action sits on is the
  # keymap's.
  module QuickNav
    alias Match = JSON::Any -> Bool

    # One jump's meaning: what it is called in status messages, which way it
    # walks, and whether the row the reader is standing on is walked first.
    record Spec, label : String, direction : Int32, same_line : Bool, match : Match

    # What Lynx means by a link when it says a movement stops only on links:
    # the things that are activated rather than typed into. A button is one
    # of them.
    def self.matches_activatable(item : JSON::Any) : Bool
      role = item.as_h["role"]?.try(&.as_s?)
      return false unless role
      Aria::LINK_ROLES.includes?(role) || Aria::BUTTON_ROLES.includes?(role)
    end

    private def self.role_is(item : JSON::Any, wanted : String) : Bool
      item.as_h["role"]?.try(&.as_s?) == wanted
    end

    private def self.role_in(item : JSON::Any, roles : Enumerable(String)) : Bool
      role = item.as_h["role"]?.try(&.as_s?)
      role ? roles.includes?(role) : false
    end

    # Tab and Shift+Tab: the three sets at once, in document order, which is
    # what Tab does in a graphical browser. Lynx splits the same ground more
    # finely, and the four actions below are its own: NEXT_LINK/PREV_LINK
    # walk the links and fields on the row the reader is standing on before
    # moving to another row, DOWN_LINK/UP_LINK move a row at a time, and
    # FASTFORW_LINK/FASTBACKW_LINK stop only on things that are activated
    # rather than typed into. `same_line` is which of the two readings to
    # use; the current row holds several items only where a paragraph or a
    # table row was reflowed, which is Lynx's own presentation.
    SPECIFICATIONS = {
      "next-heading"        => Spec.new("heading", 1, false, ->(item : JSON::Any) { role_is(item, "heading") }),
      "previous-heading"    => Spec.new("heading", -1, false, ->(item : JSON::Any) { role_is(item, "heading") }),
      "next-link"           => Spec.new("link", 1, false, ->(item : JSON::Any) { role_in(item, Aria::LINK_ROLES) }),
      "previous-link"       => Spec.new("link", -1, false, ->(item : JSON::Any) { role_in(item, Aria::LINK_ROLES) }),
      "next-field"          => Spec.new("form field", 1, false, ->(item : JSON::Any) { role_in(item, Aria::FIELD_ROLES) }),
      "previous-field"      => Spec.new("form field", -1, false, ->(item : JSON::Any) { role_in(item, Aria::FIELD_ROLES) }),
      "next-button"         => Spec.new("button", 1, false, ->(item : JSON::Any) { role_in(item, Aria::BUTTON_ROLES) }),
      "previous-button"     => Spec.new("button", -1, false, ->(item : JSON::Any) { role_in(item, Aria::BUTTON_ROLES) }),
      "next-text"           => Spec.new("non-link text", 1, false, ->(item : JSON::Any) { role_is(item, "text") }),
      "previous-text"       => Spec.new("non-link text", -1, false, ->(item : JSON::Any) { role_is(item, "text") }),
      "next-focusable"      => Spec.new("control", 1, true, ->(item : JSON::Any) { role_in(item, Aria::FOCUSABLE_ROLES) }),
      "previous-focusable"  => Spec.new("control", -1, true, ->(item : JSON::Any) { role_in(item, Aria::FOCUSABLE_ROLES) }),
      "fast-forward-link"   => Spec.new("link", 1, true, ->(item : JSON::Any) { matches_activatable(item) }),
      "fast-backward-link"  => Spec.new("link", -1, true, ->(item : JSON::Any) { matches_activatable(item) }),
      "down-link"           => Spec.new("link below", 1, false, ->(item : JSON::Any) { role_in(item, Aria::FOCUSABLE_ROLES) }),
      "up-link"             => Spec.new("link above", -1, false, ->(item : JSON::Any) { role_in(item, Aria::FOCUSABLE_ROLES) }),
    }

    def self.specification(action : String) : Spec?
      SPECIFICATIONS[action]?
    end

    # The next item of one kind, from wherever the reader is. The answer is a
    # line and a column, because a reflowed paragraph or table row holds
    # several blocks on one display row and Lynx's own movements walk those
    # in reading order rather than jumping over the row.
    def self.find(state : Reader::State, spec : Spec) : NamedTuple(line: Int32, col: Int32)?
      direction = spec.direction
      step = direction > 0 ? 1 : -1

      # The row the reader is standing on first, when the movement asks for
      # it. A reflowed paragraph or table row holds several blocks on one
      # display row, and Lynx's NEXT_LINK walks those before it looks at
      # another row — which is the whole of what distinguishes it from
      # DOWN_LINK.
      if spec.same_line
        line = state.lines[state.cursor]?
        if line && (spans = line.spans) && !spans.empty?
          ordered = direction > 0 ? spans : spans.reverse
          ordered.each do |span|
            next if direction > 0 && span.start <= state.col
            next if direction < 0 && span.start >= state.col
            block = state.core.blocks[span.block_index]?
            item = block.try(&.as_h?).try(&.["item"]?)
            next unless item && spec.match.call(item)
            return {line: state.cursor, col: span.start}
          end
        end
      end

      i = state.cursor + step
      while i >= 0 && i < state.lines.size
        line_index = i
        i += step
        line = state.lines[line_index]
        # A composite line holds several blocks; look at each item's own
        # span, even when the item begins on a wrapped continuation row.
        # Lynx keeps the reader's column as it crosses rows, so the item at
        # or after that column is taken going forwards and at or before it
        # going backwards, and the nearest one either way when the row has
        # nothing on that side.
        if spans = line.spans
          matching = spans.select do |span|
            block = state.core.blocks[span.block_index]?
            item = block.try(&.as_h?).try(&.["item"]?)
            item ? spec.match.call(item) : false
          end
          unless matching.empty?
            preferred = matching.find { |span| span.start >= state.col } if direction > 0
            preferred = matching.reverse.find { |span| span.start <= state.col } if direction < 0
            chosen = preferred || (direction > 0 ? matching.first : matching.last)
            return {line: line_index, col: chosen.start}
          end
          next
        end
        next if line.continuation
        block = state.core.blocks[line.block_index]?
        item = block.try(&.as_h?).try(&.["item"]?)
        return {line: line_index, col: 0} if item && spec.match.call(item)
      end
      nil
    end

    def self.find(state : Reader::State, action : String) : NamedTuple(line: Int32, col: Int32)?
      spec = SPECIFICATIONS[action]?
      spec ? find(state, spec) : nil
    end

    # A paragraph is the start of a block-level run that holds text — the
    # unit p/P steps through, as distinct from n/N which finds any non-link
    # text.
    def self.find_paragraph(state : Reader::State,
                            direction : Int32) : NamedTuple(line: Int32, col: Int32)?
      step = direction > 0 ? 1 : -1
      i = state.cursor + step
      while i >= 0 && i < state.lines.size
        line_index = i
        i += step
        line = state.lines[line_index]
        next if line.continuation
        block = state.core.blocks[line.block_index]?
        item = block.try(&.as_h?).try(&.["item"]?)
        next if item.nil? || role_is(item, "text") == false
        starts = block.try(&.as_h?).try(&.["startsBlock"]?.try(&.as_bool?)) || false
        paragraph = block.try(&.as_h?).try(&.["isParagraph"]?.try(&.as_bool?)) || false
        return {line: line_index, col: 0} if starts || paragraph
      end
      nil
    end

    # Land on a hit, or say what there was none of.
    def self.jump_to(output : Screen::Output, state : Reader::State, page_url : String,
                     found : NamedTuple(line: Int32, col: Int32)?, label : String,
                     direction : Int32) : Nil
      unless found
        Reader.set_status(output, state, page_url,
          "No #{direction > 0 ? "next" : "previous"} #{label}.")
        return
      end
      Reader.move_selection(output, state, page_url, found[:line], found[:col])
    end
  end
end
