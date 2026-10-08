require "json"
require "./aria"

module Tawb
  module Blocks
    SEPARATOR_ONLY = /^[^\p{L}\p{N}]+$/
    OPENING_ONLY   = /^[([{«‹"'`¿¡]+$/
    LINK_ROLES     = {"link"}

    def self.build(items : Array(JSON::Any)) : Array(JSON::Any)
      blocks = [] of JSON::Any
      pending_prefix = ""
      at_boundary = true

      items.each do |item|
        object = item.as_h
        role = string(object, "role")
        if role == "__break__"
          at_boundary = true
          next
        end
        text = Aria.render_line(item)
        next if text.empty?

        if separator_text?(object)
          if OPENING_ONLY.matches?(string(object, "name"))
            pending_prefix = pending_prefix.empty? ? text : "#{pending_prefix} #{text}"
            next
          end
          if previous = blocks.last?
            previous_object = previous.as_h
            if LINK_ROLES.includes?(string(previous_object["item"].as_h, "role"))
              previous_object["text"] = JSON::Any.new("#{previous_object["text"].as_s} #{text}")
              next
            end
          end
        end

        previous = blocks.last?
        if continues_prose?(object, previous, at_boundary)
          previous_object = previous.not_nil!.as_h
          addition = pending_prefix.empty? ? text : "#{pending_prefix} #{text}"
          previous_object["text"] = JSON::Any.new(join_prose(previous_object["text"].as_s, addition))
          previous_item = previous_object["item"].as_h
          previous_item["name"] = JSON::Any.new(join_prose(
            string(previous_item, "name"), string(object, "name")
          ))
          previous_item.delete("flow") if previous_item["flow"]? != object["flow"]?
          pending_prefix = ""
          next
        end

        blocks << JSON::Any.new({
          "kind"        => JSON::Any.new("control"),
          "text"        => JSON::Any.new(pending_prefix.empty? ? text : "#{pending_prefix} #{text}"),
          "item"        => item,
          "spans"       => JSON::Any.new([] of JSON::Any),
          "startsBlock" => JSON::Any.new(at_boundary),
        })
        pending_prefix = ""
        at_boundary = false
      end
      blocks
    end

    def self.fold(blocks : Array(JSON::Any)) : Array(JSON::Any)
      output = [] of JSON::Any
      pending_prefix = ""
      blocks.each do |block|
        object = block.as_h
        item = object["item"].as_h
        text = object["text"].as_s
        separator = string(item, "role") == "text" && SEPARATOR_ONLY.matches?(text)
        if separator
          if OPENING_ONLY.matches?(text)
            pending_prefix = pending_prefix.empty? ? text : "#{pending_prefix} #{text}"
            next
          end
          if previous = output.last?
            previous_object = previous.as_h
            if LINK_ROLES.includes?(string(previous_object["item"].as_h, "role"))
              previous_object["text"] = JSON::Any.new("#{previous_object["text"].as_s} #{text}")
              next
            end
          end
        end

        unless pending_prefix.empty?
          object["text"] = JSON::Any.new("#{pending_prefix} #{text}")
          pending_prefix = ""
        end
        previous = output.last?
        if continues_prose?(item, previous, object["startsBlock"]?.try(&.as_bool?) || false)
          previous_object = previous.not_nil!.as_h
          previous_object["text"] = JSON::Any.new(join_prose(
            previous_object["text"].as_s, object["text"].as_s
          ))
          previous_item = previous_object["item"].as_h
          previous_item["name"] = JSON::Any.new(join_prose(
            string(previous_item, "name"), string(item, "name")
          ))
          previous_item.delete("flow") if previous_item["flow"]? != item["flow"]?
          next
        end
        output << block
      end
      output
    end

    def self.join_prose(before : String, after : String) : String
      return after if before.empty?
      return before if after.empty?
      return before + after if after.matches?(/^[,.;:!?%)\]}»›…]/)
      return before + after if before.matches?(/[([{«‹"'`¿¡]$/)
      "#{before} #{after}"
    end

    private def self.separator_text?(item) : Bool
      string(item, "role") == "text" && SEPARATOR_ONLY.matches?(string(item, "name"))
    end

    private def self.continues_prose?(item, previous : JSON::Any?, at_boundary : Bool) : Bool
      return false unless string(item, "role") == "text" && !at_boundary && previous
      string(previous.as_h["item"].as_h, "role") == "text"
    end

    private def self.string(object : Hash(String, JSON::Any), key : String) : String
      object[key]?.try(&.as_s?) || ""
    end
  end
end
