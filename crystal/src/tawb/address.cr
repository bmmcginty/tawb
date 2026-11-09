require "json"
require "uri"

module Tawb
  module Address
    DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s"

    SCHEME      = /^[a-z][a-z0-9+.-]*:\/\//i
    BARE_SCHEME = /^(mailto|data|about|file|tel|view-source|blob):/i
    LOOPBACK    = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i
    DOT_LOCAL   = /\.local(:\d+)?$/i
    IPV4        = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/
    HOST_PORT   = /^[^\s\/?#@:.]+:\d+$/
    DOTTED_HOST = /^[^\s@]+\.[a-z][a-z0-9-]+(:\d+)?$/i

    # JavaScript's encodeURIComponent, rather than form encoding: spaces are
    # %20, and the punctuation in this allowlist is deliberately untouched.
    def self.encode_component(text : String) : String
      String.build do |io|
        text.to_slice.each do |byte|
          char = byte.chr
          if char.ascii_alphanumeric? || "-_.!~*'()".includes?(char)
            io << char
          else
            io << '%' << byte.to_s(16).upcase.rjust(2, '0')
          end
        end
      end
    end

    def self.search_url(words : String, template : String = DEFAULT_SEARCH) : String
      encoded = encode_component(words)
      template.includes?("%s") ? template.sub("%s", encoded) : template + encoded
    end

    # Firefox's Reader View is a page of its own, loaded through an about:
    # URI that names the article to extract. Chromium has no equivalent, so
    # this is only ever asked for when the reader chose Firefox.
    READER_URL = /^about:reader\?/i

    def self.reader_mode_url(url : String) : String
      "about:reader?url=#{encode_component(url)}"
    end

    # The address a Reader View page came from, or nil when the address is
    # not one or the page did not name a source. The source is decoded
    # exactly as Firefox encoded it: the article URL may itself carry a query
    # and fragment.
    def self.reader_source_url(url : String) : String?
      return nil unless READER_URL.matches?(url)
      query = URI.parse(url).query
      return nil unless query
      query.split('&').each do |part|
        key, value = part.split('=', 2)
        next unless key == "url" && value
        source = URI.decode(value)
        return nil if source.empty? || READER_URL.matches?(source)
        return source
      end
      nil
    rescue URI::Error
      nil
    end

    def self.resolve(typed : String?, search : String = DEFAULT_SEARCH) : Hash(String, JSON::Any)
      wanted = (typed || "").strip
      return {"error" => JSON::Any.new("nothing to open")} if wanted.empty?

      if SCHEME.matches?(wanted) || BARE_SCHEME.matches?(wanted)
        return {
          "url"      => JSON::Any.new(wanted),
          "searched" => JSON::Any.new(false),
        }
      end

      host = wanted.split(/[\/?#]/, 2)[0]
      if LOOPBACK.matches?(host) || DOT_LOCAL.matches?(host) || IPV4.matches?(host) || HOST_PORT.matches?(host)
        return {
          "url"      => JSON::Any.new("http://#{wanted}"),
          "searched" => JSON::Any.new(false),
        }
      end
      if DOTTED_HOST.matches?(host)
        return {
          "url"      => JSON::Any.new("https://#{wanted}"),
          "searched" => JSON::Any.new(false),
        }
      end

      {
        "url"      => JSON::Any.new(search_url(wanted, search)),
        "searched" => JSON::Any.new(true),
        "words"    => JSON::Any.new(wanted),
      }
    end
  end
end
