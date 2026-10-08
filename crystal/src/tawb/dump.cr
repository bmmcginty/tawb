require "json"
require "set"
require "./address"
require "./unicode_escape"

module Tawb
  module Dump
    def self.resolve_target(input : String?, cwd : String = Dir.current, existing : Set(String)? = nil,
                            search : String = Address::DEFAULT_SEARCH) : String
      wanted = (input || "").strip
      raise ArgumentError.new("--dump needs a URL or HTML file") if wanted.empty?

      local = File.expand_path(wanted, cwd)
      exists = existing ? existing.includes?(local) : File.exists?(local)
      return file_url(local) if exists

      resolved = Address.resolve(wanted, search)
      if error = resolved["error"]?
        raise ArgumentError.new(error.as_s)
      end
      resolved["url"].as_s
    end

    def self.format_ax_blocks(blocks : Array(JSON::Any), escape_unicode : Bool = false) : String
      return "" if blocks.empty?
      String.build do |io|
        blocks.each do |block|
          text = block.as_h["text"]?.try(&.as_s?) || ""
          io << (escape_unicode ? UnicodeEscape.escape(text) : text) << '\n'
        end
      end
    end

    private def self.file_url(path : String) : String
      String.build do |io|
        io << "file://"
        path.to_slice.each do |byte|
          char = byte.chr
          if char.ascii_alphanumeric? || "/-._~!$&'()*+,;=:@".includes?(char)
            io << char
          else
            io << '%' << byte.to_s(16).upcase.rjust(2, '0')
          end
        end
      end
    end
  end
end
