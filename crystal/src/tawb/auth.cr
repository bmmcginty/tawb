require "json"
require "uri"

module Tawb
  # The pure half of src/auth.js: reading a user:password pair out of an
  # address. The credentials store that remembers what the reader typed, and
  # the prompt that answers the browser's challenges, are ported with the
  # browser-authentication work; the address bar needs only this split, and
  # needs it now.
  module Auth
    # https://user:password@host is deprecated for subresources in Chrome and
    # interrupted by a confirmation of its own in Firefox, so the pair is
    # taken out of the address and used to answer the challenge instead. It
    # also keeps the password out of the address this session then holds.
    def self.split_credentials(text : String) : Hash(String, JSON::Any)
      raw = text
      url = URI.parse(raw)
      # decodeURIComponent leaves a plus alone; the form decoder would read it
      # as a space, so a literal plus is escaped before decoding.
      decode = ->(part : String) { URI.decode_www_form(part.gsub("+", "%2B")) }
      username = url.user ? decode.call(url.user.not_nil!) : nil
      password = url.password ? decode.call(url.password.not_nil!) : nil
      if (username.nil? || username.empty?) && (password.nil? || password.empty?)
        return {"url" => JSON::Any.new(raw), "username" => JSON::Any.new(nil),
                "password" => JSON::Any.new(nil)}
      end
      url.user = nil
      url.password = nil
      {
        "url"      => JSON::Any.new(url.to_s),
        "username" => JSON::Any.new(username || ""),
        "password" => JSON::Any.new(password || ""),
      }
    rescue
      {"url" => JSON::Any.new(raw), "username" => JSON::Any.new(nil),
       "password" => JSON::Any.new(nil)}
    end
  end
end
