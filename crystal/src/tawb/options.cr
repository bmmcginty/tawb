require "json"

module Tawb
  module Options
    DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s"
    FRONT_ENDS     = {"default", "lynx", "edb"}

    enum Kind
      Boolean
      String
    end

    alias Value = Bool | String

    BROWSER = {
      "connect"         => Kind::String,
      "profile"         => Kind::String,
      "browser"         => Kind::String,
      "keep-browser"    => Kind::Boolean,
      "log"             => Kind::Boolean,
      "log-dir"         => Kind::String,
      "browser-timeout" => Kind::String,
    }
    EDB    = {"port" => Kind::String}
    HELP   = {"help" => Kind::Boolean}
    READER = {
      "keyboard"                  => Kind::Boolean,
      "dump"                      => Kind::Boolean,
      "front-end"                 => Kind::String,
      "lynx-executable"           => Kind::String,
      "lynx-config"               => Kind::String,
      "lynx-reimport"             => Kind::Boolean,
      "search"                    => Kind::String,
      "link-address"              => Kind::Boolean,
      "short-links"               => Kind::Boolean,
      "escape-unicode"            => Kind::Boolean,
      "alt-screen"                => Kind::Boolean,
      "close-initial-tab-on-exit" => Kind::Boolean,
    }

    def self.front_end_name(value : String?) : String
      name = (value && !value.empty? ? value : "default").downcase
      return name if FRONT_ENDS.includes?(name)
      raise ArgumentError.new("Unknown front end #{value}; use default, lynx or edb")
    end

    def self.normalise_endpoint(value : String) : String
      text = value.strip
      return "http://127.0.0.1:#{text}" if text.matches?(/^\d+$/)
      return text if text.matches?(/^https?:\/\//)
      "http://#{text}"
    end

    def self.browser_timeout_ms(value : String?) : Int64?
      return nil unless value
      seconds = value.to_f64?
      unless seconds && seconds.finite? && seconds > 0
        raise ArgumentError.new("--browser-timeout needs a positive number of seconds, not #{value}")
      end
      (seconds * 1000).round.to_i64
    end

    def self.port_number(value : String?) : Int64
      return 0_i64 unless value
      return 0_i64 if value.empty?
      port = value.to_i64?
      unless port && port >= 0 && port <= 65535 && port.to_s == value
        # JavaScript accepts leading zeroes and a blank value as numeric too.
        number = value.to_f64?
        return number.to_i64 if number && number.finite? && number == number.trunc && number >= 0 && number <= 65535
        raise ArgumentError.new("--port needs a number between 0 and 65535, not #{value}")
      end
      port
    end

    def self.parse_reader(argv : Array(String), env : Hash(String, String)) : Hash(String, JSON::Any)
      values, url = parse_command_line(argv, BROWSER.merge(EDB).merge(HELP).merge(READER))
      shared(values, env).merge({
        "url"                   => json(url),
        "keyboard"              => json(boolean(values, "keyboard", false)),
        "dump"                  => json(boolean(values, "dump", false)),
        "frontEnd"              => json(front_end_name(string(values, "front-end") || env["TAWB_FRONT_END"]?)),
        "lynxExecutable"        => json(string(values, "lynx-executable") || env["TAWB_LYNX"]? || "lynx"),
        "lynxConfig"            => json(string(values, "lynx-config")),
        "lynxReimport"          => json(boolean(values, "lynx-reimport", false)),
        "search"                => json(string(values, "search") || env["TAWB_SEARCH"]? || DEFAULT_SEARCH),
        "linkAddress"           => json(boolean(values, "link-address", true)),
        "shortLinks"            => json(boolean(values, "short-links", false)),
        "escapeUnicode"         => json(boolean(values, "escape-unicode", false)),
        "altScreen"             => json(boolean(values, "alt-screen", true)),
        "closeInitialTabOnExit" => json(boolean(values, "close-initial-tab-on-exit", false)),
        "help"                  => json(boolean(values, "help", false)),
        "port"                  => json(port_number(string(values, "port"))),
      })
    end

    def self.parse_edb(argv : Array(String), env : Hash(String, String)) : Hash(String, JSON::Any)
      values, url = parse_command_line(argv, BROWSER.merge(EDB).merge(HELP))
      shared(values, env).merge({
        "port" => json(port_number(string(values, "port"))),
        "help" => json(boolean(values, "help", false)),
        # The address to open on the way up, which the bridge turns into a
        # tab and prints the address of.
        "url"  => json(url),
      })
    end

    private def self.shared(values : Hash(String, Value), env : Hash(String, String)) : Hash(String, JSON::Any)
      {
        "connect"          => json(string(values, "connect").try { |value| normalise_endpoint(value) }),
        "profile"          => json(string(values, "profile")),
        "engine"           => json(string(values, "browser") || "chromium"),
        "keepBrowser"      => json(boolean(values, "keep-browser", false)),
        "log"              => json(boolean(values, "log", false)),
        "logDir"           => json(string(values, "log-dir") || env["TAWB_LOG_DIR"]?),
        "browserTimeoutMs" => json(browser_timeout_ms(string(values, "browser-timeout"))),
      }
    end

    private def self.parse_command_line(argv : Array(String), spec : Hash(String, Kind)) : Tuple(Hash(String, Value), String?)
      values = {} of String => Value
      positionals = [] of String
      stop = false
      at = 0
      while at < argv.size
        argument = argv[at]
        if stop
          positionals << argument
        elsif argument == "--"
          stop = true
        elsif argument == "-h"
          values["help"] = true
        elsif argument.starts_with?("--")
          spelling = argument[2..]
          name, attached = split_option(spelling)
          negative = name.starts_with?("no-")
          candidate = negative ? name[3..] : name
          kind = spec[candidate]?
          raise ArgumentError.new("Unknown option '--#{name}'") unless kind
          if negative
            raise ArgumentError.new("Unknown option '--#{name}'") unless kind.boolean?
            raise ArgumentError.new("Option '--#{name}' does not take an argument") if attached
            values[candidate] = false
          elsif kind.boolean?
            raise ArgumentError.new("Option '--#{name}' does not take an argument") if attached
            values[name] = true
          else
            if attached
              values[name] = attached
            else
              at += 1
              raise ArgumentError.new("Option '--#{name}' argument missing") if at >= argv.size
              values[name] = argv[at]
            end
          end
        else
          positionals << argument
        end
        at += 1
      end
      {values, positionals[0]?}
    end

    private def self.split_option(spelling : String) : Tuple(String, String?)
      if equals = spelling.index('=')
        {spelling[0, equals], spelling[equals + 1..]}
      else
        {spelling, nil}
      end
    end

    private def self.string(values : Hash(String, Value), name : String) : String?
      values[name]?.as?(String)
    end

    private def self.boolean(values : Hash(String, Value), name : String, default : Bool) : Bool
      found = values[name]?.as?(Bool)
      found.nil? ? default : found
    end

    private def self.json(value : String?) : JSON::Any
      value ? JSON::Any.new(value) : JSON::Any.new(nil)
    end

    private def self.json(value : Int64?) : JSON::Any
      value ? JSON::Any.new(value) : JSON::Any.new(nil)
    end

    private def self.json(value : Bool) : JSON::Any
      JSON::Any.new(value)
    end
  end
end
