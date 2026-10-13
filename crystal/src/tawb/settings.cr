module Tawb
  # Options a reader wrote down once, in a file, so they do not have to be
  # typed again.
  #
  # The file holds command-line arguments, and the entry points prepend what
  # is in it to what was typed — so anything on the command line wins, which
  # is what a reader expects of a configuration file.
  module Settings
    def self.path(env : Hash(String, String) = ENV.to_h,
                  home : String = Path.home.to_s) : String
      base = env["XDG_CONFIG_HOME"]? || File.join(home, ".config")
      File.join(base, "tawb", "settings")
    end

    # Read options with the same quoting and escaping people use at a shell,
    # but without executing a shell or expanding variables. A comment begins
    # with # where a new argument could begin; # inside an argument remains
    # literal.
    def self.split(text : String) : Array(String)
      arguments = [] of String
      word = String::Builder.new
      started = false
      quote = nil.as(Char?)
      escaped = false
      comment = false

      finish = -> do
        if started
          arguments << word.to_s
          word = String::Builder.new
          started = false
        end
      end

      text.each_char do |character|
        if comment
          comment = false if character == '\n'
          next
        end
        if escaped
          word << character
          started = true
          escaped = false
          next
        end
        if character == '\\' && quote != '\''
          escaped = true
          started = true
          next
        end
        if held = quote
          if character == held
            quote = nil
          else
            word << character
          end
          started = true
          next
        end
        if character == '"' || character == '\''
          quote = character
          started = true
          next
        end
        if character == '#' && !started
          comment = true
          next
        end
        if character.whitespace?
          finish.call
          next
        end
        word << character
        started = true
      end

      raise ArgumentError.new("unfinished escape") if escaped
      raise ArgumentError.new("unterminated #{quote} quote") if quote
      finish.call
      arguments
    end

    # What the file says, or nothing when there is no file. A file that
    # cannot be parsed is an error rather than an empty answer: a reader who
    # wrote a setting down is owed the news that it is not being used.
    def self.read(env : Hash(String, String) = ENV.to_h,
                  home : String = Path.home.to_s,
                  file : String? = nil) : Array(String)
      target = file || path(env, home)
      text = begin
        File.read(target)
      rescue File::NotFoundError
        return [] of String
      end
      begin
        split(text)
      rescue error
        raise ArgumentError.new("Cannot read settings from #{target}: #{error.message}")
      end
    end
  end
end
