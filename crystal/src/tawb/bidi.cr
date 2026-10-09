require "json"
require "./transport"

module Tawb
  module Bidi
    def self.from_remote(value : JSON::Any?) : JSON::Any
      return JSON::Any.new(nil) unless value
      object = value.as_h?
      return JSON::Any.new(nil) unless object
      type = object["type"]?.try(&.as_s?) || ""
      case type
      when "undefined", "null"
        JSON::Any.new(nil)
      when "string"
        JSON::Any.new(object["value"]?.try(&.as_s?) || "")
      when "boolean"
        JSON::Any.new(object["value"]?.try(&.as_bool?) || false)
      when "number"
        number = object["value"]?
        if number.try(&.as_s?)
          # JSON has no representation for BiDi's non-finite numbers. They do
          # not occur in extracted accessibility items; retain the protocol
          # spelling rather than silently changing it to zero.
          JSON::Any.new(number.not_nil!.as_s)
        else
          number || JSON::Any.new(nil)
        end
      when "bigint"
        JSON::Any.new(object["value"]?.try(&.as_s?) || "0")
      when "array", "set"
        values = object["value"]?.try(&.as_a?) || [] of JSON::Any
        JSON::Any.new(values.map { |item| from_remote(item) })
      when "object", "map"
        output = {} of String => JSON::Any
        entries = object["value"]?.try(&.as_a?) || [] of JSON::Any
        entries.each do |entry|
          pair = entry.as_a
          key_value = pair[0]
          key = key_value.as_s? || from_remote(key_value).raw.to_s
          output[key] = from_remote(pair[1]?)
        end
        JSON::Any.new(output)
      else
        if handle = object["handle"]?.try(&.as_s?)
          reference = {"handle" => JSON::Any.new(handle)}
          if shared = object["sharedId"]?.try(&.as_s?)
            reference["sharedId"] = JSON::Any.new(shared)
          end
          JSON::Any.new(reference)
        else
          JSON::Any.new(nil)
        end
      end
    end

    class Session
      @next_id = 0_i64
      @events = [] of JSON::Any

      def initialize(url : String)
        @socket = Transport::WebSocket.new(url)
      end

      def command(method : String, params = {} of String => JSON::Any) : JSON::Any
        @next_id += 1
        wanted = @next_id
        @socket.send({
          "id"     => JSON::Any.new(wanted),
          "method" => JSON::Any.new(method),
          "params" => JSON::Any.new(params),
        }.to_json)
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          unless object["id"]?
            @events << message
            next
          end
          next unless object["id"].as_i64 == wanted
          if object["type"]?.try(&.as_s?) == "error"
            name = object["error"]?.try(&.as_s?) || "BiDi error"
            detail = object["message"]?.try(&.as_s?) || ""
            raise IO::Error.new(detail.empty? ? name : "#{name}: #{detail}")
          end
          return object["result"]? || JSON::Any.new(nil)
        end
      end

      def next_event(method : String) : JSON::Any
        if index = @events.index { |event| event.as_h["method"]?.try(&.as_s?) == method }
          return @events.delete_at(index).as_h["params"]? || JSON::Any.new(nil)
        end
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          if object["id"]?.nil? && object["method"]?.try(&.as_s?) == method
            return object["params"]? || JSON::Any.new(nil)
          end
          @events << message if object["id"]?.nil?
        end
      end

      def close : Nil
        @socket.close
      end
    end
  end
end
