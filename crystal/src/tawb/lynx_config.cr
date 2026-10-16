module Tawb
  # The Lynx function vocabulary the compatibility interface acts on.
  #
  # These are the tables the Lynx adapter shares with the key-file format in
  # lynx_keymap.cr, together with the importer that reads a running Lynx's
  # effective keymaps (src/lynx_config.js): lynx is asked to dump
  # LYNXKEYMAP: and LYNXEDITMAP:, those dumps are translated by function
  # name, and interaction preferences come from -show_cfg with .lynxrc
  # winning, as they do in Lynx itself.
  #
  # An empty entry is deliberate: it keeps a TAWB reading command from leaking
  # into Lynx merely because nobody supplied a Lynx equivalent for it.
  module LynxConfig
    BROWSE_FUNCTIONS = {
      "QUIT" => "confirm-quit", "ABORT" => "abort",
      "GOTO" => "goto", "ELGOTO" => "link-address", "ECGOTO" => "location-edit",
      "PREV_DOC" => "history-back", "NEXT_DOC" => "history-forward",
      "ACTIVATE" => "activate",
      "DOWN_TWO" => "next-line", "UP_TWO" => "previous-line",
      "NEXT_PAGE" => "next-screen",
      # JavaScript reads a repeated key in an object literal as its last
      # entry, so DOWN_HALF and UP_HALF name the half-screen movements; the
      # whole-page movements are named by NEXT_PAGE and PREV_PAGE alone.
      "PREV_PAGE" => "previous-screen",
      "HOME" => "top", "END" => "bottom",
      "ADD_BOOKMARK" => "add-bookmark", "DEL_BOOKMARK" => "delete-bookmark", "VIEW_BOOKMARK" => "bookmarks",
      "VLINKS" => "visited-links", "HISTORY" => "session-history", "DOWNLOAD" => "download-link",
      "LIST" => "list-links", "ADDRLIST" => "list-addresses",
      "INFO" => "document-info", "OPTIONS" => "options", "F_LINK_NUM" => "link-number",
      "WHEREIS" => "find-forward", "NEXT" => "repeat-find-forward", "PREV" => "repeat-find-backward",
      "REFRESH" => "refresh", "RELOAD" => "reload-page", "NOCACHE" => "reload-no-cache", "INTERRUPT" => "interrupt",
      "TRACE_TOGGLE" => "toggle-trace", "TRACE_LOG" => "trace-log",
      "SOURCE" => "source-view", "KEYMAP" => "keyboard-wizard", "HELP" => "help", "DWIMHELP" => "context-help",
      "MAIN_MENU" => "main-menu",
      "NEXT_LINK" => "next-focusable", "FASTFORW_LINK" => "fast-forward-link", "DOWN_LINK" => "down-link",
      "PREV_LINK" => "previous-focusable", "FASTBACKW_LINK" => "fast-backward-link", "UP_LINK" => "up-link",
      "DOWN_HALF" => "next-half-screen", "UP_HALF" => "previous-half-screen",
      "FIRST_LINK" => "first-focusable", "LAST_LINK" => "last-focusable",
    }

    EDIT_FUNCTIONS = {
      "BOL" => "edit-line-start", "EOL" => "edit-line-end",
      "BACK" => "edit-previous-character", "FORW" => "edit-next-character",
      "DELP" => "edit-backspace", "DELN" => "edit-delete",
      "BACKW" => "edit-previous-word", "FORWW" => "edit-next-word",
      "DELPW" => "edit-backspace-word", "DELNW" => "edit-delete-word",
      "ERASE" => "edit-kill-start", "DELEL" => "edit-kill-end", "LKCMD" => "edit-command",
    }

    # Lynx's names for keys that are not plain printable characters.
    KEY_NAMES = {
      "<tab>"      => "Tab", "<return>" => "Enter", "<space>" => "Space",
      "<delete>"   => "Backspace", "Up Arrow" => "ArrowUp", "Down Arrow" => "ArrowDown",
      "Left Arrow" => "ArrowLeft", "Right Arrow" => "ArrowRight",
      "Page Up"    => "PageUp", "Page Down" => "PageDown",
      "Home"       => "Home", "End" => "End", "Back Tab" => "Shift+Tab",
    }

    # Interaction preferences the adapter can honour, before any file is
    # read. Lynx hides the cursor at the bottom-right by default and only
    # moves it to the current link when SHOW_CURSOR is on (LYrcFile.c: the
    # setting is documented as being for speech and braille interfaces,
    # which is why it matters here at all).
    DEFAULT_PREFERENCES = {
      "keypadMode"                 => JSON::Any.new("NUMBERS_AS_ARROWS"),
      "numberLinks"                => JSON::Any.new(false),
      "numberFields"               => JSON::Any.new(false),
      "numberLinksOnLeft"          => JSON::Any.new(true),
      "numberFieldsOnLeft"         => JSON::Any.new(true),
      "textfieldsNeedActivation"   => JSON::Any.new(false),
      "searchCase"                 => JSON::Any.new("CASE_INSENSITIVE"),
      "showCursor"                 => JSON::Any.new(false),
    }

    # What one map dump translated into, and which Lynx functions the
    # adapter has no meaning for.
    record Bindings, bindings : Hash(String, Array(String)), unsupported : Array(String)
    record Imported, available : Bool, bindings : Hash(String, Array(String)),
      unsupported : Array(String), preferences : Hash(String, JSON::Any)

    # One injected lynx run: the exit status and standard output. Nil means
    # lynx could not be run at all.
    record RunResult, status : Int32, stdout : String
    alias LynxRunner = Proc(String, Array(String), Hash(String, String), RunResult?)

    # A Lynx key description becomes a portable TAWB key specification:
    # named keys are translated, control characters gain their prefix, and
    # anything that is not one printable character is refused rather than
    # guessed at.
    def self.key_spec(text : String) : String?
      key = text.strip
      return KEY_NAMES[key]? if KEY_NAMES.has_key?(key)
      if control = /^\^(.)$/.match(key)
        return "Ctrl+#{control[1]}"
      end
      return key if /^F(?:[1-9]|1[0-2])$/.matches?(key)
      return key if key.chars.size == 1
      nil
    end

    private def self.add_binding(bindings : Hash(String, Array(String)), action : String, key : String) : Nil
      list = bindings[action]?
      if list
        list << key unless list.includes?(key)
      else
        bindings[action] = [key]
      end
    end

    private def self.empty_bindings(functions : Hash(String, String)) : Hash(String, Array(String))
      result = {} of String => Array(String)
      functions.each_value.uniq.each { |action| result[action] = [] of String }
      result
    end

    # The effective browse-mode map: twelve columns of key, a Lynx function
    # name, then a description nobody parses.
    def self.parse_browse_map(text : String) : Bindings
      bindings = empty_bindings(BROWSE_FUNCTIONS)
      unsupported = Set(String).new
      text.split(/\r?\n/).each do |line|
        match = /^(.{12})([A-Z][A-Z0-9_]*)\s/.match(line)
        next unless match
        key = key_spec(match[1])
        next unless key
        action = BROWSE_FUNCTIONS[match[2]]?
        if action
          add_binding(bindings, action, key)
        else
          unsupported << match[2]
        end
      end
      Bindings.new(bindings, unsupported.to_a.sort)
    end

    private def self.split_edit_keys(text : String) : Array(String)
      text.split(',').map(&.strip).reject(&.empty?)
    end

    # The line-editor map: one entry per function with its keys after a
    # dash, and continuations indented under the entry they belong to.
    # Character ranges describe insertable text, not command bindings.
    def self.parse_edit_map(text : String) : Bindings
      bindings = empty_bindings(EDIT_FUNCTIONS)
      unsupported = Set(String).new
      current : String? = nil
      text.split(/\r?\n/).each do |line|
        keys : String?
        if first = /^\s{2}([A-Z][A-Z0-9]*)\s+.*?\s+-\s+(.*)$/.match(line)
          current = first[1]
          keys = first[2]
        else
          continuation = /^\s{20,}(.+)$/.match(line)
          next unless continuation && current
          keys = continuation[1]
        end
        action = EDIT_FUNCTIONS[current.not_nil!]?
        split_edit_keys(keys.not_nil!).each do |token|
          next if /^\d/.matches?(token)
          key = key_spec(token.sub(/[.]$/, ""))
          next unless key
          if action
            add_binding(bindings, action, key)
          else
            unsupported << current.not_nil!
          end
        end
      end
      Bindings.new(bindings, unsupported.to_a.sort)
    end

    # Both maps together: the bindings merge, the unsupported sets union.
    private def self.imported_defaults(browse : Bindings, edit : Bindings) : Bindings
      bindings = browse.bindings.dup
      edit.bindings.each do |action, keys|
        merged = bindings[action]? || [] of String
        bindings[action] = merged + keys.reject { |key| merged.includes?(key) }
      end
      unsupported = (browse.unsupported + edit.unsupported).uniq.sort
      Bindings.new(bindings, unsupported)
    end

    private def self.boolean_value(value : String, fallback : Bool) : Bool
      return true if /^(true|on|yes|1)$/i.matches?(value)
      return false if /^(false|off|no|0)$/i.matches?(value)
      fallback
    end

    private def self.apply_keypad_mode(preferences : Hash(String, JSON::Any), value : String?) : Nil
      mode = (value || "").strip.upcase
        .sub("LINKS_AND_FORM_FIELDS_ARE_NUMBERED", "LINKS_AND_FIELDS_ARE_NUMBERED")
        .sub("LINKS_ARE_NOT_NUMBERED", "NUMBERS_AS_ARROWS")
      return unless {"NUMBERS_AS_ARROWS", "LINKS_ARE_NUMBERED", "FIELDS_ARE_NUMBERED",
                      "LINKS_AND_FIELDS_ARE_NUMBERED"}.includes?(mode)
      preferences["keypadMode"] = JSON::Any.new(mode)
      preferences["numberLinks"] = JSON::Any.new(
        mode == "LINKS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
      preferences["numberFields"] = JSON::Any.new(
        mode == "FIELDS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
    end

    # Interaction preferences from -show_cfg output, then .lynxrc — read
    # after lynx.cfg, and winning, exactly as in Lynx. Only settings the
    # adapter can honour are considered; browser, cookie, proxy, viewer, and
    # command settings stay entirely with Lynx.
    def self.parse_preferences(show_config : String, lynxrc = "") : Hash(String, JSON::Any)
      preferences = DEFAULT_PREFERENCES.dup
      show_config.split(/\r?\n/).each do |raw|
        match = /^([A-Z][A-Z0-9_]*):(.*)$/.match(raw.strip)
        next unless match
        name, value = match[1], match[2]
        if name == "DEFAULT_KEYPAD_MODE"
          apply_keypad_mode(preferences, value)
        elsif name == "SHOW_CURSOR"
          preferences["showCursor"] = JSON::Any.new(boolean_value(value, preferences["showCursor"].as_bool))
        elsif name == "NUMBER_LINKS_ON_LEFT"
          preferences["numberLinksOnLeft"] = JSON::Any.new(boolean_value(value, preferences["numberLinksOnLeft"].as_bool))
        elsif name == "NUMBER_FIELDS_ON_LEFT"
          preferences["numberFieldsOnLeft"] = JSON::Any.new(boolean_value(value, preferences["numberFieldsOnLeft"].as_bool))
        elsif name == "TEXTFIELDS_NEED_ACTIVATION"
          preferences["textfieldsNeedActivation"] = JSON::Any.new(boolean_value(value, preferences["textfieldsNeedActivation"].as_bool))
        end
      end
      lynxrc.split(/\r?\n/).each do |line|
        if match = /^\s*keypad_mode\s*=\s*(\S+)/i.match(line)
          apply_keypad_mode(preferences, match[1])
        end
        if cursor = /^\s*show_cursor\s*=\s*(\S+)/i.match(line)
          preferences["showCursor"] = JSON::Any.new(boolean_value(cursor[1], preferences["showCursor"].as_bool))
        end
      end
      preferences
    end

    # One lynx run, without a shell, with a hard three-second bound: lynx
    # dumping a pseudo-URL answers at once or not at all, and a hung one
    # must not hang the reader.
    private def self.run_lynx(executable : String, args : Array(String),
                              env : Hash(String, String)) : RunResult?
      process = Process.new(executable, args, env: env,
        input: Process::Redirect::Close, output: Process::Redirect::Pipe,
        error: Process::Redirect::Close)
      output = Channel(String).new
      spawn { output.send(process.output.gets_to_end) }
      deadline = Time.instant + 3.seconds
      while process.exists? && Time.instant < deadline
        sleep 50.milliseconds
      end
      if process.exists?
        process.signal(Signal::KILL)
        return nil
      end
      text = output.receive
      status = process.wait
      RunResult.new(status.exit_code, text)
    rescue
      nil
    end

    # Ask a real Lynx for its effective configuration
    # (src/lynx_config.js readLynxConfig). One unreadable map makes the whole
    # import fall back to built-in defaults rather than half-apply; the
    # runner is injectable so the import can be tested without lynx.
    def self.read_lynx_config(executable = "lynx", config : String? = nil,
                              env : Hash(String, String) = ENV.to_h,
                              run : LynxRunner? = nil,
                              read_file : Proc(String, String)? = nil) : Imported
      child_env = env.dup
      child_env["LC_ALL"] = "C"
      child_env["LANG"] = "C"
      child_env["LYNX_CFG"] = config if config
      ask = run || ->(command : String, args : Array(String),
                      options : Hash(String, String)) { run_lynx(command, args, options) }
      browse = ask.call(executable, ["-dump", "LYNXKEYMAP:"], child_env)
      edit = ask.call(executable, ["-dump", "LYNXEDITMAP:"], child_env)
      unless browse && browse.status == 0 && edit && edit.status == 0
        return Imported.new(false, {} of String => Array(String), [] of String,
          DEFAULT_PREFERENCES.dup)
      end
      shown = ask.call(executable, ["-show_cfg"], child_env)
      lynxrc = ""
      begin
        home = child_env["HOME"]? || Path.home.to_s
        if reader = read_file
          lynxrc = reader.call(File.join(home, ".lynxrc"))
        else
          lynxrc = File.read(File.join(home, ".lynxrc"))
        end
      rescue
        # A user options file is optional.
        lynxrc = ""
      end
      shown_text = (shown && shown.status == 0) ? shown.not_nil!.stdout : ""
      parsed = imported_defaults(parse_browse_map(browse.not_nil!.stdout),
        parse_edit_map(edit.not_nil!.stdout))
      Imported.new(true, parsed.bindings, parsed.unsupported,
        parse_preferences(shown_text, lynxrc))
    end
  end
end
