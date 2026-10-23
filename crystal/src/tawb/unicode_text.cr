require "./unicode_escape"

module Tawb
  # Presentation transform for Unicode punctuation. Kept separate from the
  # page's own text: the core needs the original characters for activation,
  # searching and form submission, while the terminal is shown the ASCII
  # spelling unless the reader asked for `--unicode full`.
  module UnicodeText
    ASCII_PUNCTUATION = {
      # Quotes, apostrophes and primes.
      0x00ab => "<<", 0x00bb => ">>",
      0x2018 => "'", 0x2019 => "'", 0x201a => "'", 0x201b => "'",
      0x201c => "\"", 0x201d => "\"", 0x201e => "\"", 0x201f => "\"",
      0x2032 => "'", 0x2033 => "\"", 0x2034 => "'", 0x2035 => "`", 0x2036 => "'",
      0x2039 => "<", 0x203a => ">",
      0x00b4 => "'", 0x02b9 => "'", 0x02bc => "'", 0x02c8 => "'",

      # Dashes and hyphens.
      0x00ad => "", 0x2010 => "-", 0x2011 => "-", 0x2012 => "-",
      0x2013 => "-", 0x2014 => "--", 0x2015 => "--",
      0x2043 => "-", 0x2052 => "-", 0x2212 => "-",
      0xfe58 => "-", 0xfe63 => "-", 0xff0d => "-",

      # Ellipses and leaders.
      0x2024 => ".", 0x2025 => "..", 0x2026 => "...",

      # Spaces that are visually indistinguishable from an ordinary one.
      0x00a0 => " ", 0x2000 => " ", 0x2001 => " ", 0x2002 => " ",
      0x2003 => " ", 0x2004 => " ", 0x2005 => " ", 0x2006 => " ",
      0x2007 => " ", 0x2008 => " ", 0x2009 => " ", 0x200a => " ",
      0x202f => " ", 0x205f => " ", 0x3000 => " ",

      # Zero-width formatting characters, which only add invisible width.
      0x200b => "", 0x200c => "", 0x200d => "", 0xfeff => "",

      # Bullets and dot punctuation.
      0x00b7 => ".", 0x2022 => "*", 0x2023 => "*", 0x2027 => "-",
      0x2219 => "*", 0x25cf => "*", 0x25e6 => "*",

      # Fractions.
      0x00bc => "1/4", 0x00bd => "1/2", 0x00be => "3/4",
      0x2150 => "1/7", 0x2151 => "1/9", 0x2152 => "1/10", 0x2153 => "1/3",
      0x2154 => "2/3", 0x2155 => "1/5", 0x2156 => "2/5", 0x2157 => "3/5",
      0x2158 => "4/5", 0x2159 => "1/6", 0x215a => "5/6", 0x215b => "1/8",
      0x215c => "3/8", 0x215d => "5/8", 0x215e => "7/8",
      0x2044 => "/", 0x2215 => "/",

      # Mathematical and relational signs.
      0x00b1 => "+-", 0x00d7 => "x", 0x00f7 => "/", 0x2248 => "~=",
      0x2260 => "!=", 0x2264 => "<=", 0x2265 => ">=",
      0x2190 => "<-", 0x2191 => "^", 0x2192 => "->", 0x2193 => "v",
      0x2194 => "<->", 0x21d0 => "<=", 0x21d2 => "=>", 0x21d4 => "<=>",

      # Copyright and trademark marks.
      0x00a9 => "(C)", 0x00ae => "(R)", 0x2122 => "(TM)",

      # Other common punctuation.
      0x00a1 => "!", 0x00bf => "?", 0x2020 => "+", 0x2021 => "++",
      0x2030 => "0/00", 0x2031 => "0/000", 0x2038 => "^", 0x203b => "*",
      0x203c => "!!", 0x203d => "?!", 0x2042 => "***", 0x2045 => "[",
      0x2046 => "]", 0x2047 => "??", 0x2048 => "?!", 0x2049 => "!?",
      0x204e => "*", 0x2051 => "**", 0x2053 => "~",
    }

    def self.ascii_punctuation(value : String?) : String
      String.build do |io|
        (value || "").each_char do |character|
          io << (ASCII_PUNCTUATION[character.ord]? || character.to_s)
        end
      end
    end

    def self.present(value : String?, unicode : String = "ascii", escape : Bool = false) : String
      text = unicode == "full" ? (value || "") : ascii_punctuation(value)
      escape ? UnicodeEscape.escape(text) : text
    end

    # The display length of the first *offset* UTF-16 units of *value* after
    # the presentation transform. Browser carets are counted in UTF-16 units,
    # while the ASCII replacements can change the displayed length.
    def self.present_offset(value : String?, offset : Int32,
                            unicode : String = "ascii", escape : Bool = false) : Int32
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
        if unit.in?(0xd800_u16..0xdbff_u16) && at + 1 < finish
          codepoint = 0x10000 + ((unit.to_i - 0xd800) << 10) + (units[at + 1].to_i - 0xdc00)
          pair = true
        else
          codepoint = unit.to_i
          pair = false
        end
        shown = if codepoint.in?(0xd800..0xdfff)
                  "\uFFFD"
                elsif unicode == "full"
                  codepoint.chr.to_s
                else
                  ASCII_PUNCTUATION[codepoint]? || codepoint.chr.to_s
                end
        width += if escape
                   UnicodeEscape.escape(shown).size
                 elsif pair
                   2
                 else
                   shown.size
                 end
        at += pair ? 2 : 1
      end
      width
    end
  end
end
