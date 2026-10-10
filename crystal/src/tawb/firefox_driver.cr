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

    # Passing values into the page. BiDi wants every argument described
    # structurally — `{type: "string", value: ...}` and so on — and a node the
    # realm already knows is passed by its handle alone. Handles come back
    # from decoded results as {handle, sharedId} references and go in as
    # {handle}: the shared id is only for the browser's own pointer actions,
    # never for script arguments.
    def self.to_remote_argument(value : JSON::Any) : JSON::Any
      if reference = handle_reference(value)
        return reference
      end
      raw = value.raw
      case raw
      when Nil
        JSON::Any.new({"type" => JSON::Any.new("null")})
      when Bool
        JSON::Any.new({"type" => JSON::Any.new("boolean"), "value" => value})
      when String
        JSON::Any.new({"type" => JSON::Any.new("string"), "value" => value})
      when Number
        JSON::Any.new({"type" => JSON::Any.new("number"), "value" => value})
      when Array
        JSON::Any.new({
          "type"  => JSON::Any.new("array"),
          "value" => JSON::Any.new(raw.map { |item| to_remote_argument(item) }),
        })
      when Hash
        JSON::Any.new({
          "type"  => JSON::Any.new("object"),
          "value" => JSON::Any.new(raw.map do |key, item|
            JSON::Any.new([JSON::Any.new(key), to_remote_argument(item)])
          end),
        })
      else
        raise ArgumentError.new("cannot pass #{value.class} to the page")
      end
    end

    def self.handle_reference(value : JSON::Any) : JSON::Any?
      object = value.as_h?
      return nil unless object
      handle = object["handle"]?.try(&.as_s?)
      return nil unless handle
      JSON::Any.new({"handle" => JSON::Any.new(handle)})
    end

    # BiDi takes a function declaration; the reader writes bare expressions.
    # A source already shaped like a function goes through untouched.
    def self.as_function_declaration(fn : String, expression = false) : String
      expression ? "() => { return (#{fn}); }" : fn
    end

    # The answer to a script call: the page's exception re-raised, or the
    # remote value decoded back into ordinary JSON.
    def self.raise_page_exception(result : Hash(String, JSON::Any)) : Nil
      return unless result["type"]?.try(&.as_s?) == "exception"
      detail = result["exceptionDetails"]?.try(&.as_h?).try(&.["text"]?.try(&.as_s?))
      raise IO::Error.new(detail || "the page threw while evaluating")
    end

    # One document, and the handful of things a reader asks of it: run a
    # script, hold an element, walk into the frames it embeds. This is the
    # page/frame/handle shape the reader was built on (src/driver.js), kept
    # faithful wire-for-wire so both engines answer identically.
    class Frame
      getter session : Bidi::Session
      getter context_id : String
      getter page : Page?

      def initialize(@session : Bidi::Session, @context_id : String, @page : Page? = nil, url = "about:blank")
        @url = url
      end

      def url : String
        @url
      end

      def set_url(url : String) : Nil
        @url = url
      end

      def evaluate(fn : String, arg : JSON::Any? = nil, expression = false) : JSON::Any
        arguments = arg ? [FirefoxDriver.to_remote_argument(arg)] : [] of JSON::Any
        result = @session.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new(FirefoxDriver.as_function_declaration(fn, expression)),
          "arguments"           => JSON::Any.new(arguments),
          "target"              => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
          "awaitPromise"        => JSON::Any.new(true),
          "resultOwnership"     => JSON::Any.new("none"),
        }).as_h
        FirefoxDriver.raise_page_exception(result)
        Bidi.from_remote(result["result"]?)
      end

      # An element, held across calls: resultOwnership root is what makes the
      # protocol keep it alive for the next round trip.
      def evaluate_handle(fn : String, arg : JSON::Any? = nil, expression = false) : Handle
        arguments = arg ? [FirefoxDriver.to_remote_argument(arg)] : [] of JSON::Any
        result = @session.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new(FirefoxDriver.as_function_declaration(fn, expression)),
          "arguments"           => JSON::Any.new(arguments),
          "target"              => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
          "awaitPromise"        => JSON::Any.new(true),
          "resultOwnership"     => JSON::Any.new("root"),
        }).as_h
        FirefoxDriver.raise_page_exception(result)
        value = result["result"]?.try(&.as_h?)
        Handle.new(@session, @context_id,
          value.try(&.["handle"]?).try(&.as_s?) || "",
          value.try(&.["sharedId"]?).try(&.as_s?))
      end

      # Elements embedded in this one, by selector: BiDi will not hand back a
      # live list, so what comes back is one reference per position — the Nth
      # frame element resolves to the Nth child context.
      def query_all(selector : String) : Array(FrameRef)
        count = evaluate(
          "(sel) => document.querySelectorAll(sel).length", JSON::Any.new(selector)
        ).as_i
        (0...count).map { |index| FrameRef.new(self, index) }
      end

      # The child documents of this one, in the order the browser reports
      # them, which is document order.
      def child_frames : Array(Frame)
        tree = begin
          @session.command("browsingContext.getTree", {
            "root"     => JSON::Any.new(@context_id),
            "maxDepth" => JSON::Any.new(1),
          }).as_h?
        rescue
          nil
        end
        contexts = tree.try(&.["contexts"]?).try(&.as_a?) || [] of JSON::Any
        children = contexts[0]?.try(&.as_h?).try(&.["children"]?).try(&.as_a?) || [] of JSON::Any
        children.map do |child|
          object = child.as_h
          Frame.new(@session, object["context"].as_s, @page,
            object["url"]?.try(&.as_s?) || "about:blank")
        end
      end
    end

    # An element held across calls. The handle is the realm-local name the
    # protocol minted; the shared id names the same node browser-wide and is
    # what pointer actions take. Disowning releases it — best effort, since a
    # context that is already gone has nothing left to disown.
    class Handle
      getter session : Bidi::Session
      getter context_id : String
      getter handle : String
      getter shared_id : String?

      def initialize(@session : Bidi::Session, @context_id : String, @handle : String, @shared_id : String? = nil)
      end

      def evaluate(fn : String, arg : JSON::Any? = nil, expression = false) : JSON::Any
        arguments = [JSON::Any.new({"handle" => JSON::Any.new(@handle)})] of JSON::Any
        arguments.push(FirefoxDriver.to_remote_argument(arg)) if arg
        result = @session.command("script.callFunction", {
          "functionDeclaration" => JSON::Any.new(FirefoxDriver.as_function_declaration(fn, expression)),
          "arguments"           => JSON::Any.new(arguments),
          "target"              => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
          "awaitPromise"        => JSON::Any.new(true),
          "resultOwnership"     => JSON::Any.new("none"),
        }).as_h
        FirefoxDriver.raise_page_exception(result)
        Bidi.from_remote(result["result"]?)
      end

      def content_frame : Nil
        nil # frames are reached by position; see Frame#query_all
      end

      def dispose : Nil
        @session.command("script.disown", {
          "handles" => JSON::Any.new([JSON::Any.new(@handle)]),
          "target"  => JSON::Any.new({"context" => JSON::Any.new(@context_id)}),
        })
      rescue
        nil
      end
    end

    # A frame element named by where it sits, since that is all BiDi offers:
    # it answers content_frame and nothing else, which is all the frame
    # walker asks of it.
    class FrameRef
      def initialize(@parent : Frame, @index : Int32)
      end

      def content_frame : Frame?
        @parent.child_frames[@index]?
      end

      def dispose : Nil
        # Nothing was held: the reference is a number.
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
