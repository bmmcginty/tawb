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
    KNOWN_SETTINGS = BOOLEAN_SETTINGS + {"keypadMode", "searchCase"}

    def self.lynx_settings_path(env : Hash(String, String) = ENV.to_h,
                                home : String = Path.home.to_s) : String
      base = env["XDG_CONFIG_HOME"]? || File.join(home, ".config")
      File.join(base, "tawb", "settings.lynx.json")
    end

    # What a settings document is allowed to hold, and nothing else: the
    # reader's own choices live under the lynx key, at version one.
    def self.validate_lynx_settings(root : JSON::Any, file : String) : Hash(String, JSON::Any)
      parsed = root.as_h?
      raise ArgumentError.new("the root must be an object") unless parsed
      misplaced = parsed.keys.reject { |key| key.in?({"version", "lynx"}) }
      unless misplaced.empty?
        raise ArgumentError.new("settings must be under the lynx key (found #{misplaced.join(", ")})")
      end
      raise ArgumentError.new("version must be 1") unless parsed["version"]?.try(&.as_i64?) == 1
      settings = parsed["lynx"]?.try(&.as_h?) || raise ArgumentError.new("lynx must be an object")
      result = {} of String => JSON::Any
      settings.each do |name, value|
        unless KNOWN_SETTINGS.includes?(name)
          raise ArgumentError.new("unknown lynx setting #{name}")
        end
        if BOOLEAN_SETTINGS.includes?(name)
          raise ArgumentError.new("#{name} must be true or false") unless value.raw.is_a?(Bool)
        elsif name == "keypadMode"
          mode = value.as_s?
          raise ArgumentError.new("invalid keypadMode #{value.raw}") unless mode
          raise ArgumentError.new("invalid keypadMode #{mode}") unless KEYPAD_MODES.includes?(mode)
        elsif name == "searchCase"
          search = value.as_s?
          raise ArgumentError.new("invalid searchCase #{value.raw}") unless search
          raise ArgumentError.new("invalid searchCase #{search}") unless SEARCH_CASES.includes?(search)
        end
        result[name] = value
      end
      result
    end

    # What the saved settings say over what the import already supplies. A
    # saved keypad mode is the one truth for numbering, so it derives the
    # numberLinks and numberFields flags rather than letting a stale import
    # disagree with it.
    def self.merge_lynx_settings(imported : Hash(String, JSON::Any),
                                 saved : Hash(String, JSON::Any)) : Hash(String, JSON::Any)
      preferences = imported.dup
      saved.each { |name, value| preferences[name] = value }
      if saved.has_key?("keypadMode")
        mode = saved["keypadMode"].as_s?
        preferences["numberLinks"] = JSON::Any.new(
          mode == "LINKS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
        preferences["numberFields"] = JSON::Any.new(
          mode == "FIELDS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
      end
      preferences
    end

    # The settings the reader saved, validated. A missing file is optional;
    # a broken one names itself.
    def self.read_lynx_settings(env : Hash(String, String) = ENV.to_h,
                                home : String = Path.home.to_s,
                                file : String? = nil) : Hash(String, JSON::Any)
      target = file || lynx_settings_path(env, home)
      text = File.read(target)
      begin
        validate_lynx_settings(JSON.parse(text), target)
      rescue error
        raise ArgumentError.new("Cannot read Lynx settings from #{target}: #{error.message}")
      end
    rescue File::NotFoundError
      {} of String => JSON::Any
    end

    # Settings are written atomically, mode 0600, after validating the exact
    # document that will land on disk.
    def self.write_lynx_settings(settings : Hash(String, JSON::Any),
                                 env : Hash(String, String) = ENV.to_h,
                                 home : String = Path.home.to_s,
                                 file : String? = nil) : Nil
      target = file || lynx_settings_path(env, home)
      document = JSON::Any.new({
        "version" => JSON::Any.new(1),
        "lynx"    => JSON::Any.new(settings),
      })
      validate_lynx_settings(document, target)
      Dir.mkdir_p(File.dirname(target))
      temporary = "#{target}.#{Process.pid}.tmp"
      File.write(temporary, "#{document.to_pretty_json}\n", perm: File::Permissions.new(0o600))
      File.rename(temporary, target)
    end

    # The derived preferences the Lynx dump needs: what TAWB holds, over the
    # numbering-relevant defaults. A missing file is the defaults untouched.
    def self.preferences(env : Hash(String, String) = ENV.to_h) : Hash(String, JSON::Any)
      settings = read_lynx_settings(env)
      result = {
        "numberLinks"        => JSON::Any.new(false),
        "numberFields"       => JSON::Any.new(false),
        "numberLinksOnLeft"  => JSON::Any.new(true),
        "numberFieldsOnLeft" => JSON::Any.new(true),
      }
      settings.each do |name, value|
        case name
        when "keypadMode"
          mode = value.as_s
          result["numberLinks"] = JSON::Any.new(mode.in?({"LINKS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED"}))
          result["numberFields"] = JSON::Any.new(mode.in?({"FIELDS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED"}))
        when "numberLinksOnLeft", "numberFieldsOnLeft"
          result[name] = value
        end
      end
      result
    end
  end
end
