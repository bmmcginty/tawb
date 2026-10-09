require "json"

module Tawb
  module LynxSettings
    KEYPAD_MODES = {
      "NUMBERS_AS_ARROWS", "LINKS_ARE_NUMBERED",
      "FIELDS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED",
    }
    SEARCH_CASES     = {"CASE_INSENSITIVE", "CASE_SENSITIVE"}
    BOOLEAN_SETTINGS = {
      "numberLinksOnLeft", "numberFieldsOnLeft", "textfieldsNeedActivation", "showCursor",
    }

    def self.preferences(env : Hash(String, String) = ENV.to_h) : Hash(String, JSON::Any)
      result = {
        "numberLinks"        => JSON::Any.new(false),
        "numberFields"       => JSON::Any.new(false),
        "numberLinksOnLeft"  => JSON::Any.new(true),
        "numberFieldsOnLeft" => JSON::Any.new(true),
      }
      base = env["XDG_CONFIG_HOME"]? || File.join(Path.home, ".config")
      file = File.join(base, "tawb", "settings.lynx.json")
      return result unless File.exists?(file)

      begin
        root = JSON.parse(File.read(file)).as_h
        misplaced = root.keys.reject { |key| key.in?({"version", "lynx"}) }
        unless misplaced.empty?
          raise ArgumentError.new("settings must be under the lynx key (found #{misplaced.join(", ")})")
        end
        raise ArgumentError.new("version must be 1") unless root["version"]?.try(&.as_i64?) == 1
        settings = root["lynx"]?.try(&.as_h?) || raise ArgumentError.new("lynx must be an object")
        settings.each do |name, value|
          case name
          when "keypadMode"
            mode = value.as_s? || raise ArgumentError.new("invalid keypadMode #{value.raw}")
            raise ArgumentError.new("invalid keypadMode #{mode}") unless KEYPAD_MODES.includes?(mode)
            result["numberLinks"] = JSON::Any.new(mode.in?({"LINKS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED"}))
            result["numberFields"] = JSON::Any.new(mode.in?({"FIELDS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED"}))
          when "searchCase"
            search = value.as_s? || raise ArgumentError.new("invalid searchCase #{value.raw}")
            raise ArgumentError.new("invalid searchCase #{search}") unless SEARCH_CASES.includes?(search)
          else
            unless BOOLEAN_SETTINGS.includes?(name)
              raise ArgumentError.new("unknown lynx setting #{name}")
            end
            raise ArgumentError.new("#{name} must be true or false") unless value.raw.is_a?(Bool)
            result[name] = value if name == "numberLinksOnLeft" || name == "numberFieldsOnLeft"
          end
        end
        result
      rescue error
        raise ArgumentError.new("Cannot read Lynx settings from #{file}: #{error.message}")
      end
    end
  end
end
