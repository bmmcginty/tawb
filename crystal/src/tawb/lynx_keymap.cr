require "./lynx_config"

module Tawb
  # The Lynx key file, written in Lynx's own words.
  #
  # `keys-lynx.json` is keyed by Lynx function name rather than by TAWB's
  # action id, so the file, the imported map and the keyboard screen all say
  # the same thing: LIST, ADDRLIST, NEXT_LINK, FASTFORW_LINK, DOWN_LINK. A
  # reader who knows Lynx can read their own bindings without a translation
  # table, and one Lynx function is always one entry, because the interface
  # keeps them as separate actions rather than folding them together.
  #
  # The things TAWB can do and Lynx cannot get a name of their own in the same
  # namespace, under a TAWB_ prefix. That keeps one lookup table and one file
  # rather than two of each, and says plainly which entries are not Lynx's.
  module LynxKeymap
    EXTENSION_FUNCTIONS = {
      "TAWB_CYCLE_VIEW"       => "cycle-view",
      "TAWB_PAGE_KEYBOARD"    => "page-keyboard",
      "TAWB_REAL_CLICK"       => "real-click",
      "TAWB_HOVER_LINE"       => "hover-line",
      "TAWB_BROWSER_QUESTION" => "browser-question",
      "TAWB_CLOSE_POPUP"      => "close-popup",
      "TAWB_NEW_TAB"          => "new-tab",
      "TAWB_NEXT_TAB"         => "next-tab",
      "TAWB_PREVIOUS_TAB"     => "previous-tab",
      "TAWB_CLOSE_TAB"        => "close-tab",
    }

    # Every Lynx function the interface acts on, plus the extensions. Later
    # tables overwrite earlier names, the way JavaScript's object spread does.
    FUNCTION_ACTIONS = begin
      merged = {} of String => String
      LynxConfig::BROWSE_FUNCTIONS.each { |name, action| merged[name] = action }
      LynxConfig::EDIT_FUNCTIONS.each { |name, action| merged[name] = action }
      EXTENSION_FUNCTIONS.each { |name, action| merged[name] = action }
      merged
    end

    # The name an action is written under. Lynx's own names come first, so an
    # action with both a Lynx function and an extension is written as the
    # function.
    ACTION_FUNCTIONS = begin
      names = {} of String => String
      tables = [LynxConfig::BROWSE_FUNCTIONS, LynxConfig::EDIT_FUNCTIONS, EXTENSION_FUNCTIONS]
      tables.each do |table|
        table.each do |name, action|
          names[action] = name unless names.has_key?(action)
        end
      end
      names
    end

    VERSION         = 2
    ACTIONS_VERSION = 1

    def self.action_for_function(name : String) : String?
      FUNCTION_ACTIONS[name]?
    end

    def self.function_for_action(id : String) : String?
      ACTION_FUNCTIONS[id]?
    end

    # The function name a keymap should write each of its actions under, for
    # the screen that shows them. Empty for the ordinary interface, whose
    # actions are not Lynx's.
    def self.function_names(ids : Enumerable(String)) : Hash(String, String)
      names = {} of String => String
      ids.each do |id|
        name = function_for_action(id)
        names[id] = name if name
      end
      names
    end

    # A key file as action bindings, whichever version wrote it.
    #
    # Version 1 was keyed by TAWB action id and was written before the
    # functions were given their own actions. It is read here rather than by a
    # separate migration step, so a reader who upgrades and opens the keyboard
    # screen has their bindings and then saves them in the new shape — no
    # editing by hand. Version 1's values are returned exactly as they were
    # written; the keymap validates them, and anything it cannot use is
    # dropped there. Version 2's values are validated here, entry by entry.
    def self.parse_key_file(text : String) : Hash(String, JSON::Any)?
      parsed = JSON.parse(text)
      object = parsed.as_h?
      return nil unless object

      version = object["version"]?.try(&.as_i?)
      if version == VERSION
        functions = object["functions"]?.try(&.as_h?)
        return nil unless functions
        actions = {} of String => JSON::Any
        functions.each do |name, bindings|
          action = action_for_function(name) || next
          list = bindings.as_a?
          next unless list && list.all?(&.as_s?)
          actions[action] = bindings
        end
        return actions
      end

      if version == ACTIONS_VERSION
        actions = object["actions"]?.try(&.as_h?)
        return actions if actions
      end

      nil
    rescue JSON::ParseException
      nil
    end

    # A JSON string written the way JavaScript's JSON.stringify writes one:
    # the six named control escapes, \uXXXX for the rest, and every other
    # character — including non-ASCII — exactly as it is. The file is small
    # and its shape fixed, so it is written by hand rather than through a
    # writer whose indenting and escaping may not agree byte for byte.
    def self.json_escape(text : String) : String
      String.build do |io|
        text.each_char do |char|
          case char
          when '"'  then io << "\\\""
          when '\\' then io << "\\\\"
          when '\b' then io << "\\b"
          when '\f' then io << "\\f"
          when '\n' then io << "\\n"
          when '\r' then io << "\\r"
          when '\t' then io << "\\t"
          else
            if char < ' '
              io << "\\u" << char.ord.to_s(16, upcase: true).rjust(4, '0')
            else
              io << char
            end
          end
        end
      end
    end

    def self.serialise_key_file(entries : Enumerable(NamedTuple(id: String, bindings: Array(String)))) : String
      String.build do |io|
        io << "{\n  \"version\": #{VERSION},\n  \"functions\": "
        named = entries.compact_map do |entry|
          name = function_for_action(entry[:id])
          # An action no Lynx function names cannot be written in a file keyed
          # by Lynx's names. There are none in this interface; if one is ever
          # added without a name, it is left out rather than written under a
          # name that would load back as something else.
          name ? {name, entry[:bindings]} : nil
        end
        if named.empty?
          io << "{}\n}\n"
          next
        end
        io << "{"
        named.each_with_index do |(name, bindings), index|
          io << (index.zero? ? "\n" : ",\n")
          io << "    \"" << json_escape(name) << "\": "
          if bindings.empty?
            io << "[]"
          else
            io << "["
            bindings.each_with_index do |binding, position|
              io << (position.zero? ? "\n" : ",\n")
              io << "      \"" << json_escape(binding) << "\""
            end
            io << "\n    ]"
          end
        end
        io << "\n  }\n}\n"
      end
    end
  end
end
