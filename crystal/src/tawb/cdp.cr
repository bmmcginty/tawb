require "json"
require "./address"
require "./transport"

module Tawb
  module Cdp
    EXTRACT_AX = {{ read_file("#{__DIR__}/../../assets/extract_ax_items.js") }}

    record Target, id : String, web_socket_url : String

    class Page
      getter target : Target

      def initialize(@endpoint : String)
        body = Transport.http(@endpoint, "PUT", "/json/new?about%3Ablank")
        object = JSON.parse(body).as_h
        @target = Target.new(object["id"].as_s, object["webSocketDebuggerUrl"].as_s)
        @socket = Transport::WebSocket.new(@target.web_socket_url)
        @next_id = 0_i64
        @events = [] of JSON::Any
        command("Page.enable")
        command("Runtime.enable")
      end

      def navigate(url : String) : Nil
        command("Page.navigate", {"url" => JSON::Any.new(url)})
        wait_event("Page.domContentEventFired")
      end

      def accessibility_items : Array(JSON::Any)
        response = command("Runtime.evaluate", {
          "expression"    => JSON::Any.new(EXTRACT_AX),
          "returnByValue" => JSON::Any.new(true),
          "awaitPromise"  => JSON::Any.new(true),
        })
        result = response.as_h["result"].as_h
        if exception = result["exceptionDetails"]?
          raise IO::Error.new("accessibility extraction failed: #{exception.to_json}")
        end
        result["result"].as_h["value"].as_a
      end

      def close : Nil
        @socket.close
        Transport.http(@endpoint, "GET", "/json/close/#{@target.id}")
      rescue
        @socket.close rescue nil
      end

      def close_browser : Nil
        command("Browser.close")
      rescue
      ensure
        @socket.close rescue nil
      end

      private def command(method : String, params = {} of String => JSON::Any) : JSON::Any
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
          if object["id"]?.try(&.as_i64?) == wanted
            if error = object["error"]?
              raise IO::Error.new("CDP #{method} failed: #{error.to_json}")
            end
            return message
          end
          @events << message if object["method"]?
        end
      end

      private def wait_event(method : String) : JSON::Any
        if index = @events.index { |event| event.as_h["method"]?.try(&.as_s?) == method }
          return @events.delete_at(index)
        end
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          return message if object["method"]?.try(&.as_s?) == method
          @events << message if object["method"]?
        end
      end
    end
  end
end
