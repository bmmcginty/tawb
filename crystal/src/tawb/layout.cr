require "json"

module Tawb
  module Layout
    def self.wrap_with_offsets(text : String, width : Int32) : Array(JSON::Any)
      safe = utf16_units(text).map do |unit|
        control = unit <= 0x0009 || unit.in?(0x000b_u16..0x001f_u16) || unit == 0x007f
        control ? 0x0020_u16 : unit
      end
      newline = 0x000a_u16
      return wrap_segment(safe, width, 0) unless safe.includes?(newline)

      output = [] of JSON::Any
      base = 0
      start = 0
      safe.each_with_index do |unit, index|
        next unless unit == newline
        output.concat(wrap_segment(safe[start...index], width, base))
        base += index - start + 1
        start = index + 1
      end
      output.concat(wrap_segment(safe[start...safe.size], width, base))
      output
    end

    def self.spans_within(spans : Array(JSON::Any), start_offset : Int64, end_offset : Int64) : Array(JSON::Any)
      output = [] of JSON::Any
      spans.each do |span|
        object = span.as_h
        span_start = number(object, "start")
        span_end = number(object, "end")
        next if span_end <= start_offset || span_start >= end_offset
        clipped = object.dup
        clipped["start"] = JSON::Any.new({span_start, start_offset}.max - start_offset)
        clipped["end"] = JSON::Any.new({span_end, end_offset}.min - start_offset)
        output << JSON::Any.new(clipped)
      end
      output
    end

    def self.lines(blocks : Array(JSON::Any), width : Int32) : Array(JSON::Any)
      output = [] of JSON::Any
      blocks.each_with_index do |block, position|
        object = block.as_h
        source = object["sourceIndex"]?.try(&.as_i64?) || position.to_i64
        prefix = string(object, "displayPrefix")
        suffix = string(object, "displaySuffix")
        indent = number(object, "displayIndent")
        available = {1, width - indent.to_i - utf16_size(prefix) - utf16_size(suffix)}.max
        wrapped = wrap_with_offsets(string(object, "text"), available)
        wrapped.each_with_index do |part, row|
          piece = part.as_h
          text = piece["text"].as_s
          start_offset = piece["start"].as_i64
          end_offset = piece["end"].as_i64
          display_indent = if string(object, "displayAlign") == "center"
                             {0, (width - utf16_size(text)) // 2}.max.to_i64
                           else
                             indent
                           end
          line = {
            "blockIndex"    => JSON::Any.new(source),
            "text"          => JSON::Any.new(text),
            "start"         => JSON::Any.new(start_offset),
            "end"           => JSON::Any.new(end_offset),
            "continuation"  => JSON::Any.new(row > 0),
            "displayNumber" => object["displayNumber"]? || JSON::Any.new(nil),
            "displayIndent" => JSON::Any.new(display_indent),
            "displayPrefix" => JSON::Any.new(row == 0 ? prefix : ""),
            "displaySuffix" => JSON::Any.new(row == wrapped.size - 1 ? suffix : ""),
          }
          if spans = object["spans"]?.try(&.as_a?)
            line["spans"] = JSON::Any.new(spans_within(spans, start_offset, end_offset)) unless spans.empty?
          end
          output << JSON::Any.new(line)
        end
      end
      output
    end

    private def self.wrap_segment(units : Array(UInt16), width : Int32, base : Int32) : Array(JSON::Any)
      if width <= 0
        return [wrapped_part(units, base, base + units.size)]
      end
      output = [] of JSON::Any
      at = 0
      while at < units.size
        while at < units.size && units[at] == 0x0020
          at += 1
        end
        line_start = at
        break_at = -1
        cursor = at
        while cursor < units.size && cursor - line_start < width
          break_at = cursor if units[cursor] == 0x0020
          cursor += 1
        end
        line_end = if cursor >= units.size
                     units.size
                   elsif break_at > line_start
                     break_at
                   else
                     cursor
                   end
        output << wrapped_part(units[line_start...line_end], base + line_start, base + line_end)
        at = line_end
      end
      output << wrapped_part([] of UInt16, base, base) if output.empty?
      output
    end

    private def self.wrapped_part(units : Array(UInt16), start_offset : Int32, end_offset : Int32) : JSON::Any
      JSON::Any.new({
        "text"  => JSON::Any.new(string_from_utf16(units)),
        "start" => JSON::Any.new(start_offset.to_i64),
        "end"   => JSON::Any.new(end_offset.to_i64),
      })
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

    private def self.string_from_utf16(units : Array(UInt16)) : String
      String.build do |output|
        at = 0
        while at < units.size
          first = units[at]
          if first.in?(0xd800_u16..0xdbff_u16) && at + 1 < units.size && units[at + 1].in?(0xdc00_u16..0xdfff_u16)
            codepoint = 0x10000 + ((first.to_i - 0xd800) << 10) + (units[at + 1].to_i - 0xdc00)
            output << codepoint.chr
            at += 2
          elsif first.in?(0xd800_u16..0xdfff_u16)
            output << '\uFFFD'
            at += 1
          else
            output << first.to_i.chr
            at += 1
          end
        end
      end
    end

    private def self.utf16_size(value : String) : Int32
      value.each_char.sum { |character| character.ord > 0xffff ? 2 : 1 }
    end

    private def self.string(object : Hash(String, JSON::Any), key : String) : String
      object[key]?.try(&.as_s?) || ""
    end

    private def self.number(object : Hash(String, JSON::Any), key : String) : Int64
      object[key]?.try(&.as_i64?) || 0_i64
    end
  end
end
