# The native port of src/edit.js: the editing keyboard applied to an internal
# text buffer, and the same operations sent into a real field as key presses.
#
# Two audiences share this file and they must not be confused. `edit_action`
# is asked of the editing keyboard rather than the browsing one, because they
# carry keys that mean different things: Ctrl+D deletes a character here and
# files a bookmark out there. `apply_buffer_edit` edits the buffer a prompt
# keeps. `send_field_edit` types the same operation into a real <input> on
# the page, whose caret the browser owns.
#
# Carets are UTF-16 code units, the same units the terminal counts in and the
# same units JavaScript's string indices count in — a character beyond the
# basic plane is two of them, which is why the word movement walks units
# rather than characters.

module Tawb
  module Edit
    EDIT_ACTIONS = {
      "line-start"              => "line-start",
      "line-end"                => "line-end",
      "previous-character"      => "character-backward",
      "next-character"          => "character-forward",
      "edit-line-start"         => "line-start",
      "edit-line-end"           => "line-end",
      "edit-previous-character" => "character-backward",
      "edit-next-character"     => "character-forward",
      "edit-backspace"          => "backspace",
      "edit-delete"             => "delete-forward",
      "edit-previous-word"      => "word-backward",
      "edit-next-word"          => "word-forward",
      "edit-backspace-word"     => "delete-word-backward",
      "edit-delete-word"        => "delete-word-forward",
      "edit-kill-start"         => "delete-line-backward",
      "edit-kill-end"           => "delete-line-forward",
    }

    # What one editing operation is worth as real key presses. The multi-key
    # rows are the operations a browser field has no single key for: the line
    # kills are select-then-delete, like nano's.
    SEND_KEYS = {
      "line-start"           => ["Home"],
      "line-end"             => ["End"],
      "character-backward"   => ["ArrowLeft"],
      "character-forward"    => ["ArrowRight"],
      "word-backward"        => ["Control+ArrowLeft"],
      "word-forward"         => ["Control+ArrowRight"],
      "backspace"            => ["Backspace"],
      "delete-forward"       => ["Delete"],
      "delete-word-backward" => ["Control+Backspace"],
      "delete-word-forward"  => ["Control+Delete"],
      "delete-line-backward" => ["Shift+Home", "Backspace"],
      "delete-line-forward"  => ["Shift+End", "Backspace"],
    }

    # The buffer a prompt keeps: its text and where the caret sits in it.
    class Buffer
      property text : String
      property caret : Int32

      def initialize(@text : String, @caret : Int32)
      end
    end

    # Asked of the editing keyboard rather than the browsing one, because they
    # share keys that mean different things: Ctrl+D deletes a character here
    # and files a bookmark out there. See EDITING_ACTIONS in keys.js/keys.cr.
    def self.edit_action(key : String, keymap : Keys::Keymap) : String?
      asked = keymap.editing_action_for(key)
      asked ? EDIT_ACTIONS[asked]? : nil
    end

    # JavaScript's \s: White_Space plus the byte-order mark, no more, no less.
    private def self.space?(unit : UInt16) : Bool
      case unit
      when 0x0020, 0x0009, 0x000a, 0x000b, 0x000c, 0x000d,
           0x00a0, 0x1680, 0x2000..0x200a, 0x2028, 0x2029,
           0x202f, 0x205f, 0x3000, 0xfeff
        true
      else
        false
      end
    end

    def self.word_start(text : String, caret : Int32) : Int32
      units = utf16_units(text)
      at = clamp_caret(caret, units.size)
      while at > 0 && space?(units[at - 1])
        at -= 1
      end
      while at > 0 && !space?(units[at - 1])
        at -= 1
      end
      at
    end

    def self.word_end(text : String, caret : Int32) : Int32
      units = utf16_units(text)
      at = clamp_caret(caret, units.size)
      while at < units.size && space?(units[at])
        at += 1
      end
      while at < units.size && !space?(units[at])
        at += 1
      end
      at
    end

    # One operation against the buffer, answering whether the operation was
    # known. The caret never leaves the text, and a deletion collapses the
    # range it removed to its start.
    def self.apply_buffer_edit(buffer : Buffer, action : String) : Bool
      units = utf16_units(buffer.text)
      caret = clamp_caret(buffer.caret, units.size)
      from = caret
      to = caret

      case action
      when "line-start"        then buffer.caret = 0
      when "line-end"          then buffer.caret = units.size
      when "character-backward" then buffer.caret = Math.max(caret - 1, 0)
      when "character-forward" then buffer.caret = Math.min(caret + 1, units.size)
      when "word-backward"     then buffer.caret = word_start(buffer.text, caret)
      when "word-forward"      then buffer.caret = word_end(buffer.text, caret)
      else
        if action == "backspace"
          from = Math.max(caret - 1, 0)
        elsif action == "delete-forward"
          to = Math.min(caret + 1, units.size)
        elsif action == "delete-word-backward"
          from = word_start(buffer.text, caret)
        elsif action == "delete-word-forward"
          to = word_end(buffer.text, caret)
        elsif action == "delete-line-backward"
          from = 0
        elsif action == "delete-line-forward"
          to = units.size
        else
          return false
        end
        buffer.text = string_from_utf16(units[0...from]) + string_from_utf16(units[to...])
        buffer.caret = from
      end
      true
    end

    # Send one editing operation into a real field as the keys a browser
    # understands, in order. The keyboard is the caller's; here and in
    # JavaScript this file only knows which keys to press.
    def self.send_field_edit(press : String -> Nil, action : String) : Bool
      keys = SEND_KEYS[action]?
      return false unless keys
      keys.each { |key| press.call(key) }
      true
    end

    private def self.clamp_caret(caret : Int32, size : Int32) : Int32
      Math.min(Math.max(caret, 0), size)
    end

    # The same UTF-16 bridge layout.cr uses: caret arithmetic and slicing run
    # in code units so a character beyond the basic plane counts as two, both
    # here and in the JavaScript original.
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

    private def self.string_from_utf16(units : Array(UInt16)) : String
      String.build do |output|
        at = 0
        while at < units.size
          first = units[at]
          if first.in?(0xd800_u16..0xdbff_u16) && at + 1 < units.size && units[at + 1].in?(0xdc00_u16..0xdfff_u16)
            codepoint = 0x10000 + ((first.to_u32 - 0xd800) << 10) + (units[at + 1].to_u32 - 0xdc00)
            output << codepoint.unsafe_chr
            at += 2
          else
            output << first.chr
            at += 1
          end
        end
      end
    end
  end
end
