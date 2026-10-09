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
        @contexts = {} of String => Int64
        command("Page.enable")
        command("Runtime.enable")
      end

      def navigate(url : String) : Nil
        command("Page.navigate", {"url" => JSON::Any.new(url)})
        wait_event("Page.domContentEventFired")
      end

      def accessibility_documents : Tuple(JSON::Any, Hash(String, Array(JSON::Any)))
        tree = command("Page.getFrameTree").as_h["result"].as_h["frameTree"]
        documents = {} of String => Array(JSON::Any)
        frame_ids(tree).each_with_index do |frame_id, index|
          context_id = @contexts[frame_id]?
          # The unnamed default context is always the top document. A child
          # without a context belongs to an out-of-process target; attaching
          # those targets is a separate part of the port.
          next unless context_id || index == 0
          documents[frame_id] = evaluate_items(context_id)
        end
        {tree, documents}
      end

      def accessibility_items : Array(JSON::Any)
        evaluate_items(nil)
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
          note_event(message)
          @events << message if object["method"]?
        end
      end

      private def evaluate_items(context_id : Int64?) : Array(JSON::Any)
        parameters = {
          "expression"    => JSON::Any.new(EXTRACT_AX),
          "returnByValue" => JSON::Any.new(true),
          "awaitPromise"  => JSON::Any.new(true),
        }
        parameters["contextId"] = JSON::Any.new(context_id) if context_id
        response = command("Runtime.evaluate", parameters)
        result = response.as_h["result"].as_h
        if exception = result["exceptionDetails"]?
          raise IO::Error.new("accessibility extraction failed: #{exception.to_json}")
        end
        result["result"].as_h["value"].as_a
      end

      private def frame_ids(tree : JSON::Any) : Array(String)
        ids = [tree.as_h["frame"].as_h["id"].as_s]
        if children = tree.as_h["childFrames"]?
          children.as_a.each { |child| ids.concat(frame_ids(child)) }
        end
        ids
      end

      private def note_event(message : JSON::Any) : Nil
        object = message.as_h
        case object["method"]?.try(&.as_s?)
        when "Runtime.executionContextCreated"
          context = object["params"].as_h["context"].as_h
          auxiliary = context["auxData"]?.try(&.as_h?)
          if auxiliary && auxiliary["isDefault"]?.try(&.as_bool?)
            if frame_id = auxiliary["frameId"]?.try(&.as_s?)
              @contexts[frame_id] = context["id"].as_i64
            end
          end
        when "Runtime.executionContextDestroyed"
          id = object["params"].as_h["executionContextId"].as_i64
          @contexts.reject! { |_frame, context_id| context_id == id }
        when "Runtime.executionContextsCleared"
          @contexts.clear
        end
      end

      private def wait_event(method : String) : JSON::Any
        if index = @events.index { |event| event.as_h["method"]?.try(&.as_s?) == method }
          return @events.delete_at(index)
        end
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          note_event(message)
          return message if object["method"]?.try(&.as_s?) == method
          @events << message if object["method"]?
        end
      end
    end
  end
end
