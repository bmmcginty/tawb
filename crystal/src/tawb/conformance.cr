require "json"
require "./address"
require "./aria"
require "./blocks"
require "./dump"
require "./layout"
require "./lynx_display"
require "./lynx_number"
require "./options"
require "./transport"
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
      when "aria.render_line"
        JSON::Any.new(Aria.render_line(payload.as_h["item"]))
      when "blocks.build"
        JSON::Any.new(Blocks.build(payload.as_h["items"].as_a))
      when "blocks.fold"
        JSON::Any.new(Blocks.fold(payload.as_h["blocks"].as_a))
      when "dump.resolve_target"
        object = payload.as_h
        existing = object["existing"].as_a.map(&.as_s).to_set
        JSON::Any.new(Dump.resolve_target(
          object["input"]?.try(&.as_s?), object["cwd"].as_s, existing,
          object["search"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        ))
      when "dump.format_ax_blocks"
        object = payload.as_h
        JSON::Any.new(Dump.format_ax_blocks(
          object["blocks"].as_a, object["escape_unicode"]?.try(&.as_bool?) || false
        ))
      when "layout.wrap_with_offsets"
        object = payload.as_h
        JSON::Any.new(Layout.wrap_with_offsets(object["text"].as_s, object["width"].as_i))
      when "layout.spans_within"
        object = payload.as_h
        JSON::Any.new(Layout.spans_within(
          object["spans"].as_a, object["start"].as_i64, object["end"].as_i64
        ))
      when "layout.lines"
        object = payload.as_h
        JSON::Any.new(Layout.lines(object["blocks"].as_a, object["width"].as_i))
      when "lynx_display.render_item"
        object = payload.as_h
        JSON::Any.new(LynxDisplay.render_item(
          object["item"]?, object["fallback"]?.try(&.as_s?) || "",
          object["escape_unicode"]?.try(&.as_bool?) || false
        ))
      when "lynx_display.render_block"
        object = payload.as_h
        LynxDisplay.render_block(object["block"], object["escape_unicode"]?.try(&.as_bool?) || false)
      when "lynx_display.number_blocks"
        object = payload.as_h
        JSON::Any.new(LynxDisplay.number_blocks(object["blocks"].as_a, object["preferences"].as_h))
      when "lynx_display.group_flows"
        JSON::Any.new(LynxDisplay.group_flows(payload.as_h["blocks"].as_a))
      when "lynx_display.row_text"
        object = payload.as_h
        line = object["line"]?
        line = nil if line.try(&.raw.nil?)
        JSON::Any.new(LynxDisplay.row_text(line, object["text"].as_s))
      when "lynx_number.parse"
        parsed = LynxNumber.parse(payload.as_h["text"].as_s)
        parsed ? JSON::Any.new(parsed) : JSON::Any.new(nil)
      when "lynx_number.relative"
        object = payload.as_h
        JSON::Any.new(LynxNumber.relative(
          object["prompt"], object["amount"].as_i64, object["direction"].as_i64
        ))
      when "transport.websocket_round_trip"
        socket = Transport::WebSocket.new(payload.as_h["url"].as_s)
        begin
          socket.send(payload.as_h["text"].as_s)
          JSON::Any.new(socket.receive)
        ensure
          socket.close
        end
      when "options.parse_reader", "options.parse_edb"
        object = payload.as_h
        argv = object["argv"].as_a.map(&.as_s)
        env = object["env"].as_h.transform_values(&.as_s)
        result = operation.ends_with?("reader") ? Options.parse_reader(argv, env) : Options.parse_edb(argv, env)
        JSON::Any.new(result)
      when "options.front_end_name"
        JSON::Any.new(Options.front_end_name(payload.as_h["value"]?.try(&.as_s?)))
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
