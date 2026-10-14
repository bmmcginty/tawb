require "json"
require "./bidi"
require "./firefox_agent"
require "./marionette"

module Tawb
  module FirefoxDriver
    # The navigation events a reader follows (src/driver_firefox.js
    # NAVIGATION_EVENTS), and how long an action is given to start a
    # navigation before concluding it was not going to.
    NAVIGATION_EVENTS = [
      "browsingContext.load",
      "browsingContext.domContentLoaded",
      "browsingContext.fragmentNavigated",
      "browsingContext.navigationStarted",
    ]
    NAVIGATION_GRACE_MS = 150
    EXTRACT_AX = {{ read_file("#{__DIR__}/../../assets/extract_ax_items.js") }}
    # Where a slider's track begins and ends inside its own box, measured in
    # the page (src/driver_firefox.js sliderGeometry). The engine's own, not
    # the policy's: Chromium measures the same thing its own way.
    SLIDER_GEOMETRY = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/slider_geometry.js") }})

    class BrowserSession
      getter protocol : Bidi::Session

      def initialize(url : String)
        @protocol = Bidi::Session.new(url)
        @started = false
        @pages = {} of String => Page
      end

      def start(stranded_session_port : Int32? = nil) : JSON::Any
        params = {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        }
        result = begin
          @protocol.command("session.new", params)
        rescue error
          stranded = stranded_session_port &&
                     /Maximum number of active sessions/i.matches?(error.message || "")
          raise error unless stranded
          # A broker with a cached session answers session.new itself. Reaching
          # Firefox and receiving this refusal therefore means this broker is
          # new and the session belongs to the broker that disappeared before
          # ending it. Closing one Marionette connection releases that orphan,
          # after which this broker can create the replacement it will hold.
          raise error unless Marionette.release_stranded_session(stranded_session_port.not_nil!)
          @protocol.command("session.new", params)
        end
        @started = true
        result
      end

      def start_verified(library_port : Int32?, stranded_session_port : Int32? = nil) : NamedTuple(session: JSON::Any, cleared: JSON::Any, webdriver: Bool)
        started = start(stranded_session_port)
        # A browser launched by us has a parent-process agent and is cleared
        # again now that the BiDi session exists. A directly connected browser
        # may not expose that agent, but it must still pass the same page-side
        # verification before anything is driven.
        cleared = library_port ?
          FirefoxAgent.ask(library_port, JSON.parse(%({"kind":"clearAutomation"}))) :
          JSON::Any.new(nil)
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

      # Take Firefox's invisible HTTP-authentication prompt over and answer it
      # with credentials supplied by the reader. The session dispatcher keeps
      # this event loop independent from page commands on the same socket.
      def attach_auth(handler : Proc(JSON::Any, String, Page?, JSON::Any?)) : Nil
        @protocol.command("session.subscribe", {
          "events" => JSON::Any.new([JSON::Any.new("network.authRequired")]),
        }) rescue nil
        @protocol.command("network.addIntercept", {
          "phases" => JSON::Any.new([JSON::Any.new("authRequired")]),
        })
        spawn do
          loop do
            params = @protocol.next_event("network.authRequired").as_h
            request = params["request"]?.try(&.as_h?) || {} of String => JSON::Any
            response = params["response"]?.try(&.as_h?) || {} of String => JSON::Any
            challenge = response["authChallenges"]?.try(&.as_a?).try(&.first?).try(&.as_h?) ||
                        {} of String => JSON::Any
            request_id = request["request"]?.try(&.as_s?) || next
            raw = JSON::Any.new({
              "source" => JSON::Any.new(response["status"]?.try(&.as_i64?) == 407 ? "proxy" : "server"),
              "realm"  => JSON::Any.new(challenge["realm"]?.try(&.as_s?) || ""),
              "scheme" => JSON::Any.new(challenge["scheme"]?.try(&.as_s?) || ""),
              "url"    => JSON::Any.new(request["url"]?.try(&.as_s?) || ""),
            })
            context = params["context"]?.try(&.as_s?)
            page = context ? @pages[context]? : nil
            given = handler.call(raw, request_id, page) rescue nil
            fields = given.try(&.as_h?)
            command = if fields
                        {
                          "request" => JSON::Any.new(request_id),
                          "action" => JSON::Any.new("provideCredentials"),
                          "credentials" => JSON::Any.new({
                            "type" => JSON::Any.new("password"),
                            "username" => JSON::Any.new(fields["username"]?.try(&.as_s?) || ""),
                            "password" => JSON::Any.new(fields["password"]?.try(&.as_s?) || ""),
                          }),
                        }
                      else
                        {"request" => JSON::Any.new(request_id),
                         "action" => JSON::Any.new("cancel")}
                      end
            @protocol.command("network.continueWithAuth", command) rescue nil
          end
        rescue
          # Session shutdown, or a browser that removed the intercept.
        end
      end

      # Every top-level browsing context is a tab. Keep one Page object per
      # context so the core can compare its current page by identity while a
      # fresh getTree answer updates the address behind that object.
      def list_pages : Array(Page)
        result = @protocol.command("browsingContext.getTree")
        (result.as_h["contexts"]?.try(&.as_a?) || [] of JSON::Any).map do |context|
          object = context.as_h
          page_for(object["context"].as_s,
            object["url"]?.try(&.as_s?) || "about:blank")
        end
      end

      def existing_page : Page
        list_pages.first? || raise IO::Error.new("Firefox exposed no browsing context")
      end

      def create_page(background = false) : Page
        params = {"type" => JSON::Any.new("tab")}
        params["background"] = JSON::Any.new(true) if background
        result = @protocol.command("browsingContext.create", params).as_h
        page_for(result["context"].as_s, "about:blank")
      end

      # A BiDi browsing-context id is stable for the life of a tab and means
      # the same thing in every reader process, which is exactly what claims
      # need from a tab name.
      def target_id_for(page : Page) : String
        page.context_id
      end

      private def page_for(context_id : String, url : String) : Page
        if page = @pages[context_id]?
          page.set_url(url)
          return page
        end
        page = Page.new(@protocol, context_id, url)
        @pages[context_id] = page
        page
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
    # The WebDriver action envelopes a trusted pointer gesture travels in.
    # They live here rather than with the policy above them because they are
    # BiDi's own shapes, and a second engine has nothing to do with them.
    def self.pointer_params(context_id : String, id : String,
                            actions : Array(JSON::Any)) : Hash(String, JSON::Any)
      {
        "context" => JSON::Any.new(context_id),
        "actions" => JSON::Any.new([JSON::Any.new({
          "type"       => JSON::Any.new("pointer"),
          "id"         => JSON::Any.new(id),
          "parameters" => JSON::Any.new({"pointerType" => JSON::Any.new("mouse")}),
          "actions"    => JSON::Any.new(actions),
        })]),
      }
    end

    # The same gesture with keys held down across it. The key source's pauses
    # match the pointer source's actions tick for tick, which is what keeps
    # the modifier down for the whole of the click rather than only at the
    # moment it was pressed.
    def self.modified_pointer_params(context_id : String, modifiers : Array(String),
                                     actions : Array(JSON::Any)) : Hash(String, JSON::Any)
      key_actions = [] of JSON::Any
      modifiers.each do |value|
        key_actions << JSON::Any.new({"type" => JSON::Any.new("keyDown"),
                                      "value" => JSON::Any.new(value)})
      end
      actions.size.times { key_actions << JSON::Any.new({"type" => JSON::Any.new("pause")}) }
      modifiers.reverse.each do |value|
        key_actions << JSON::Any.new({"type" => JSON::Any.new("keyUp"),
                                      "value" => JSON::Any.new(value)})
      end
      pointer_actions = [JSON::Any.new({"type" => JSON::Any.new("pause")})] +
                        actions +
                        [JSON::Any.new({"type" => JSON::Any.new("pause")})]
      {
        "context" => JSON::Any.new(context_id),
        "actions" => JSON::Any.new([
          JSON::Any.new({
            "type"    => JSON::Any.new("key"),
            "id"      => JSON::Any.new("tweb-modifier-key"),
            "actions" => JSON::Any.new(key_actions),
          }),
          JSON::Any.new({
            "type"       => JSON::Any.new("pointer"),
            "id"         => JSON::Any.new("tweb-modifier-mouse"),
            "parameters" => JSON::Any.new({"pointerType" => JSON::Any.new("mouse")}),
            "actions"    => JSON::Any.new(pointer_actions),
          }),
        ]),
      }
    end

    # WebDriver pointer coordinates are whole numbers of CSS pixels.
    def self.whole(value : Float64) : JSON::Any
      JSON::Any.new(Core.js_round(value).to_i64)
    end

    def self.pointer_move(x : JSON::Any, y : JSON::Any, origin : JSON::Any) : JSON::Any
      JSON::Any.new({
        "type"   => JSON::Any.new("pointerMove"),
        "x"      => x,
        "y"      => y,
        "origin" => origin,
      })
    end

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

      # Nothing to lend. Firefox's closed shadow roots are reached from inside
      # the page, by the privileged parent script that installs
      # `window[Symbol.for('tweb.pierce')]` — so a page function that wants
      # them asks for them itself through its own `pierce` option, and there
      # is no second, privileged way to run it. See
      # `Marionette::PIERCE_PARENT_SCRIPT`.
      def pierce_and_run(expression : String) : JSON::Any?
        nil
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
      def document_id : String
        @context_id
      end

      # A real click at a point inside this document's own viewport, for a
      # document whose contents could not be read even after piercing.
      def click_in_frame(x : Float64, y : Float64) : Nil
        begin
          @session.command("input.performActions",
            FirefoxDriver.pointer_params(@context_id, "tweb-mouse", [
              FirefoxDriver.pointer_move(JSON::Any.new(Core.js_round(x).to_i64),
                JSON::Any.new(Core.js_round(y).to_i64), JSON::Any.new("viewport")),
              JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
              JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
            ]))
        ensure
          @session.command("input.releaseActions",
            {"context" => JSON::Any.new(@context_id)}) rescue nil
        end
      end

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

      # Files given straight to this file input, which is what a reader who
      # typed a path means. The element is named by reference, so a control
      # with no name and no form around it is still answerable.
      def set_files(paths : Array(String)) : Bool
        shared = @shared_id || raise IO::Error.new(
          "that control cannot be given files: the browser gave no reference to it")
        @session.command("input.setFiles", {
          "context" => JSON::Any.new(@context_id),
          "element" => JSON::Any.new({"sharedId" => JSON::Any.new(shared)}),
          "files"   => JSON::Any.new(paths.map { |path| JSON::Any.new(path) }),
        })
        true
      end

      # The keyboard of the document this element belongs to: a key reaches
      # the element that has focus in that document, not in the tab's top
      # one.
      def keyboard : Keyboard
        Keyboard.new(@session, @context_id)
      end

      # ----------------------------------------------------------------
      # Trusted input on this element
      #
      # The engine's own half of the real click, the hover, the download
      # gesture and the slider press. What is worth doing at all and what
      # the answer means is Actions' to decide; which protocol commands say
      # it is the driver's, which is the seam src/driver.js draws.
      # ----------------------------------------------------------------

      # A pointer press and release at this element's own centre, with
      # whatever modifiers are being held. The element is named by reference
      # so the browser computes the point itself and hits what was meant.
      def click(modifiers : Array(String) = [] of String) : Nil
        reference = element_origin
        pointer = [
          FirefoxDriver.pointer_move(JSON::Any.new(0), JSON::Any.new(0), reference),
          JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
          JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
        ]
        begin
          if modifiers.empty?
            @session.command("input.performActions",
              FirefoxDriver.pointer_params(@context_id, "tweb-mouse", pointer))
          else
            # Keyboard and pointer sources advance together in BiDi ticks, so
            # a modifier is down before the pointer moves and stays down until
            # after the release has produced the click.
            @session.command("input.performActions",
              FirefoxDriver.modified_pointer_params(@context_id, modifiers, pointer))
          end
        ensure
          # A pointer left pressed belongs to nobody once this returns, and
          # the next action would inherit it.
          @session.command("input.releaseActions",
            {"context" => JSON::Any.new(@context_id)}) rescue nil
        end
      end

      # The pointer brought onto the element from just outside it and left
      # there. No releaseActions afterwards: there is no button held down to
      # release, and releasing the sequence is what would undo the pointer's
      # position.
      def hover_at(from_x : Float64, from_y : Float64,
                   x : Float64, y : Float64) : Nil
        viewport = JSON::Any.new("viewport")
        @session.command("input.performActions",
          FirefoxDriver.pointer_params(@context_id, "tweb-mouse", [
            FirefoxDriver.pointer_move(FirefoxDriver.whole(from_x),
              FirefoxDriver.whole(from_y), viewport),
            FirefoxDriver.pointer_move(FirefoxDriver.whole(x),
              FirefoxDriver.whole(y), viewport),
          ]))
      end

      # Firefox's native Alt-click save gesture (src/driver_firefox.js
      # downloadLink): the browser's own download manager takes the target
      # without the current tab navigating.
      def download_link : Nil
        click(["\u{E00A}"])
      end

      # The track of a slider, and a trusted press at the point a requested
      # position maps onto. Used when a custom ARIA slider advertises a range
      # and then ignores every standard key: the caller maps the value onto
      # the range, this maps it onto the pixels the page actually has.
      def click_slider(ratio : Float64, orientation : JSON::Any?) : Nil
        reference = element_origin
        begin
          # The first move reveals hover-only tracks. Element-origin offsets
          # are from its centre in WebDriver actions, so the second move
          # needs only the dimensions after that disclosure has happened.
          @session.command("input.performActions",
            FirefoxDriver.pointer_params(@context_id, "tweb-slider",
              [FirefoxDriver.pointer_move(JSON::Any.new(0), JSON::Any.new(0), reference)]))
          sleep(120.milliseconds)
          geometry = evaluate(SLIDER_GEOMETRY, orientation || JSON::Any.new(nil)).as_h
          vertical = geometry["vertical"]?.try(&.as_bool?) || false
          start = Core.js_number(geometry["start"]?)
          finish = Core.js_number(geometry["end"]?)
          width = Core.js_number(geometry["width"]?)
          height = Core.js_number(geometry["height"]?)
          along = start + (vertical ? 1 - ratio : ratio) * (finish - start)
          x = vertical ? JSON::Any.new(0) : JSON::Any.new(Core.js_round(along - width / 2).to_i64)
          y = vertical ? JSON::Any.new(Core.js_round(along - height / 2).to_i64) : JSON::Any.new(0)
          @session.command("input.performActions",
            FirefoxDriver.pointer_params(@context_id, "tweb-slider", [
              FirefoxDriver.pointer_move(x, y, reference),
              JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
              JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
            ]))
        ensure
          @session.command("input.releaseActions",
            {"context" => JSON::Any.new(@context_id)}) rescue nil
        end
      end

      private def element_origin : JSON::Any
        shared = @shared_id ||
                 raise IO::Error.new("this line carries no element reference to act on")
        JSON::Any.new({
          "type"    => JSON::Any.new("element"),
          "element" => JSON::Any.new({"sharedId" => JSON::Any.new(shared)}),
        })
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

    # A file dialog Firefox handed to WebDriver instead of drawing. It must
    # always be answered: an empty list is cancellation, while leaving the
    # event unanswered wedges later uploads in that tab.
    class FileChooser
      getter multiple : Bool
      getter directory : Bool

      def initialize(@protocol : Bidi::Session, @context_id : String,
                     @element : JSON::Any, @multiple = false)
        @directory = false
      end

      def set_files(paths : Array(String)) : Bool
        @protocol.command("input.setFiles", {
          "context" => JSON::Any.new(@context_id),
          "element" => @element,
          "files"   => JSON::Any.new(paths.map { |path| JSON::Any.new(path) }),
        })
        true
      end

      def cancel : Bool
        set_files([] of String)
      end
    end

    class Page
      getter protocol : Bidi::Session
      getter context_id : String
      getter url : String
      property loading : Bool

      def initialize(@protocol : Bidi::Session, @context_id : String, @url = "about:blank")
        @closed = false
        @loading = false
      end

      def set_url(url : String) : Nil
        @url = url
      end

      def closed? : Bool
        @closed
      end

      def title : String
        evaluate("() => document.title").as_s? || ""
      rescue
        ""
      end

      def foreground? : Bool
        evaluate("() => document.visibilityState === 'visible'").as_bool? || false
      rescue
        false
      end

      # BiDi commands carry their own bound; these preserve the page contract
      # the core applies when it adopts a tab.
      def set_default_timeout(milliseconds : Int32) : Nil
      end

      def set_default_navigation_timeout(milliseconds : Int32) : Nil
      end

      def evaluate(fn : String, arg : JSON::Any? = nil, expression = false) : JSON::Any
        Frame.new(@protocol, @context_id, self, @url).evaluate(fn, arg, expression)
      end

      # Nothing to lend. Firefox's closed shadow roots are reached from inside
      # the page, by the privileged parent script that installs
      # `window[Symbol.for('tweb.pierce')]` — so a page function that wants
      # them asks for them itself through its own `pierce` option, and there
      # is no second, privileged way to run it. See
      # `Marionette::PIERCE_PARENT_SCRIPT`.
      def pierce_and_run(expression : String) : JSON::Any?
        nil
      end

      def evaluate_handle(fn : String, arg : JSON::Any? = nil, expression = false) : Handle
        Frame.new(@protocol, @context_id, self, @url).evaluate_handle(fn, arg, expression)
      end

      def navigate(url : String, wait = "interactive") : Nil
        result = @protocol.command("browsingContext.navigate", {
          "context" => JSON::Any.new(@context_id),
          "url"     => JSON::Any.new(url),
          "wait"    => JSON::Any.new(wait),
        }).as_h
        @url = result["url"]?.try(&.as_s?) || url
      end

      # Visit an address the way the reader does (src/driver_firefox.js
      # goto): the protocol waits for the document itself, so nothing is
      # outstanding whether the navigation succeeded or threw.
      def goto(url : String, wait_until = "complete") : Nil
        begin
          navigate(url, wait_until == "domcontentloaded" ? "interactive" : "complete")
        ensure
          @loading = false
        end
      end

      # Ask the browser for this document again, cache or no.
      def reload(wait_until = "complete", ignore_cache = false) : Nil
        begin
          result = @protocol.command("browsingContext.reload", {
            "context"     => JSON::Any.new(@context_id),
            "wait"        => JSON::Any.new(wait_until == "domcontentloaded" ? "interactive" : "complete"),
            "ignoreCache" => JSON::Any.new(ignore_cache),
          }).as_h
          @url = result["url"]?.try(&.as_s?) || @url
        ensure
          @loading = false
        end
      end

      # Give up on a document that is taking its time.
      def stop_loading : Nil
        begin
          @protocol.command("browsingContext.stopLoading", {
            "context" => JSON::Any.new(@context_id),
          })
        ensure
          @loading = false
        end
      end

      # Events the browser pushed while we were between commands, routed to
      # this page the way the JavaScript driver's session handlers route
      # them: every navigation event carries the address, a start marks the
      # document as loading, a completion unmarks it, and a fragment move is
      # an address change with no new document. Answers whether the document
      # finished loading, since that is the thing a caller waits for.
      def drain_navigation : Bool
        saw_load = false
        while found = @protocol.poll_any(NAVIGATION_EVENTS)
          method, params = found
          case method
          when "browsingContext.navigationStarted"
            @loading = true
          when "browsingContext.load", "browsingContext.domContentLoaded"
            @loading = false
            saw_load = true
          end
          url = params.as_h?.try(&.["url"]?.try(&.as_s?))
          set_url(url) if url
        end
        saw_load
      end

      # Waits for a navigation an action may have started (the Firefox
      # driver's waitForLoadState). Returning at once when nothing is loading
      # was a real bug: the click has not necessarily started the navigation
      # yet, and the snapshot that followed then described the page being
      # left, with its URL recorded as the one on screen, so nothing ever
      # caught up. So a navigation gets a short window to begin, and only
      # then is its completion awaited. A click that navigates nowhere costs
      # that window and no more.
      def wait_for_load_state(state = "load", timeout_ms = 15000) : Bool
        started_by = Time.monotonic + NAVIGATION_GRACE_MS.milliseconds
        saw_load = drain_navigation
        while !saw_load && !@loading && Time.monotonic < started_by
          sleep 20.milliseconds
          saw_load = drain_navigation
        end
        return saw_load unless @loading
        deadline = Time.monotonic + timeout_ms.milliseconds
        while @loading && Time.monotonic < deadline
          saw_load = drain_navigation || saw_load
          sleep 20.milliseconds unless saw_load
        end
        saw_load
      end

      # Step through this tab's own history (src/index.js
      # traversePageHistory). The address the driver cached lags the document
      # history actually lands on, so both the navigation entry and
      # location.href are read from the page itself, and readiness is asked
      # of the document rather than awaited from the protocol — a document
      # that reports itself and then stalls must not hold the reader for the
      # full navigation timeout.
      def traverse_history(direction : Int32, watch_ms = 1500, load_ms = 15000) : Bool
        entry_of = "() => (globalThis.navigation?.currentEntry ? " \
                   "globalThis.navigation.currentEntry.key : null)"
        before_entry = begin
          evaluate(entry_of).as_s?
        rescue
          nil
        end
        before_url = @url
        evaluate("(delta) => window.history.go(delta)", JSON::Any.new(direction.to_i64))
        deadline = Time.monotonic + watch_ms.milliseconds
        while Time.monotonic < deadline
          sleep 50.milliseconds
          drain_navigation
          entry = begin
            evaluate(entry_of).as_s?
          rescue
            before_entry
          end
          next unless @url != before_url || (entry && entry != before_entry)
          load_deadline = Time.monotonic + load_ms.milliseconds
          while Time.monotonic < load_deadline
            ready = begin
              evaluate("() => document.readyState").as_s?
            rescue
              ""
            end
            break if ready == "interactive" || ready == "complete"
            sleep 50.milliseconds
          end
          address = begin
            evaluate("() => location.href").as_s?
          rescue
            nil
          end
          set_url(address) if address
          return true
        end
        false
      end

      # This tab's own top document, which is a document like any other.
      def main_frame : Frame
        Frame.new(@protocol, @context_id, self, @url)
      end

      # Every document below this tab, including the top one. Live updates use
      # this to drain only the contexts they have armed, without walking page
      # elements or touching unrelated tabs.
      def all_frames : Array(Frame)
        result = @protocol.command("browsingContext.getTree", {
          "root" => JSON::Any.new(@context_id),
        }).as_h
        root = result["contexts"].as_a.first?
        return [Frame.new(@protocol, @context_id, self, @url)] unless root
        frames = [] of Frame
        append_frames(root, frames)
        frames
      end

      private def append_frames(context : JSON::Any, frames : Array(Frame)) : Nil
        object = context.as_h
        frames << Frame.new(@protocol, object["context"].as_s, self,
          object["url"]?.try(&.as_s?) || "about:blank")
        (object["children"]?.try(&.as_a?) || [] of JSON::Any).each do |child|
          append_frames(child, frames)
        end
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
        @closed = true
      end

      # Give a file input its files directly, for the ordinary case where the
      # reader has already resolved the control to an element.
      def set_files(handle : Handle, paths : Array(String)) : Bool
        shared = handle.shared_id
        unless shared
          raise IO::Error.new(
            "that control cannot be given files: the browser gave no reference to it")
        end
        @protocol.command("input.setFiles", {
          "context" => JSON::Any.new(handle.context_id),
          "element" => JSON::Any.new({"sharedId" => JSON::Any.new(shared)}),
          "files"   => JSON::Any.new(paths.map { |path| JSON::Any.new(path) }),
        })
        true
      end

      # Subscribe only for this tab. Taking a chooser from another reader's
      # tab would suppress the browser's dialog and leave them unable to
      # answer it.
      def arm_file_chooser : Bool
        @protocol.command("session.subscribe", {
          "events"   => JSON::Any.new([JSON::Any.new("input.fileDialogOpened")]),
          "contexts" => JSON::Any.new([JSON::Any.new(@context_id)]),
        })
        true
      rescue
        false
      end

      # Wait for the chooser Firefox raises after a trusted press. The event
      # names the input itself, so answering does not need a page-side handle.
      def next_file_chooser : FileChooser
        loop do
          event = @protocol.next_event("input.fileDialogOpened").as_h
          next unless event["context"]?.try(&.as_s?) == @context_id
          element = event["element"]? || raise IO::Error.new("file chooser named no input")
          return FileChooser.new(@protocol, @context_id, element,
            event["multiple"]?.try(&.as_bool?) || false)
        end
      end

      # Typing and key presses through the browser's own input pipeline.
      # This document's name, as the browser knows it. The top document of a
      # tab is a document like any other, and anything that keeps track of
      # documents — the live-update arming, an item that came from a frame —
      # keeps track of them by this.
      def document_id : String
        @context_id
      end

      # One document of this tab, by the browser's own name for it.
      def frame_for(context_id : String) : Frame
        Frame.new(@protocol, context_id, self)
      end

      # This tab's name, as the browser knows it and as every reader process
      # knows it: what a claim on a tab is made of.
      def tab_id : String
        @context_id
      end

      # The password prompt a 401 raises is intercepted for the whole session
      # when the reader attaches to it, so a tab needs nothing of its own —
      # which is the answer, not a refusal.
      def arm_auth : Bool
        true
      end

      # The connection this tab is reached over. A preload script is
      # installed per connection rather than per tab, so whatever keeps track
      # of having installed one keeps track by this. BiDi has one session for
      # the whole browser; CDP has one per tab.
      def connection_id : String
        @protocol.object_id.to_s
      end

      # Run this in every document of this connection, from now on, before
      # the document's own scripts. Used to arm the mutation observer at
      # document-start, which is the only way to see a parse as it happens.
      def add_preload_script(source : String) : Nil
        @protocol.command("script.addPreloadScript", {
          "functionDeclaration" => JSON::Any.new(source),
        })
      end

      def keyboard : Keyboard
        Keyboard.new(@protocol, @context_id)
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

      # The documents of this tab and how they nest, in the shape the frame
      # assembler reads: {"frame" => {"id", "url"}, "childFrames" => [...]}.
      # The accessibility extraction answers this alongside its items; the
      # views that walk the page themselves ask for it on its own.
      def frame_tree : JSON::Any
        result = @protocol.command("browsingContext.getTree", {
          "root" => JSON::Any.new(@context_id),
        }).as_h
        context = result["contexts"].as_a.first? ||
                  raise IO::Error.new("Firefox exposed no tree for browsing context #{@context_id}")
        frame_tree(context)
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
