require "json"
require "./bidi"
require "./firefox_agent"

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

      def start_verified(library_port : Int32) : NamedTuple(session: JSON::Any, cleared: JSON::Any, webdriver: Bool)
        started = start
        cleared = FirefoxAgent.ask(library_port, JSON.parse(%({"kind":"clearAutomation"})))
        webdriver = verify_webdriver
        if webdriver
          raise IO::Error.new(
            "Firefox is still announcing itself as automated (navigator.webdriver is true)"
          )
        end
        {session: started, cleared: cleared, webdriver: webdriver}
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

      private def verify_webdriver : Bool
        probe = create_page(background: true)
        started = Time.instant
        deadline = started + 30.seconds
        confirm_deadline = nil
        last_error = nil
        begin
          loop do
            limit = confirm_deadline || deadline
            break if Time.instant >= limit
            begin
              state = probe.automation_state
              if state
                if state["readyState"]?.try(&.as_s?) != "loading"
                  webdriver = state["webdriver"]?.try(&.as_bool?)
                  return false if webdriver == false
                  confirm_deadline ||= Time.instant + 3.seconds if webdriver == true
                end
              end
              last_error = nil
            rescue error
              last_error = error
            end
            remaining = limit - Time.instant
            sleep({200.milliseconds, remaining}.min) if remaining > Time::Span.zero
          end
          return true if confirm_deadline
        ensure
          probe.close rescue nil
        end
        detail = last_error ? " Last answer: #{last_error.message}." : ""
        raise IO::Error.new(
          "Firefox opened its protocol but did not finish initializing a page within 30s.#{detail}"
        )
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

      # Whether a document embedded in the top one is still a placeholder.
      # BiDi lists the browsing contexts below this one with their addresses,
      # and one that has not committed yet is on about:blank, which the frame
      # walk reads as an empty document. Direct children only: a grandchild
      # of a freshly committed child is reached only after the walk has spent
      # its round trips on the parent, and that child's own document reports
      # complete only once every frame below it is done.
      def embedded_documents_pending? : Bool
        result = @protocol.command("browsingContext.getTree", {
          "root" => JSON::Any.new(@context_id),
        }).as_h
        context = result["contexts"].as_a.first?
        return false unless context
        children = context.as_h["children"]?.try(&.as_a?) || [] of JSON::Any
        children.any? do |child|
          url = child.as_h["url"]?.try(&.as_s?) || ""
          url.empty? || url == "about:blank"
        end
      rescue
        false # not answerable is not pending; the walk decides
      end

      # Whether the top document has finished loading: readyState reaches
      # "complete" when the document and everything embedded in it have,
      # which is the load event's own condition.
      def top_document_complete? : Bool
        state = automation_state
        state.try(&.["readyState"]?.try(&.as_s?)) == "complete"
      rescue
        false
      end

      def close : Nil
        @protocol.command("browsingContext.close", {
          "context" => JSON::Any.new(@context_id),
        })
      end

      def automation_state : Hash(String, JSON::Any)?
        result = @protocol.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new(
            "function () { return ({readyState: document.readyState, webdriver: navigator.webdriver}); }"
          ),
          "arguments"       => JSON::Any.new([] of JSON::Any),
          "target"          => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
          "awaitPromise"    => JSON::Any.new(true),
          "resultOwnership" => JSON::Any.new("none"),
        }).as_h
        return nil if result["type"]?.try(&.as_s?) == "exception"
        Bidi.from_remote(result["result"]?).as_h?
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
        # The function is sent the way the JavaScript driver sends it: the bare
        # function source, with the walker's options as the call's argument.
        # Wrapping the source in a return statement answered undefined on real
        # Firefox, and handing the generated call its options inside the
        # source is a second way to lose them.
        declaration = EXTRACT_AX.sub(/\)\(\{layout:false\}\)\s*\z/m, ")")
        layout_argument = JSON::Any.new([
          JSON::Any.new("layout"),
          JSON::Any.new({
            "type"  => JSON::Any.new("boolean"),
            "value" => JSON::Any.new(layout),
          }),
        ])
        arguments = JSON::Any.new([JSON::Any.new({
          "type"  => JSON::Any.new("object"),
          "value" => JSON::Any.new([layout_argument]),
        })])
        result = @protocol.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new(declaration),
          "arguments"           => arguments,
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
