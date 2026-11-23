require "json"
require "./aria"

module Tawb
  module Blocks
    SEPARATOR_ONLY = /^[^\p{L}\p{N}]+$/
    OPENING_ONLY   = /^[([{«‹"'`¿¡]+$/
    LINK_ROLES     = {"link"}
    # Asides: their text is not the page's argument but is worth hearing.
    NOTE_ROLES     = {"note", "tooltip", "figure", "suggestion", "comment"}
    DISPLAY_DEFAULTS = {
      "context"     => "off",
      "annotations" => "status",
      "notes"       => "inline",
    }

    def self.display_option(display : Hash(String, String)?, name : String) : String
      display.try(&.[name]?) || DISPLAY_DEFAULTS[name]
    end

    # "navigation Breadcrumb" for one container in a context path.
    def self.container_label(object : Hash(String, JSON::Any)) : String
      role = string(object, "role")
      role = "container" if role.empty?
      name = string(object, "name")
      name.empty? ? role : "#{role} #{name}"
    end

    # The words a control says beyond its name, in the order a person wants
    # them: where they are, then what this control adds.
    def self.annotation_words(item : Hash(String, JSON::Any)) : String
      said_about = item["annotation"]?.try(&.as_h?)
      return "" unless said_about
      said = [] of String
      {"description" => nil, "error" => "error: ", "keyshortcuts" => "keys ",
       "haspopup" => "opens a ", "roleDescription" => nil}.each do |key, prefix|
        value = said_about[key]?.try(&.as_s?) || ""
        next if value.empty?
        said << "#{prefix}#{value}"
      end
      said.join(" — ")
    end

    def self.build(items : Array(JSON::Any), display : Hash(String, String)? = nil) : Array(JSON::Any)
      blocks = [] of JSON::Any
      pending_prefix = ""
      at_boundary = true
      context_mode = display_option(display, "context")
      annotations_mode = display_option(display, "annotations")
      notes_mode = display_option(display, "notes")
      # The containers we are inside, by depth; their roles and names are the
      # context of every line beneath them.
      containers = [] of Hash(String, JSON::Any)?
      last_context = ""
      aside_owner = nil.as(JSON::Any?)
      aside_block = nil.as(Hash(String, JSON::Any)?)

      items.each do |item|
        object = item.as_h
        role = string(object, "role")
        if role == "__break__"
          at_boundary = true
          next
        end
        # A container is a place in the page, not a line of it.
        if object["container"]?.try(&.as_bool?)
          at = (object["depth"]?.try(&.as_i?) || containers.size.to_i64).to_i
          while containers.size <= at
            containers << nil
          end
          containers[at] = object
          containers = containers[0, at + 1]
          next
        end
        depth = object["depth"]?.try(&.as_i?) || 0_i64
        context = containers[0, depth.to_i].compact_map { |one| one }
        aside_at = context.index { |one| NOTE_ROLES.includes?(string(one, "role")) }

        # An aside the reader did not ask to read in the flow: its words go to
        # the row, and one standing line says there is something here.
        if aside_at && notes_mode != "inline"
          next if notes_mode == "off"
          owner = context[aside_at]
          words = string(object, "name")
          if aside_owner.nil? || aside_owner.not_nil! != owner
            block = {
              "kind"        => JSON::Any.new("control"),
              "text"        => JSON::Any.new("[#{container_label(owner)}]"),
              "item"        => item,
              "spans"       => JSON::Any.new([] of JSON::Any),
              "startsBlock" => JSON::Any.new(true),
              "note"        => JSON::Any.new(""),
              "context"     => context_json(context),
            }
            blocks << JSON::Any.new(block)
            aside_owner = JSON::Any.new(owner)
            aside_block = block
            last_context = context_text(context)
          end
          if block = aside_block
            if previous = block["note"]?.try(&.as_s?)
              block["note"] = JSON::Any.new(join_prose(previous, words))
            end
          end
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

        line = pending_prefix.empty? ? text : "#{pending_prefix} #{text}"
        label = context_text(context)
        if context_mode == "inline" && !label.empty? && label != last_context
          line = "in: #{label} — #{line}"
        end
        last_context = label
        block = {
          "kind"        => JSON::Any.new("control"),
          "text"        => JSON::Any.new(line),
          "item"        => item,
          "spans"       => JSON::Any.new([] of JSON::Any),
          "startsBlock" => JSON::Any.new(at_boundary),
        }
        block["context"] = context_json(context) unless context.empty?
        if said_about = object["annotation"]?
          block["annotation"] = said_about
          if annotations_mode == "inline"
            said = annotation_words(object)
            block["text"] = JSON::Any.new("#{line} (#{said})") unless said.empty?
          end
        end
        blocks << JSON::Any.new(block)
        pending_prefix = ""
        at_boundary = false
      end
      blocks
    end

    def self.context_json(context : Array(Hash(String, JSON::Any))) : JSON::Any
      JSON::Any.new(context.map do |one|
        JSON::Any.new({
          "role" => JSON::Any.new(string(one, "role")),
          "name" => JSON::Any.new(string(one, "name")),
        })
      end)
    end

    def self.context_text(context : Array(Hash(String, JSON::Any))) : String
      context.map { |one| container_label(one) }.join(" › ")
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
