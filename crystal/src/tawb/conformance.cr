require "json"
require "./address"
require "./unicode_escape"

module Tawb
  module Conformance
    def self.run(operation : String, input : IO = STDIN, output : IO = STDOUT) : Nil
      payload = JSON.parse(input.gets_to_end)
      value = dispatch(operation, payload)
      output.puts({
        "ok"    => JSON::Any.new(true),
        "value" => value,
      }.to_json)
    rescue error
      output.puts({
        "ok"    => JSON::Any.new(false),
        "error" => JSON::Any.new(error.message || error.class.name),
      }.to_json)
      exit 1
    end

    private def self.dispatch(operation : String, payload : JSON::Any) : JSON::Any
      case operation
      when "address.resolve"
        object = payload.as_h
        typed = object["typed"]?.try(&.as_s?)
        search = object["search"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        JSON::Any.new(Address.resolve(typed, search))
      when "address.search_url"
        object = payload.as_h
        words = object["words"].as_s
        template = object["template"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        JSON::Any.new(Address.search_url(words, template))
      when "unicode.escape"
        JSON::Any.new(UnicodeEscape.escape(payload.as_h["value"]?.try(&.as_s?)))
      when "unicode.escaped_offset"
        object = payload.as_h
        value = object["value"]?.try(&.as_s?)
        offset = object["offset"].as_i.to_i32
        JSON::Any.new(UnicodeEscape.escaped_offset(value, offset).to_i64)
      else
        raise ArgumentError.new("unknown conformance operation #{operation}")
      end
    end
  end
end
