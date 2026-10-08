module Tawb
  module UnicodeEscape
    def self.escape(value : String?) : String
      String.build do |io|
        (value || "").each_char do |character|
          codepoint = character.ord
          if codepoint <= 0x7f
            io << character
          elsif codepoint <= 0xffff
            io << "\\u" << codepoint.to_s(16).upcase.rjust(4, '0')
          else
            io << "\\U" << codepoint.to_s(16).upcase.rjust(8, '0')
          end
        end
      end
    end

    # Browser offsets count UTF-16 code units. Work in those units so even an
    # offset between a surrogate pair has the deterministic answer JavaScript's
    # String#slice and code-point iterator produce.
    def self.escaped_offset(value : String?, offset : Int32) : Int32
      units = [] of UInt16
      (value || "").each_char do |character|
        codepoint = character.ord
        if codepoint <= 0xffff
          units << codepoint.to_u16
        else
          rest = codepoint - 0x10000
          units << (0xd800 + (rest >> 10)).to_u16
          units << (0xdc00 + (rest & 0x3ff)).to_u16
        end
      end

      finish = offset < 0 ? {units.size + offset, 0}.max : {offset, units.size}.min
      width = 0
      at = 0
      while at < finish
        unit = units[at]
        if unit.in?(0xd800_u16..0xdbff_u16) && at + 1 < finish && units[at + 1].in?(0xdc00_u16..0xdfff_u16)
          width += 10
          at += 2
        else
          width += unit <= 0x7f ? 1 : 6
          at += 1
        end
      end
      width
    end
  end
end
