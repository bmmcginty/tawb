require "./keys"
require "./lynx_config"
require "./lynx_settings"

module Tawb
  # TAWB's Lynx state: the keymap and the preferences, taken from Lynx once
  # and owned afterwards.
  #
  # The Lynx configuration is read once and then belongs to TAWB. The first
  # Lynx run, when there is no keys-lynx.json, imports it and writes our own
  # files; every run after that reads ours without running the Lynx binary or
  # opening its configuration at all. `--lynx-reimport` asks for the import
  # again and overwrites what we hold.
  #
  # The point is that the reader's Lynx setup is taken deliberately and does
  # not move under them between runs. The cost is the one the flag exists
  # for: a change to .lynxrc or lynx.cfg is not seen until they ask for it.
  module LynxState
    # What of the preferences can be persisted: only the settings the options
    # screen knows. The rest of lynx_options.js arrives with the screens.
    def self.persistable_options(preferences : Hash(String, JSON::Any)) : Hash(String, JSON::Any)
      preferences.select { |name, _| LynxSettings::KNOWN_SETTINGS.includes?(name) }
    end

    # The preferences a run needs without running Lynx or writing anything:
    # what TAWB already holds, over the built-in defaults. The non-interactive
    # Lynx dump uses this, so a text filter never imports a configuration or
    # rewrites one. A machine that has only ever dumped a page therefore gets
    # the Lynx defaults until an interactive run does the one import.
    def self.lynx_preferences(read_lynx : Proc(Hash(String, JSON::Any))? = nil) : Hash(String, JSON::Any)
      saved = read_lynx ? read_lynx.call : LynxSettings.read_lynx_settings
      LynxSettings.merge_lynx_settings(LynxConfig::DEFAULT_PREFERENCES, saved)
    end

    # The keymap a reader runs on: ours from the first import onwards, or the
    # one import that creates it. Every seam is injectable — the import, the
    # settings read and write, where the key file lives, whether it exists —
    # which is how the differenced tests drive both runtimes through the same
    # files and fakes.
    def self.lynx_keymap_for(lynx_reimport : Bool = false,
                             lynx_executable : String? = nil,
                             lynx_config : String? = nil,
                             import_lynx : Proc(String?, String?, LynxConfig::Imported)? = nil,
                             read_lynx : Proc(Hash(String, JSON::Any))? = nil,
                             write_lynx : Proc(Hash(String, JSON::Any), Nil)? = nil,
                             keys_file : String? = nil,
                             has_keys : Proc(String, Bool)? = nil,
                             env : Hash(String, String) = ENV.to_h) : Keys::Keymap
      reader = read_lynx || -> { LynxSettings.read_lynx_settings(env) }
      writer = write_lynx || ->(settings : Hash(String, JSON::Any)) : Nil {
        LynxSettings.write_lynx_settings(settings, env)
        nil
      }
      importer = import_lynx || ->(executable : String?, config : String?) {
        LynxConfig.read_lynx_config(executable || "lynx", config, env)
      }
      exists = has_keys || ->(path : String) { File.exists?(path) }
      file = keys_file || Keys.config_path(
        env["XDG_CONFIG_HOME"]?, env["HOME"]? || Path.home.to_s, "lynx")
      saved = reader.call
      unless lynx_reimport || !exists.call(file)
        # Ours, and only ours: Lynx is not run and its files are not opened.
        return Keys::Keymap.new(profile: "lynx", file: file,
          preferences: LynxSettings.merge_lynx_settings(LynxConfig::DEFAULT_PREFERENCES, saved))
      end

      imported = importer.call(lynx_executable, lynx_config)
      preferences = if lynx_reimport
        LynxSettings.merge_lynx_settings(imported.preferences, {} of String => JSON::Any)
      else
        LynxSettings.merge_lynx_settings(imported.preferences, saved)
      end

      # Nothing to write when Lynx could not be read: leaving keys-lynx.json
      # absent means a later run, after Lynx is installed, imports for real
      # rather than reading a file frozen from the built-in fallback map.
      if imported.available == false
        return Keys::Keymap.new(profile: "lynx", file: file, read_file: false,
          bindings: {} of String => Array(String),
          unsupported: imported.unsupported, preferences: preferences)
      end

      # A first run keeps any preferences already saved in TAWB, as they are
      # the reader's own choice; a reimport overwrites them, which is what
      # asking for one means. The map is written from the import, not loaded
      # over, so a reimport replaces an earlier snapshot instead of merging
      # with it.
      keymap = Keys::Keymap.new(profile: "lynx", file: file, read_file: false,
        bindings: imported.bindings, unsupported: imported.unsupported,
        preferences: preferences)
      keymap.save
      writer.call(persistable_options(preferences))
      keymap
    end
  end
end
