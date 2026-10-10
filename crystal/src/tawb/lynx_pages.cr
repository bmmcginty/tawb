require "./aria"
require "./library"

module Tawb
  # The contents of the internal pages Lynx asks for: HELP, INFO, LIST,
  # ADDRLIST, VLINKS and HISTORY, plus the one-line description DWIMHELP
  # gives.
  #
  # Each builder returns plain library rows and reads nothing but its
  # arguments, so the terminal loop keeps only the small wrapper that lifts
  # the rows into a buffer and shows them. Nothing here knows how a buffer or
  # a cursor works, which is what makes the pages testable without a terminal.
  module LynxPages
    # One row of an internal page: what it says, and what Enter would follow
    # — nil for a line that is only words. A LIST row's entry carries the
    # block object it named, so activating it uses the page's own control.
    record Row, text : String, entry : JSON::Any?

    # HELP. Lynx prints its own fixed help screen; the commands named here are
    # the ones this interface actually acts on. Imported functions with no
    # TAWB equivalent cannot be bound, so they are listed rather than hidden.
    def self.help_rows(unsupported : Array(String) = [] of String) : Array(String)
      rows = [
        "Lynx Help for TAWB",
        "",
        "Arrow keys: move to links and controls; Right or Enter activates.",
        "^ / $: first / last link or form control.",
        "Space / b: next / previous screen.",
        "g / G: enter a new address / edit the current address.",
        "/, n, N: search / next match / previous match.",
        "l / A: list references / list reference addresses.",
        "a / v: add a bookmark / view bookmarks; r removes the selected bookmark.",
        "d: download the current link.",
        "o: options menu.  k: keymap and keyboard bindings.",
        "m: return to the main screen.  \\: toggle source.",
        "x: reload without cache.  z: stop loading.",
        "Ctrl+T: toggle tracing.  ;: view the trace log.",
        "q: quit, after asking.  Q: quit without asking.",
        "Left: return from this help page.",
      ]
      unless unsupported.empty?
        rows << ""
        rows << "Unavailable Lynx functions: #{unsupported.join(", ")}"
      end
      rows
    end

    # INFO. The document and, when the reader is standing on one, the selected
    # control. Lynx's own headings, so a reader who knows the screen finds the
    # line where they expect it.
    def self.document_info_rows(title : String, url : String, source : String,
                                size : Int64, item : JSON::Any?) : Array(Row)
      rows = [
        Row.new("File that you are currently viewing", nil),
        Row.new("Linkname: #{title.empty? ? "(no title)" : title}", nil),
        Row.new("URL: #{url}", nil),
        Row.new("size: #{size} lines", nil),
        Row.new("mode: #{source == "source" ? "source" : "normal"}", nil),
      ]
      if item && focusable?(item)
        object = item.as_h
        name = text_of(object, "name")
        rows << Row.new("Link that you currently have selected", nil)
        rows << Row.new("Linkname: #{name.nil? || name.empty? ? "(unnamed)" : name}", nil)
        href = text_of(object, "href")
        rows << Row.new("URL: #{href}", nil) if href && !href.empty?
      end
      rows
    end

    # VLINKS: the links followed this session, newest first, each with the
    # address Enter would follow.
    def self.visited_rows(visited_links : Array(JSON::Any) = [] of JSON::Any) : Array(Row)
      visited_links.map do |entry|
        object = entry.as_h
        name = text_of(object, "name") || ""
        href = text_of(object, "href") || ""
        Row.new("#{name} — #{Library.short_address(href)}", JSON::Any.new({
          "title" => JSON::Any.new(name),
          "url"   => JSON::Any.new(href),
        }))
      end
    end

    # HISTORY: the documents held this session. The current one is marked,
    # since the list is read from the top and the reader wants to know where
    # "here" is.
    def self.session_rows(page_log : Array(JSON::Any) = [] of JSON::Any) : Array(Row)
      page_log.map_with_index do |entry, index|
        object = entry.as_h
        title = text_of(object, "title") || ""
        url = text_of(object, "url") || ""
        Row.new("#{index.zero? ? "here: " : ""}#{title} — #{Library.short_address(url)}",
          JSON::Any.new({
            "title" => JSON::Any.new(title),
            "url"   => JSON::Any.new(url),
          }))
      end
    end

    # LIST and ADDRLIST. A reference list points back into the current page
    # buffer, so each row keeps the block object it named rather than only its
    # address: Enter uses that to activate the page's own control, preserving
    # fragments, focus and history. The marker follows the numbering the
    # display already uses when numbering is on, and falls back to a plain
    # ordinal.
    def self.link_list_rows(blocks : Array(JSON::Any), lines : Array(JSON::Any),
                            addresses : Bool = false, numbered : Bool = false) : Array(Row)
      display_numbers = {} of Int64 => JSON::Any
      lines.each do |line|
        object = line.as_h
        number = object["displayNumber"]?
        index = object["blockIndex"]?.try(&.as_i64?)
        next unless number && index && !number.raw.nil? && number.raw != 0
        display_numbers[index] = number unless display_numbers.has_key?(index)
      end
      rows = [] of Row
      blocks.each_with_index do |block, block_index|
        item = block.as_h["item"]?
        next unless item
        object = item.as_h
        role = text_of(object, "role")
        href = text_of(object, "href")
        next unless role && href && !href.empty? && Aria::LINK_ROLES.includes?(role)
        given = display_numbers[block_index.to_i64]?
        ordinal = given ? given.raw.to_s : (rows.size + 1).to_s
        marker = numbered ? "[#{ordinal}]" : "#{rows.size + 1}."
        name = text_of(object, "name")
        description = addresses ? href : (name.nil? || name.empty? ? href : name)
        rows << Row.new("#{marker} #{description}", JSON::Any.new({
          "title" => JSON::Any.new(description),
          "url"   => JSON::Any.new(href),
          "block" => block,
        }))
      end
      rows
    end

    # DWIMHELP's answer for the control under the cursor, or nil when there
    # is none. F1 says what pressing the control would do, which for a text
    # field is to enter it rather than to go anywhere.
    def self.describe_item(item : JSON::Any?) : String?
      return nil unless item
      object = item.as_h
      name = text_of(object, "name")
      role = text_of(object, "role")
      parts = [
        name.nil? || name.empty? ? "(unnamed)" : name,
        role.nil? || role.empty? ? "item" : role,
      ]
      href = text_of(object, "href")
      parts << "goes to #{href}" if href && !href.empty?
      expanded = object["expanded"]?
      parts << "expanded" if expanded && expanded.raw == true
      parts << "collapsed" if expanded && expanded.raw == false
      parts << "disabled" if truthy?(object["disabled"]?)
      checked = object["checked"]?
      parts << (truthy?(checked) ? "checked" : "not checked") unless checked.nil?
      how = if role && Aria::FIELD_ROLES.includes?(role)
        "Typing enters it; Enter submits"
      else
        "Enter activates it"
      end
      "#{parts.join(" — ")}. #{how}."
    end

    # The trace log page is the last 500 non-blank lines of the file TAWB
    # wrote.
    def self.trace_rows(text : String) : Array(Row)
      text.split(/\r?\n/).reject(&.empty?).last(500).map do |line|
        Row.new(line, nil)
      end
    end

    private def self.focusable?(item : JSON::Any) : Bool
      role = text_of(item.as_h, "role")
      role ? Aria::FOCUSABLE_ROLES.includes?(role) : false
    end

    private def self.text_of(object : Hash(String, JSON::Any), name : String) : String?
      object[name]?.try(&.as_s?)
    end

    private def self.truthy?(value : JSON::Any?) : Bool
      return false if value.nil?
      !(value.raw.nil? || value.raw == false)
    end
  end
end
