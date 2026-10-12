# The three views that are not the accessibility tree.
#
# AX and INSPECT answer what the page means; PAGE answers what it visibly
# says; SOURCE answers what it is made of. Each is a page-side walk — the
# JavaScript originals, embedded as assets, so both runtimes put the same
# bytes in front of the page — and what lives here is the small half that
# turns the walk's entries into the reader's blocks.
#
# INSPECT has no walk of its own on purpose: it is derived from the exact
# items the AX view uses rather than walking a second tree and trying to
# align the two afterwards.

require "json"
require "./actions"
require "./blocks"

module Tawb
  # The PAGE view (src/render_html.js): what the page visibly says.
  module RenderHtml
    EXTRACT_VISIBLE = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/extract_visible.js") }})

    ROLE_BY_KIND = {
      "heading"    => "heading",
      "link"       => "link",
      "button"     => "button",
      "field"      => "textbox",
      "image"      => "img",
      "decoration" => "img",
      "media"      => "video",
      "frame"      => "iframe",
      "text"       => "text",
    }

    def self.blocks(entries : Array(JSON::Any), frame_id : String?) : Array(JSON::Any)
      entries.compact_map do |entry|
        object = entry.as_h
        text = render_entry(object)
        next nil if text.empty?
        item = {
          "role" => JSON::Any.new(string(object, "role").presence ||
                                  ROLE_BY_KIND[string(object, "kind")]? || "text"),
          # A control the page named nothing at all is still announced and
          # still matched by name when the view changes, so its picture
          # stands in.
          "name" => JSON::Any.new(string(object, "text").presence ||
                                  (images(object).empty? ? string(object, "text") : control_text(object))),
        } of String => JSON::Any
        {"level", "href", "editable", "file", "table", "flow"}.each do |name|
          item[name] = object[name] if object.has_key?(name)
        end
        item["renderIndex"] = object["index"] if object.has_key?("index")
        item["frame"] = JSON::Any.new(frame_id) if frame_id
        JSON::Any.new({
          "kind"        => JSON::Any.new("control"),
          "text"        => JSON::Any.new(text),
          "startsBlock" => JSON::Any.new(truthy(object["block"]?)),
          "isParagraph" => JSON::Any.new(truthy(object["paragraph"]?)),
          "item"        => JSON::Any.new(item),
          "spans"       => JSON::Any.new([] of JSON::Any),
        })
      end
    end

    private def self.render_entry(entry : Hash(String, JSON::Any)) : String
      text = string(entry, "text")
      case string(entry, "kind")
      when "heading"
        with_images("#{"#" * level_of(entry)} #{text}", entry)
      when "link"
        text.empty? ? "{#{control_text(entry)}}" : with_images("{#{text}}", entry)
      when "button"
        text.empty? ? "[*#{control_text(entry)}]" : with_images("[*#{text}]", entry)
      when "field"
        value = string(entry, "value")
        with_images("[#{value.empty? ? text : "#{text}: #{value}"}]", entry)
      when "image"
        "(image) #{text}"
      # A picture with no text of its own, named by its file. The colon is
      # what separates the two cases out loud: "(image) Welsh harpist" is the
      # page's own words for the picture, and "(image: welsh harpist)" is its
      # file name standing in because the page wrote none.
      when "decoration"
        "(image: #{text})"
      when "media"
        "(#{string(entry, "tag")}) #{text}"
      when "frame"
        text.empty? ? "<frame>" : "<frame: #{text}>"
      else
        text
      end
    end

    private def self.with_images(line : String, entry : Hash(String, JSON::Any)) : String
      names = images(entry)
      return line if names.empty?
      "#{line} (image: #{names.join(", ")})"
    end

    # A control the page named nothing at all, whose picture is therefore the
    # whole of what it says: `{(image: ccc logo)}` is a site logo linking
    # home. The brackets stay, because what the reader needs first is that
    # the line is a link.
    private def self.control_text(entry : Hash(String, JSON::Any)) : String
      text = string(entry, "text")
      return text unless text.empty?
      "(image: #{images(entry).join(", ")})"
    end

    private def self.images(entry : Hash(String, JSON::Any)) : Array(String)
      (entry["images"]?.try(&.as_a?) || [] of JSON::Any).map { |name| name.as_s? || "" }
    end

    private def self.level_of(entry : Hash(String, JSON::Any)) : Int32
      value = entry["level"]?.try(&.as_i64?) || 1_i64
      Math.max(1, Math.min(value.to_i32, 6))
    end

    private def self.string(entry : Hash(String, JSON::Any), key : String) : String
      entry[key]?.try(&.as_s?) || ""
    end

    private def self.truthy(value : JSON::Any?) : Bool
      return false unless value
      case raw = value.raw
      when Bool   then raw
      when Nil    then false
      when Int64  then raw != 0
      when String then !raw.empty?
      else             true
      end
    end
  end

  # The SOURCE view (src/source_html.js): the page's live markup.
  module SourceHtml
    EXTRACT_SOURCE = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/extract_source.js") }})

    def self.blocks(entries : Array(JSON::Any), frame_id : String?) : Array(JSON::Any)
      entries.compact_map do |entry|
        object = entry.as_h
        text = object["text"]?.try(&.as_s?) || ""
        next nil if text.strip.empty?
        name = object["text"]? || JSON::Any.new("")
        item = if object["kind"]?.try(&.as_s?) == "element"
                 tag = object["tag"]?.try(&.as_s?) || ""
                 {
                   # The same role vocabulary the other views use, so the
                   # quick navigation behaves identically here.
                   "role"     => JSON::Any.new(role_for_tag(tag)),
                   "name"     => name,
                   "tag"      => JSON::Any.new(tag),
                   "attrs"    => object["attrs"]? || JSON::Any.new({} of String => JSON::Any),
                   "domIndex" => object["index"]? || JSON::Any.new(nil),
                 } of String => JSON::Any
               else
                 # Text, comments and closing tags are structure, not
                 # something to act on.
                 {"role" => JSON::Any.new("text"), "name" => name} of String => JSON::Any
               end
        item["frame"] = JSON::Any.new(frame_id) if frame_id
        JSON::Any.new({
          "kind"  => JSON::Any.new("control"),
          "text"  => JSON::Any.new(text),
          "item"  => JSON::Any.new(item),
          "spans" => JSON::Any.new([] of JSON::Any),
        })
      end
    end

    def self.role_for_tag(tag : String) : String
      return "link" if tag == "a"
      return "button" if tag == "button"
      return "textbox" if tag == "input" || tag == "textarea" || tag == "select"
      return "heading" if tag.matches?(/^h[1-6]$/)
      tag
    end
  end

  # The INSPECT view (src/inspect_html.js): accessibility semantics and the
  # node that produced them, on one line.
  module InspectHtml
    def self.blocks(items : Array(JSON::Any), frame_id : String?) : Array(JSON::Any)
      out = [] of JSON::Any
      items.each do |item|
        object = item.as_h? || next
        next if object["role"]?.try(&.as_s?) == "__break__"
        semantic = Blocks.build([item]).first? || next
        markup = object["markup"]?.try(&.as_s?) || "<generated-accessibility-node>"
        origin = object["shadow"]?.try(&.as_s?).try { |kind| " ##{kind}-shadow-root" } || ""
        nested = object["nestedIn"]?.try(&.as_s?).try { |name| " — focusable inside #{name}" } || ""
        built = semantic.as_h.dup
        built["text"] = JSON::Any.new(
          "#{semantic.as_h["text"]?.try(&.as_s?) || ""}    #{markup}#{origin}#{nested}")
        carried = object.dup
        carried["frame"] = JSON::Any.new(frame_id) if frame_id
        built["item"] = JSON::Any.new(carried)
        out << JSON::Any.new(built)
      end
      out
    end
  end
end
