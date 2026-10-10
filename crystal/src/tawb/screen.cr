module Tawb
  # The byte-level screen: where every terminal byte the reader sees goes
  # through, and the one transaction that edits a row like nano instead of
  # repainting it.
  #
  # ANSI cursor positioning is 1-indexed. This is the whole point of the
  # exercise: a terminal screen reader / braille display follows the actual
  # terminal cursor, so it must land on the focused line, and mid-edit on the
  # real caret column.
  module Screen
    # The terminal the reader draws on. The JavaScript original wrote through
    # process.stdout; the interactive front end supplies the real one.
    module Output
      abstract def write(text : String) : Nil
    end

    def self.move_cursor(output : Output, row : Int32, col : Int32) : Nil
      output.write("\e[#{row};#{col}H")
    end

    # Rewrites a single row in place (move, erase-to-end-of-line, write).
    def self.write_line(output : Output, row : Int32, text : String) : Nil
      move_cursor(output, row, 1)
      output.write("\e[2K" + text)
    end

    def self.relative_cursor(cells : Int32) : String
      if cells < 0
        "\b" * (-cells)
      elsif cells > 0
        "\e[#{cells}C"
      else
        ""
      end
    end

    # Scrolls the reading list one row without repainting it: IND leaves a
    # blank line at the bottom of the region, RI one at the top. Answers the
    # row the blank line landed on, which the caller paints. The region is
    # set and reset by the repaint, so this is safe between them only.
    def self.scroll_region(output : Output, direction : Int32,
                           top : Int32, bottom : Int32) : Int32
      if direction > 0
        move_cursor(output, bottom, 1)
        output.write("\eD")
        return bottom
      end
      move_cursor(output, top, 1)
      output.write("\eM")
      top
    end

    # Changes an actively edited row like nano: one terminal write moves from
    # the old caret, overwrites through the unchanged suffix, clears any
    # stale tail, and returns to the new caret. Keeping the whole transaction
    # together avoids exposing its intermediate screen states to a terminal
    # or screen reader. Answers whether anything was written.
    def self.patch_edited_line(output : Output, row : Int32, before : String?,
                               after : String?, current_col : Int32? = nil,
                               final_col : Int32? = nil) : Bool
      old_text = before || ""
      new_text = after || ""
      current_known = !current_col.nil?
      final_known = !final_col.nil?
      current = current_col || 0
      final = final_col || 0

      if old_text == new_text
        if !final_known || (current_known && current == final)
          return false
        end
        output.write(current_known ? relative_cursor(final - current) : "\e[#{row};#{final}H")
        return true
      end

      prefix = 0
      while prefix < old_text.size && prefix < new_text.size &&
            old_text[prefix] == new_text[prefix]
        prefix += 1
      end
      suffix = 0
      while suffix < old_text.size - prefix && suffix < new_text.size - prefix &&
            old_text[old_text.size - 1 - suffix] == new_text[new_text.size - 1 - suffix]
        suffix += 1
      end

      start_col = prefix + 1
      transaction = current_known ? relative_cursor(start_col - current) : "\e[#{row};#{start_col}H"
      transaction += new_text[prefix..]
      transaction += "\e[K" if new_text.size < old_text.size
      transaction += "\b" * suffix

      natural_col = new_text.size - suffix + 1
      transaction += relative_cursor(final - natural_col) if final_known
      output.write(transaction)
      true
    end
  end
end
