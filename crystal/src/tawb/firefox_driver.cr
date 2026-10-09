require "json"
require "./bidi"

module Tawb
  module FirefoxDriver
    EXTRACT_AX = {{ read_file("#{__DIR__}/../../assets/extract_ax_items.js") }}

    class BrowserSession
      getter protocol : Bidi::Session

      def initialize(url : String)
        @protocol = Bidi::Session.new(url)
        @started = false
      end

      def start : JSON::Any
        result = @protocol.command("session.new", {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        })
        @started = true
        result
      end

      def subscribe(events : Array(String)) : Nil
        @protocol.command("session.subscribe", {
          "events" => JSON::Any.new(events.map { |event| JSON::Any.new(event) }),
        })
      end

      def existing_page : Page
        result = @protocol.command("browsingContext.getTree")
        context = result.as_h["contexts"].as_a.first?
        raise IO::Error.new("Firefox exposed no browsing context") unless context
        object = context.as_h
        Page.new(@protocol, object["context"].as_s, object["url"]?.try(&.as_s?) || "about:blank")
      end

      def create_page(background = false) : Page
        params = {"type" => JSON::Any.new("tab")}
        params["background"] = JSON::Any.new(true) if background
        result = @protocol.command("browsingContext.create", params).as_h
        Page.new(@protocol, result["context"].as_s, "about:blank")
      end

      def close(end_session = true) : Nil
        if @started && end_session
          @protocol.command("session.end") rescue nil
        end
        @protocol.close
        @started = false
      end
    end

    class Page
      getter context_id : String
      getter url : String

      def initialize(@protocol : Bidi::Session, @context_id : String, @url = "about:blank")
      end

      def navigate(url : String, wait = "interactive") : Nil
        result = @protocol.command("browsingContext.navigate", {
          "context" => JSON::Any.new(@context_id),
          "url"     => JSON::Any.new(url),
          "wait"    => JSON::Any.new(wait),
        }).as_h
        @url = result["url"]?.try(&.as_s?) || url
      end

      def close : Nil
        @protocol.command("browsingContext.close", {
          "context" => JSON::Any.new(@context_id),
        })
      end

      def accessibility_documents(layout = false) : Tuple(JSON::Any, Hash(String, Array(JSON::Any)))
        result = @protocol.command("browsingContext.getTree", {
          "root" => JSON::Any.new(@context_id),
        }).as_h
        context = result["contexts"].as_a.first?
        raise IO::Error.new("Firefox exposed no tree for browsing context #{@context_id}") unless context

        documents = {} of String => Array(JSON::Any)
        collect_documents(context, documents, layout)
        {frame_tree(context), documents}
      end

      def accessibility_items(context_id = @context_id, layout = false) : Array(JSON::Any)
        expression = layout ? EXTRACT_AX.sub("{layout:false}", "{layout:true}") : EXTRACT_AX
        result = @protocol.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new("function () { return #{expression}; }"),
          "arguments"           => JSON::Any.new([] of JSON::Any),
          "target"              => JSON::Any.new({"context" => JSON::Any.new(context_id)}),
          "awaitPromise"        => JSON::Any.new(true),
          "resultOwnership"     => JSON::Any.new("none"),
        }).as_h
        if result["type"]?.try(&.as_s?) == "exception"
          detail = result["exceptionDetails"]?.try(&.as_h?)
          message = detail.try(&.["text"]?.try(&.as_s?)) || "the page threw while extracting accessibility"
          raise IO::Error.new(message)
        end
        decoded = Bidi.from_remote(result["result"]?)
        decoded.as_a
      end

      private def collect_documents(context : JSON::Any, documents, layout : Bool) : Nil
        object = context.as_h
        context_id = object["context"].as_s
        documents[context_id] = accessibility_items(context_id, layout)
        children = object["children"]?.try(&.as_a?) || [] of JSON::Any
        children.each { |child| collect_documents(child, documents, layout) }
      end

      private def frame_tree(context : JSON::Any) : JSON::Any
        object = context.as_h
        children = object["children"]?.try(&.as_a?) || [] of JSON::Any
        tree = {
          "frame" => JSON::Any.new({
            "id"  => JSON::Any.new(object["context"].as_s),
            "url" => JSON::Any.new(object["url"]?.try(&.as_s?) || "about:blank"),
          }),
        }
        unless children.empty?
          tree["childFrames"] = JSON::Any.new(children.map { |child| frame_tree(child) })
        end
        JSON::Any.new(tree)
      end
    end
  end
end
