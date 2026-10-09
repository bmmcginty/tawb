require "json"
require "./aria"
require "./blocks"
require "./unicode_escape"

module Tawb
  module LynxDisplay
    FIELD_WIDTH = 20

    def self.render_item(item : JSON::Any?, fallback = "", escape_unicode = false) : String
      return transform(fallback, escape_unicode) unless item
      object = item.as_h
      role = string(object, "role")
      name = transform(string(object, "name"), escape_unicode)
      value = transform(string(object, "value"), escape_unicode)

      if table = object["table"]?.try(&.as_h?)
        if truthy?(table["caption"]?)
          shown = name.empty? ? transform(fallback, escape_unicode) : name
          return "CAPTION: #{shown}"
        end
      end
      return transform(fallback, escape_unicode) if role == "text"
      return name if role == "heading"
      return name.empty? ? transform(fallback, escape_unicode) : name if Aria::LINK_ROLES.includes?(role)
      if role.in?({"checkbox", "switch", "menuitemcheckbox"})
        checked = object["checked"]?
        mark = checked.try(&.as_s?) == "mixed" ? "-" : (truthy?(checked) ? "X" : " ")
        return name.empty? ? "[#{mark}]" : "[#{mark}] #{name}"
      end
      if role.in?({"radio", "menuitemradio"})
        mark = truthy?(object["checked"]?) ? "*" : " "
        return name.empty? ? "(#{mark})" : "(#{mark}) #{name}"
      end
      return name if role == "option"
      return name.empty? ? "BUTTON" : name if Aria::BUTTON_ROLES.includes?(role)

      if role == "textbox" || role == "searchbox"
        return label_and_control(name, clip_field(value))
      end
      if role == "combobox" || role == "listbox"
        shown = value.empty? ? (name.empty? ? "____________________" : name) : value
        return label_and_control(name, "[#{shown}]")
      end
      if role == "slider" || role == "spinbutton"
        return label_and_control(name, "[#{value.empty? ? "0" : value}]")
      end
      if Aria::FIELD_ROLES.includes?(role)
        return label_and_control(name, clip_field(value))
      end

      return name.empty? ? "[IMAGE]" : name if role == "img"
      return name.empty? ? "IFRAME:" : "IFRAME: #{name}" if role == "iframe"
      return name.empty? ? "[#{role}]" : "[#{name}]" if role == "video" || role == "audio"
      name.empty? ? transform(fallback, escape_unicode) : name
    end

    def self.render_block(block : JSON::Any, escape_unicode = false) : JSON::Any
      rendered = block.as_h.dup
      item = rendered["item"]?.try(&.as_h?) || {} of String => JSON::Any
      rendered["text"] = JSON::Any.new(render_item(rendered["item"]?, string(rendered, "text"), escape_unicode))
      if string(item, "role") == "heading"
        level_value = item["level"]?
        level = level_value.try(&.as_i64?) || level_value.try(&.as_s?).try(&.to_i64?) || 2_i64
        if level == 1
          rendered["displayAlign"] = JSON::Any.new("center")
        else
          rendered["displayIndent"] = JSON::Any.new(level >= 3 ? 2_i64 : 0_i64)
        end
      else
        rendered["displayIndent"] = JSON::Any.new(3_i64)
      end
      JSON::Any.new(rendered)
    end

    def self.number_blocks(blocks : Array(JSON::Any), preferences : Hash(String, JSON::Any)) : Array(JSON::Any)
      number = 0_i64
      blocks.map do |block|
        object = block.as_h
        role = object["item"]?.try(&.as_h?).try { |item| string(item, "role") } || ""
        link = Aria::LINK_ROLES.includes?(role)
        field = role != "option" && (Aria::BUTTON_ROLES.includes?(role) || Aria::FIELD_ROLES.includes?(role))
        number_link = link && truthy?(preferences["numberLinks"]?)
        number_field = field && truthy?(preferences["numberFields"]?)
        next block unless number_link || number_field

        number += 1
        marker = "[#{number}]"
        left_setting = link ? preferences["numberLinksOnLeft"]? : preferences["numberFieldsOnLeft"]?
        left = left_setting.nil? || left_setting.try(&.as_bool?) != false
        numbered = object.dup
        numbered["displayNumber"] = JSON::Any.new(number)
        numbered["displayPrefix"] = JSON::Any.new(left ? marker : "")
        numbered["displaySuffix"] = JSON::Any.new(left ? "" : marker)
        JSON::Any.new(numbered)
      end
    end

    def self.group_flows(blocks : Array(JSON::Any)) : Array(JSON::Any)
      output = [] of JSON::Any
      index = 0
      while index < blocks.size
        first = blocks[index]
        first_object = first.as_h
        first_item = first_object["item"]?.try(&.as_h?)
        flow = first_item.try { |item| item["flow"]? }
        role = first_item.try { |item| string(item, "role") } || ""
        inline = flow && (role == "text" || Aria::LINK_ROLES.includes?(role))
        unless inline
          copied = first_object.dup
          copied["sourceIndex"] = JSON::Any.new(source_index(first_object, index))
          output << JSON::Any.new(copied)
          index += 1
          next
        end

        finish = index + 1
        while finish < blocks.size
          candidate = blocks[finish].as_h
          item = candidate["item"]?.try(&.as_h?)
          candidate_role = item.try { |value| string(value, "role") } || ""
          break unless item && item["flow"]? == flow &&
                       (candidate_role == "text" || Aria::LINK_ROLES.includes?(candidate_role))
          finish += 1
        end
        if finish == index + 1
          copied = first_object.dup
          copied["sourceIndex"] = JSON::Any.new(source_index(first_object, index))
          output << JSON::Any.new(copied)
          index = finish
          next
        end

        text = ""
        previous = ""
        spans = [] of JSON::Any
        (index...finish).each do |at|
          object = blocks[at].as_h
          block_text = string(object, "text")
          joined = previous.empty? ? block_text : Blocks.join_prose(previous, block_text)
          text += " " if !previous.empty? && joined == "#{previous} #{block_text}"
          text += string(object, "displayPrefix")
          start_offset = utf16_size(text).to_i64
          text += block_text
          if existing = object["spans"]?.try(&.as_a?)
            existing.each do |span|
              shifted = span.as_h.dup
              shifted["start"] = JSON::Any.new(start_offset + number(shifted, "start"))
              shifted["end"] = JSON::Any.new(start_offset + number(shifted, "end"))
              spans << JSON::Any.new(shifted)
            end
          else
            spans << JSON::Any.new({
              "blockIndex"    => JSON::Any.new(source_index(object, at)),
              "start"         => JSON::Any.new(start_offset),
              "end"           => JSON::Any.new(utf16_size(text).to_i64),
              "displayNumber" => object["displayNumber"]? || JSON::Any.new(nil),
            })
          end
          text += string(object, "displaySuffix")
          previous = block_text
        end

        merged = first_object.dup
        merged["text"] = JSON::Any.new(text)
        merged["spans"] = JSON::Any.new(spans)
        merged["sourceIndex"] = JSON::Any.new(source_index(first_object, index))
        merged["displayPrefix"] = JSON::Any.new("")
        merged["displaySuffix"] = JSON::Any.new("")
        merged["displayNumber"] = JSON::Any.new(nil)
        merged["merged"] = JSON::Any.new(true)
        output << JSON::Any.new(merged)
        index = finish
      end
      output
    end

    def self.row_text(line : JSON::Any?, text : String) : String
      return text unless line
      object = line.as_h
      indent = " " * (object["displayIndent"]?.try(&.as_i64?) || 0_i64).to_i
      indent + string(object, "displayPrefix") + text + string(object, "displaySuffix")
    end

    private def self.source_index(object : Hash(String, JSON::Any), position : Int32) : Int64
      value = object["sourceIndex"]?
      return value.as_i64 if value && !value.raw.nil?
      position.to_i64
    end

    private def self.utf16_size(value : String) : Int32
      value.each_char.sum { |character| character.ord > 0xffff ? 2 : 1 }
    end

    private def self.number(object : Hash(String, JSON::Any), key : String) : Int64
      object[key]?.try(&.as_i64?) || 0_i64
    end

    private def self.clip_field(value : String, width = FIELD_WIDTH) : String
      used = 0
      shown = String.build do |output|
        value.each_char do |character|
          units = character.ord > 0xffff ? 2 : 1
          break if used >= width
          if used + units > width
            # JavaScript's slice can end between a surrogate pair; writing
            # that string to UTF-8 produces the replacement character.
            output << '\uFFFD'
            used += 1
            break
          end
          output << character
          used += units
        end
      end
      shown + "_" * Math.max(0, width - used)
    end

    private def self.label_and_control(label : String, control : String) : String
      label.empty? ? control : "#{label} #{control}"
    end

    private def self.transform(value : String, escape_unicode : Bool) : String
      escape_unicode ? UnicodeEscape.escape(value) : value
    end

    private def self.string(object : Hash(String, JSON::Any), key : String) : String
      object[key]?.try(&.as_s?) || ""
    end

    private def self.truthy?(value : JSON::Any?) : Bool
      return false unless value
      value.as_bool? != false && !value.raw.nil?
    end
  end
end
