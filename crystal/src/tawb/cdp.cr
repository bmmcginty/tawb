require "json"
require "./address"
require "./core"
require "./transport"

module Tawb
  module Cdp
    EXTRACT_AX            = {{ read_file("#{__DIR__}/../../assets/extract_ax_items.js") }}
    EXTRACT_AX_WITH_PAIRS = EXTRACT_AX
      .sub(/^\/\/[^\n]*\n/, "")
      .sub(/\(\{layout:false\}\)\s*$/, "({layout:false,pairs:this})")

    # How long a document is given to announce the context it runs in.
    CONTEXT_WAIT = 2.seconds
    # The lifecycle names CDP uses for the states a caller asks about.
    LIFECYCLE = {
      "load"             => "load",
      "domcontentloaded" => "DOMContentLoaded",
      "networkidle"      => "networkIdle",
    }

    record Target, id : String, web_socket_url : String
    record ShadowPair, host_id : Int64, root_id : Int64, kind : String
    # Where an element sits in the top-level viewport, and how big it is.
    record Box, x : Float64, y : Float64, width : Float64, height : Float64
    record Point, x : Float64, y : Float64

    # CDP takes a function declaration where Playwright took a function or a
    # string (src/cdp_page.js asFunctionDeclaration). An expression is what
    # `evaluate("1 + 1")` means, and the caller says which it is handing over
    # rather than being guessed about — the same contract
    # FirefoxDriver.as_function_declaration keeps, since a function body can
    # contain an arrow and an expression can too.
    def self.function_declaration(fn : String, expression = false) : String
      expression ? "() => { return (#{fn}); }" : fn
    end

    # The page's own name for a value being handed to it. Everything passed
    # from here is JSON — an index, a flag, a selector — so there is nothing
    # cleverer to do.
    def self.call_argument(value : JSON::Any) : JSON::Any
      raw = value.raw
      if raw.is_a?(Float64) && !raw.finite?
        return JSON::Any.new({"unserializableValue" => JSON::Any.new(raw.to_s)})
      end
      JSON::Any.new({"value" => value})
    end

    # What the page threw, said in one line. The description is the useful
    # half of CDP's exceptionDetails; the text is what is left when a thrown
    # value has no description of its own.
    def self.raise_on_exception(result : Hash(String, JSON::Any), what : String) : Nil
      details = result["exceptionDetails"]?.try(&.as_h?) || return
      exception = details["exception"]?.try(&.as_h?)
      text = exception.try(&.["description"]?.try(&.as_s?)) ||
             exception.try(&.["value"]?.try(&.to_s)) ||
             details["text"]?.try(&.as_s?) ||
             "the page threw while #{what}"
      raise IO::Error.new(text.lines.first? || text)
    end

    # The browser, as a tab inventory (src/cdp_browser.js
    # CdpBrowserContext).
    #
    # Chromium's HTTP endpoint is what lists and creates targets, and each
    # tab gets a protocol connection of its own. The JavaScript original
    # multiplexes one connection because it listens across every target at
    # once; a reader here acts on one tab at a time, and the tab it acts on
    # is the tab it is connected to.
    class BrowserSession
      getter endpoint : String

      def initialize(@endpoint : String)
        @pages = {} of String => Page
      end

      # The tabs the browser has open, in the order it lists them.
      #
      # Only tabs: a listing also carries extension background pages, the
      # browser's own interface windows and service workers, and none of
      # those is something a reader can read. And only tabs that will accept
      # a connection — a target listed while it is still being created, or
      # one that goes between the listing and the connection, is not in the
      # list rather than being the reason there is no list. That is what the
      # JavaScript original's own listing means by a wired page.
      def list_pages : Array(Page)
        listed = JSON.parse(Transport.http(@endpoint, "GET", "/json/list")).as_a
        tabs = listed.compact_map do |entry|
          object = entry.as_h
          next nil unless object["type"]?.try(&.as_s?) == "page"
          socket = object["webSocketDebuggerUrl"]?.try(&.as_s?)
          next nil unless socket
          {id: object["id"].as_s, socket: socket,
           url: object["url"]?.try(&.as_s?) || "about:blank"}
        end
        open_ids = tabs.map { |tab| tab[:id] }.to_set

        # A tab that has gone takes its connection with it.
        @pages.each do |target_id, page|
          page.detach unless open_ids.includes?(target_id)
        end
        @pages.select! { |target_id, _page| open_ids.includes?(target_id) }

        # First-seen order, so that stepping between tabs does not depend on
        # which one the browser was last looking at: Chromium lists the most
        # recently used first, and a list that reorders itself under the
        # reader is not a list they can step through.
        by_id = tabs.to_h { |tab| {tab[:id], tab} }
        ordered = @pages.keys.compact_map { |target_id| by_id[target_id]? }
        ordered += tabs.reject { |tab| @pages.has_key?(tab[:id]) }
        ordered.compact_map do |tab|
          begin
            page_for(tab[:id], tab[:socket], tab[:url])
          rescue
            nil
          end
        end
      end

      def existing_page : Page
        list_pages.first? || raise IO::Error.new("Chromium exposed no tab to read")
      end

      def create_page : Page
        page = Page.new(@endpoint)
        @pages[page.target.id] = page
        page
      end

      # A CDP target id is stable for the life of a tab and means the same
      # thing in every reader process, which is exactly what a claim on a tab
      # needs from a tab's name.
      def target_id_for(page : Page) : String
        page.target.id
      end

      def close_page(page : Page) : Nil
        @pages.delete(page.target.id)
        page.close
      end

      # Let go of every tab this session connected to. The browser itself is
      # somebody else's to stop: it was launched before this session and a
      # kept one outlives it.
      def close : Nil
        @pages.each_value { |page| page.detach }
        @pages.clear
      end

      # One connection per tab, kept, so that a tab listed twice is the same
      # page object both times — which is what the reader's own tab list and
      # its claims are compared by.
      private def page_for(target_id : String, socket : String, url : String) : Page
        if page = @pages[target_id]?
          page.set_url(url)
          return page
        end
        page = Page.new(@endpoint, Target.new(target_id, socket),
          Transport::WebSocket.new(socket))
        page.set_url(url)
        @pages[target_id] = page
        page
      end
    end

    # A value living in the page, held by reference (src/cdp_page.js
    # CdpHandle). The handle is the called function's first argument, as
    # Playwright has it rather than as CDP has it, so the page-side assets
    # written `(el, arg) => ...` run unchanged under either engine.
    class Handle
      getter object_id : String
      getter session_id : String?

      def initialize(@page : Page, @object_id : String, @session_id : String? = nil)
        @disposed = false
      end

      def evaluate(fn : String, arg : JSON::Any? = nil, expression = false) : JSON::Any
        result = call(fn, arg, expression, by_value: true)
        result["result"]?.try(&.as_h?).try(&.["value"]?) || JSON::Any.new(nil)
      end

      def evaluate_handle(fn : String, arg : JSON::Any? = nil, expression = false) : Handle
        result = call(fn, arg, expression, by_value: false)
        object = result["result"].as_h["objectId"]?.try(&.as_s?) ||
                 raise IO::Error.new("the page answered no reference")
        Handle.new(@page, object, @session_id)
      end

      # Where the element is on screen, in the top-level viewport's
      # coordinates, having first been brought there. Nil when it has no box
      # to click. The quad arithmetic lives beside the centre point because
      # the slider fallback needs the whole track, and an out-of-process
      # frame's own coordinates have to be offset for both uses.
      def click_box : Box?
        @page.command("DOM.scrollIntoViewIfNeeded",
          {"objectId" => JSON::Any.new(@object_id)}, @session_id) rescue nil
        got = begin
          @page.command("DOM.getContentQuads",
            {"objectId" => JSON::Any.new(@object_id)}, @session_id)
        rescue
          nil
        end
        quads = got.try(&.as_h["result"].as_h["quads"]?.try(&.as_a?)) || [] of JSON::Any
        offset = @page.session_offset(@session_id) || return nil
        quads.each do |quad|
          numbers = quad.as_a.map { |value| Core.js_number(value) }
          next if numbers.size < 8
          # A quad is eight numbers: four corners, clockwise from the top left.
          xs = [numbers[0], numbers[2], numbers[4], numbers[6]]
          ys = [numbers[1], numbers[3], numbers[5], numbers[7]]
          width = xs.max - xs.min
          height = ys.max - ys.min
          next if width < 1 || height < 1
          return Box.new(xs.min + offset.x, ys.min + offset.y, width, height)
        end
        nil
      end

      def click_point : Point?
        box = click_box || return nil
        Point.new(box.x + box.width / 2, box.y + box.height / 2)
      end

      # A click the browser accounts a person's: real input dispatched above
      # content, so the events are trusted and carry user activation.
      def click(modifiers = 0) : Nil
        at = click_point || raise IO::Error.new("that element has no box on screen to click")
        @page.click_at(at.x, at.y, modifiers)
      end

      # The pointer put on the element and left there, pressing nothing.
      def hover : Nil
        at = click_point || raise IO::Error.new("that element has no box on screen to hover")
        @page.move_to(at.x, at.y)
      end

      def dispose : Nil
        return if @disposed
        @disposed = true
        @page.command("Runtime.releaseObject",
          {"objectId" => JSON::Any.new(@object_id)}, @session_id)
      rescue
        # the page went away and took the reference with it
      end

      def same?(other : Handle) : Bool
        @object_id == other.object_id
      end

      private def call(fn : String, arg : JSON::Any?, expression : Bool,
                       by_value : Bool) : Hash(String, JSON::Any)
        arguments = arg ? [Cdp.call_argument(arg)] : [] of JSON::Any
        parameters = {
          "objectId" => JSON::Any.new(@object_id),
          # `this` is the element; the declaration passes it on as the first
          # argument so the page-side source keeps Playwright's shape.
          "functionDeclaration" => JSON::Any.new(
            "function (...rest) { return (#{Cdp.function_declaration(fn, expression)})(this, ...rest); }"),
          "arguments"    => JSON::Any.new(arguments),
          "awaitPromise" => JSON::Any.new(true),
        } of String => JSON::Any
        parameters["returnByValue"] = JSON::Any.new(true) if by_value
        result = @page.command("Runtime.callFunctionOn", parameters, @session_id)
          .as_h["result"].as_h
        Cdp.raise_on_exception(result, "evaluating against an element")
        result
      end
    end

    # Typing, through the browser's own input pipeline (src/cdp_page.js
    # CdpKeyboard). This is the piece that cannot be faked from inside the
    # page: a script-dispatched KeyboardEvent is untrusted and inserts no
    # text, which is why the protocol is load-bearing rather than a
    # convenience.
    class Keyboard
      # Keys as CDP wants them: a virtual key code, a physical code, and the
      # text the key inserts. Only the keys this program presses are here,
      # and an unknown one says so rather than being sent as something else.
      record Definition, key : String, code : String, key_code : Int32,
        text : String? = nil

      KEYS = {
        "Enter"      => Definition.new("Enter", "Enter", 13, "\r"),
        "Tab"        => Definition.new("Tab", "Tab", 9, "\t"),
        "Escape"     => Definition.new("Escape", "Escape", 27),
        "Backspace"  => Definition.new("Backspace", "Backspace", 8),
        "Delete"     => Definition.new("Delete", "Delete", 46),
        "Home"       => Definition.new("Home", "Home", 36),
        "End"        => Definition.new("End", "End", 35),
        "PageUp"     => Definition.new("PageUp", "PageUp", 33),
        "PageDown"   => Definition.new("PageDown", "PageDown", 34),
        "ArrowLeft"  => Definition.new("ArrowLeft", "ArrowLeft", 37),
        "ArrowUp"    => Definition.new("ArrowUp", "ArrowUp", 38),
        "ArrowRight" => Definition.new("ArrowRight", "ArrowRight", 39),
        "ArrowDown"  => Definition.new("ArrowDown", "ArrowDown", 40),
      }

      record Modifier, bit : Int32, key : String, code : String, key_code : Int32

      MODIFIERS = {
        "Alt"     => Modifier.new(1, "Alt", "AltLeft", 18),
        "Control" => Modifier.new(2, "Control", "ControlLeft", 17),
        "Meta"    => Modifier.new(4, "Meta", "MetaLeft", 91),
        "Shift"   => Modifier.new(8, "Shift", "ShiftLeft", 16),
      }

      # The physical key and Windows virtual-key code for every printable
      # ASCII character. CDP asks for both even though `text` is what the key
      # inserts. ASCII character codes are not virtual-key codes: 39 is
      # ArrowRight rather than Quote and 46 is Delete rather than Period, so
      # using the character's own code made an apostrophe move the caret and
      # a full stop delete instead of inserting.
      #
      # This is the conventional US-keyboard mapping used by browser
      # automation. Shifted and unshifted characters share a physical key;
      # `key` and `text` still carry the character the terminal produced.
      # Beyond ASCII there is no honest physical-key answer, so the code is
      # empty and the key code is zero.
      SHIFTED_PAIRS = [
        {"`~", "Backquote", 192},
        {"1!", "Digit1", 49}, {"2@", "Digit2", 50}, {"3#", "Digit3", 51},
        {"4$", "Digit4", 52}, {"5%", "Digit5", 53}, {"6^", "Digit6", 54},
        {"7&", "Digit7", 55}, {"8*", "Digit8", 56}, {"9(", "Digit9", 57},
        {"0)", "Digit0", 48}, {"-_", "Minus", 189}, {"=+", "Equal", 187},
        {"[{", "BracketLeft", 219}, {"]}", "BracketRight", 221},
        {"\\|", "Backslash", 220}, {";:", "Semicolon", 186}, {"'\"", "Quote", 222},
        {",<", "Comma", 188}, {".>", "Period", 190}, {"/?", "Slash", 191},
        {" ", "Space", 32},
      ]

      CHARACTER_KEYS = begin
        table = {} of Char => Tuple(String, Int32)
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ".each_char do |letter|
          entry = {"Key#{letter}", letter.ord}
          table[letter] = entry
          table[letter.downcase] = entry
        end
        SHIFTED_PAIRS.each do |characters, code, key_code|
          characters.each_char { |character| table[character] = {code, key_code} }
        end
        table
      end

      def self.key_for_character(character : Char) : Tuple(String, Int32)
        CHARACTER_KEYS[character]? || {"", 0}
      end

      def initialize(@page : Page)
      end

      def type(text : String) : Nil
        # Each character is one keystroke, whatever it costs in code units.
        text.each_char do |character|
          code, key_code = Keyboard.key_for_character(character)
          as_text = character.to_s
          # text on the keyDown is what makes the browser insert the
          # character and raise keypress and input alongside it.
          send({
            "key"                   => JSON::Any.new(as_text),
            "code"                  => JSON::Any.new(code),
            "windowsVirtualKeyCode" => JSON::Any.new(key_code.to_i64),
            "type"                  => JSON::Any.new("keyDown"),
            "text"                  => JSON::Any.new(as_text),
            "unmodifiedText"        => JSON::Any.new(as_text),
          })
          send({
            "key"                   => JSON::Any.new(as_text),
            "code"                  => JSON::Any.new(code),
            "windowsVirtualKeyCode" => JSON::Any.new(key_code.to_i64),
            "type"                  => JSON::Any.new("keyUp"),
          })
        end
      end

      def press(key : String) : Nil
        parts = key.split('+')
        target = parts.pop
        held = parts.map do |name|
          MODIFIERS[name]? || raise IO::Error.new(
            %(the Chromium driver has no modifier named "#{name}"))
        end

        definition = KEYS[target]? || MODIFIERS[target]?.try do |modifier|
          Definition.new(modifier.key, modifier.code, modifier.key_code)
        end
        if definition.nil? && target.size == 1
          code, key_code = Keyboard.key_for_character(target[0])
          definition = Definition.new(target, code, key_code, target)
        end
        found = definition || raise IO::Error.new(
          %(the Chromium driver has no key named "#{key}"))

        modifiers = 0
        held.each do |modifier|
          modifiers |= modifier.bit
          send({
            "type"                  => JSON::Any.new("keyDown"),
            "key"                   => JSON::Any.new(modifier.key),
            "code"                  => JSON::Any.new(modifier.code),
            "windowsVirtualKeyCode" => JSON::Any.new(modifier.key_code.to_i64),
            "modifiers"             => JSON::Any.new(modifiers.to_i64),
          })
        end

        # A modified key inserts nothing — Control+Backspace is a command,
        # not a character — which is what the browser expects to see too.
        text = (modifiers & ~MODIFIERS["Shift"].bit) != 0 ? nil : found.text
        base = {
          "key"                   => JSON::Any.new(found.key),
          "code"                  => JSON::Any.new(found.code),
          "windowsVirtualKeyCode" => JSON::Any.new(found.key_code.to_i64),
          "modifiers"             => JSON::Any.new(modifiers.to_i64),
        } of String => JSON::Any
        down = base.dup
        if inserted = text
          down["type"] = JSON::Any.new("keyDown")
          down["text"] = JSON::Any.new(inserted)
          down["unmodifiedText"] = JSON::Any.new(inserted)
        else
          down["type"] = JSON::Any.new("rawKeyDown")
        end
        send(down)
        up = base.dup
        up["type"] = JSON::Any.new("keyUp")
        send(up)

        held.reverse.each do |modifier|
          modifiers &= ~modifier.bit
          send({
            "type"                  => JSON::Any.new("keyUp"),
            "key"                   => JSON::Any.new(modifier.key),
            "code"                  => JSON::Any.new(modifier.code),
            "windowsVirtualKeyCode" => JSON::Any.new(modifier.key_code.to_i64),
            "modifiers"             => JSON::Any.new(modifiers.to_i64),
          })
        end
      end

      private def send(parameters : Hash(String, JSON::Any)) : Nil
        @page.command("Input.dispatchKeyEvent", parameters)
      end
    end

    class Page
      getter target : Target

      @socket : Transport::Channel
      @next_id = 0_i64
      @events = [] of JSON::Any
      # Which execution context answers for each document, and on which
      # session: a context id is a counter within one session rather than a
      # name that means anything on its own.
      @contexts = {} of String => Tuple(Int64, String?)
      @iframe_targets = Set(String).new
      @frame_sessions = {} of String => String
      @main_frame_id : String? = nil
      @url = "about:blank"
      @closed = false
      @loading = false
      # Which lifecycle names the current document has reached. A new
      # document starts the count again; see note_event.
      @reached = Set(String).new

      def initialize(@endpoint : String)
        body = Transport.http(@endpoint, "PUT", "/json/new?about%3Ablank")
        object = JSON.parse(body).as_h
        @target = Target.new(object["id"].as_s, object["webSocketDebuggerUrl"].as_s)
        @socket = Transport::WebSocket.new(@target.web_socket_url)
        enable_domains
      end

      # A tab on a channel somebody else opened. The conformance harness
      # hands in a recorded one; nothing else needs this.
      def initialize(@endpoint : String, @target : Target,
                     @socket : Transport::Channel)
        enable_domains
      end

      private def enable_domains : Nil
        command("Page.enable")
        command("Runtime.enable")
        # What the document reaches, rather than only that it finished: the
        # reader waits for DOMContentLoaded on a click that may navigate and
        # for load on an address it typed.
        command("Page.setLifecycleEventsEnabled", {"enabled" => JSON::Any.new(true)})
        command("Target.setDiscoverTargets", {
          "discover" => JSON::Any.new(true),
          "filter"   => JSON.parse(%([{"type":"iframe"}])),
        })
        # Asked now rather than when something first needs it: every
        # lifecycle and navigation event is read for whether it belongs to
        # this tab's own document, and an event that arrives before the
        # answer is known would be read as somebody else's.
        main_frame_id
      end

      # ------------------------------------------------------------------
      # Where this tab is, and whether it is still arriving
      # ------------------------------------------------------------------

      def url : String
        @url
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

      # What the current document has already reached. Lifecycle events
      # report only what happens from now on, and a tab is very often
      # finished loading long before a reader arrives at it; without this,
      # a wait for a `load` that happened yesterday would run to its whole
      # timeout — and that wait is on the same path as every click. A
      # document that cannot be asked counts as arrived, because waiting for
      # something there is no way to observe is worse than not waiting.
      def seed_load_state : Nil
        ready = begin
          evaluate("() => document.readyState").as_s?
        rescue
          nil
        end
        return if ready == "loading"
        @reached << "DOMContentLoaded"
        @reached << "load" unless ready == "interactive"
      end

      # Visit an address. The lifecycle the caller asked for is what is
      # waited for; a fragment link commits no document and so has no
      # lifecycle to wait for, which the absent loader says.
      def goto(url : String, wait_until = "load", timeout_ms = 30000) : Nil
        wanted = LIFECYCLE[wait_until]? || "load"
        parameters = {"url" => JSON::Any.new(url)} of String => JSON::Any
        parameters["frameId"] = JSON::Any.new(main_frame_id)
        result = command("Page.navigate", parameters).as_h["result"].as_h
        if error = result["errorText"]?.try(&.as_s?)
          # An aborted navigation is what a download and a redirect to a
          # handler both look like; the page the reader is on is unharmed.
          raise IO::Error.new("#{url} could not be loaded: #{error}") unless
            error.empty? || error == "net::ERR_ABORTED"
        end
        # The address is not taken from the request: a redirect means the
        # document that commits is not the one that was asked for, and
        # Page.frameNavigated is what says which one did. See note_event.
        return if result["loaderId"]?.try(&.as_s?).nil?
        @reached.clear
        await_lifecycle(wanted, timeout_ms)
      ensure
        @loading = false
      end

      # The dump path's navigation: the document's own DOM, which is the
      # readiness an extraction needs.
      def navigate(url : String) : Nil
        goto(url, "domcontentloaded")
      end

      def reload(ignore_cache = false, wait_until = "load", timeout_ms = 30000) : Nil
        wanted = LIFECYCLE[wait_until]? || "load"
        @reached.clear
        command("Page.reload", {"ignoreCache" => JSON::Any.new(ignore_cache)})
        await_lifecycle(wanted, timeout_ms)
      ensure
        @loading = false
      end

      def stop_loading : Nil
        command("Page.stopLoading")
      ensure
        @loading = false
      end

      # Playwright's semantics, deliberately: a document that has already
      # reached the state is not waited for. Callers race this against the
      # action that might navigate, so making it wait for a navigation that
      # never starts would put that wait on the price of every click.
      def wait_for_load_state(state = "load", timeout_ms = 15000) : Bool
        wanted = LIFECYCLE[state]? || "load"
        return true if @reached.includes?(wanted)
        await_lifecycle(wanted, timeout_ms)
      end

      # Step through this tab's own history. The entries are the browser's
      # own list, so a step is a move to a named entry rather than a count.
      def traverse_history(direction : Int32, wait_until = "load",
                           timeout_ms = 30000) : Bool
        history = command("Page.getNavigationHistory").as_h["result"].as_h
        entries = history["entries"].as_a
        at = (history["currentIndex"]?.try(&.as_i64?) || 0).to_i32
        target = entries[at + direction]?
        return false if target.nil? || at + direction < 0
        wanted = LIFECYCLE[wait_until]? || "load"
        @reached.clear
        command("Page.navigateToHistoryEntry",
          {"entryId" => target.as_h["id"]})
        await_lifecycle(wanted, timeout_ms)
        true
      end

      # Read events until this tab's own document reaches `name`. Only the
      # tab's own: a frame reaching DOMContentLoaded says nothing about
      # whether the page has.
      private def await_lifecycle(name : String, timeout_ms : Int32) : Bool
        return true if @reached.includes?(name)
        deadline = Time.instant + timeout_ms.milliseconds
        while Time.instant < deadline
          begin
            wait_event("Page.lifecycleEvent")
          rescue
            return @reached.includes?(name)
          end
          return true if @reached.includes?(name)
        end
        false
      end

      # Whether a document embedded in the top one is still a placeholder. A
      # child frame commits after the parent has parsed the <iframe>, and
      # until it does its url is about:blank, which the frame walk reads as
      # an empty document. Direct children only: a grandchild of a freshly
      # committed child is reached only after the walk has spent its round
      # trips on the parent, and that child's own document reports complete
      # only once every frame below it is done.
      def embedded_documents_pending? : Bool
        tree = command("Page.getFrameTree").as_h["result"].as_h["frameTree"]
        children = tree.as_h["childFrames"]?.try(&.as_a?) || [] of JSON::Any
        children.any? { |child| placeholder?(child.dig?("frame", "url")) }
      rescue
        false # not answerable is not pending; the walk decides
      end

      # Whether the top document has finished loading: readyState reaches
      # "complete" when the document and everything embedded in it have,
      # which is the load event's own condition.
      def top_document_complete? : Bool
        response = command("Runtime.evaluate", {
          "expression"    => JSON::Any.new("document.readyState"),
          "returnByValue" => JSON::Any.new(true),
        })
        response.as_h["result"].as_h["result"].as_h["value"].as_s? == "complete"
      rescue
        false
      end

      private def placeholder?(url : JSON::Any?) : Bool
        given = url.try(&.as_s?) || ""
        given.empty? || given == "about:blank"
      end

      def accessibility_documents(layout = false) : Tuple(JSON::Any, Hash(String, Array(JSON::Any)))
        # Discovery events can still be in flight when the top document's DOM
        # event arrives. The listing is a synchronous census and closes that
        # race without recursively auto-attaching to renderer workers.
        targets = command("Target.getTargets").as_h["result"].as_h["targetInfos"].as_a
        targets.each do |target|
          info = target.as_h
          @iframe_targets << info["targetId"].as_s if info["type"]?.try(&.as_s?) == "iframe"
        end
        tree = command("Page.getFrameTree").as_h["result"].as_h["frameTree"]
        known_frames = frame_ids(tree).to_set
        # A tab session may omit an OOPIF from Page.getFrameTree. Its target
        # still has a frame tree of its own; add that root to the parent list
        # so the renderer can place it after the corresponding iframe marker.
        children = tree.as_h["childFrames"]?.try(&.as_a?)
        unless children
          children = [] of JSON::Any
          tree.as_h["childFrames"] = JSON::Any.new(children)
        end
        @iframe_targets.each do |target_id|
          next if known_frames.includes?(target_id)
          session_id = attach_frame(target_id)
          child_tree = command("Page.getFrameTree", session_id: session_id).as_h["result"].as_h["frameTree"]
          children << child_tree
        end

        documents = {} of String => Array(JSON::Any)
        frame_ids(tree).each_with_index do |frame_id, index|
          context = @contexts[frame_id]?
          if context
            documents[frame_id] = evaluate_items(context[0], context[1], layout)
          elsif index == 0
            documents[frame_id] = evaluate_items(nil, nil, layout)
          elsif @iframe_targets.includes?(frame_id)
            session_id = attach_frame(frame_id)
            documents[frame_id] = evaluate_items(nil, session_id, layout)
          end
        end
        {tree, documents}
      end

      def accessibility_items : Array(JSON::Any)
        evaluate_items(nil)
      end

      def close : Nil
        @closed = true
        @socket.close
        Transport.http(@endpoint, "GET", "/json/close/#{@target.id}")
      rescue
        @socket.close rescue nil
      end

      # Let go of the connection without closing the tab: the tab belongs to
      # the browser, and a reader leaving is not a reason to take it away.
      def detach : Nil
        @socket.close
      rescue
      end

      def close_browser : Nil
        command("Browser.close")
      rescue
      ensure
        @socket.close rescue nil
      end

      # The main document's id, as the browser names it. Everything a reader
      # evaluates runs in a document, and the top one is where it starts.
      def main_frame_id : String
        known = @main_frame_id
        return known if known
        tree = command("Page.getFrameTree").as_h["result"].as_h["frameTree"]
        found = tree.as_h["frame"].as_h["id"].as_s
        @main_frame_id = found
        found
      end

      # The execution context a document announced, waited for rather than
      # asked for: CDP announces contexts as they are created, so one that
      # has not arrived yet is worth a moment's patience.
      def context_for(frame_id : String) : Tuple(Int64, String?)
        deadline = Time.instant + CONTEXT_WAIT
        loop do
          if known = @contexts[frame_id]?
            return known
          end
          raise IO::Error.new("that document never announced a context to run in") if Time.instant >= deadline
          sleep 10.milliseconds
          # Nothing is read from the socket while idle, so a context announced
          # between commands arrives only when something asks. One cheap
          # command is what makes the announcement land.
          command("Runtime.getIsolateId") rescue nil
        end
      end

      def evaluate(fn : String, arg : JSON::Any? = nil, expression = false) : JSON::Any
        result = call_function(fn, arg, expression, by_value: true)
        result["result"]?.try(&.as_h?).try(&.["value"]?) || JSON::Any.new(nil)
      end

      def evaluate_handle(fn : String, arg : JSON::Any? = nil, expression = false) : Handle
        result = call_function(fn, arg, expression, by_value: false)
        object = result["result"].as_h["objectId"]?.try(&.as_s?) ||
                 raise IO::Error.new("the page answered no reference")
        Handle.new(self, object)
      end

      def keyboard : Keyboard
        Keyboard.new(self)
      end

      # A real click at a point in the top-level viewport. Moved to, then
      # pressed, then released, with the button state each event should
      # carry: a bare press and release with no movement before it is not
      # what a mouse produces, and the places this matters are precisely
      # where something is watching how the click was made.
      def click_at(x : Float64, y : Float64, modifiers = 0,
                   session_id : String? = nil) : Nil
        at = {
          "x"         => JSON::Any.new(Core.js_round(x).to_i64),
          "y"         => JSON::Any.new(Core.js_round(y).to_i64),
          "modifiers" => JSON::Any.new(modifiers.to_i64),
        } of String => JSON::Any
        moved = at.dup
        moved["type"] = JSON::Any.new("mouseMoved")
        moved["buttons"] = JSON::Any.new(0_i64)
        command("Input.dispatchMouseEvent", moved, session_id)
        pressed = at.dup
        pressed["type"] = JSON::Any.new("mousePressed")
        pressed["button"] = JSON::Any.new("left")
        pressed["buttons"] = JSON::Any.new(1_i64)
        pressed["clickCount"] = JSON::Any.new(1_i64)
        command("Input.dispatchMouseEvent", pressed, session_id)
        released = at.dup
        released["type"] = JSON::Any.new("mouseReleased")
        released["button"] = JSON::Any.new("left")
        released["buttons"] = JSON::Any.new(0_i64)
        released["clickCount"] = JSON::Any.new(1_i64)
        command("Input.dispatchMouseEvent", released, session_id)
      end

      # The pointer moved to a point and left there. One event, because that
      # is what a pointer arriving somewhere is: the page's mouseover,
      # mouseenter and pointerover all come from this one, and the pointer
      # stays where it was put until something else moves it — which is what
      # keeps a menu open long enough to read.
      def move_to(x : Float64, y : Float64, session_id : String? = nil) : Nil
        command("Input.dispatchMouseEvent", {
          "type"    => JSON::Any.new("mouseMoved"),
          "x"       => JSON::Any.new(Core.js_round(x).to_i64),
          "y"       => JSON::Any.new(Core.js_round(y).to_i64),
          "buttons" => JSON::Any.new(0_i64),
        }, session_id)
      end

      # DOM coordinates from an out-of-process frame are local to that
      # target, while input is dispatched in the top-level viewport's
      # coordinates. The iframe element lives in the parent's process, so the
      # parent is asked where it put it.
      #
      # The tab's own session needs no offset. A frame with a process of its
      # own is offset by the box its parent gave it; a frame nested inside
      # another out-of-process frame needs each containing offset in turn,
      # which needs the parent chain the frame tree carries. Until that is
      # ported, a nested case answers nil rather than a wrong point, and the
      # caller refuses rather than clicking somewhere else.
      def session_offset(session_id : String?) : Point?
        return Point.new(0.0, 0.0) if session_id.nil?
        frame_id = @frame_sessions.each.find { |_id, session| session == session_id }
          .try(&.[0]) || return nil
        owner = command("DOM.getFrameOwner",
          {"frameId" => JSON::Any.new(frame_id)}).as_h["result"].as_h
        model = command("DOM.getBoxModel",
          {"backendNodeId" => owner["backendNodeId"]})
          .as_h["result"].as_h["model"].as_h
        quad = (model["border"]? || model["content"]?).try(&.as_a?) || return nil
        return nil if quad.size < 8
        numbers = quad.map { |value| Core.js_number(value) }
        Point.new(
          [numbers[0], numbers[2], numbers[4], numbers[6]].min,
          [numbers[1], numbers[3], numbers[5], numbers[7]].min)
      rescue
        nil
      end

      private def call_function(fn : String, arg : JSON::Any?, expression : Bool,
                                by_value : Bool) : Hash(String, JSON::Any)
        context = context_for(main_frame_id)
        arguments = arg ? [Cdp.call_argument(arg)] : [] of JSON::Any
        parameters = {
          "functionDeclaration" => JSON::Any.new(Cdp.function_declaration(fn, expression)),
          "arguments"           => JSON::Any.new(arguments),
          "awaitPromise"        => JSON::Any.new(true),
          "executionContextId"  => JSON::Any.new(context[0]),
        } of String => JSON::Any
        parameters["returnByValue"] = JSON::Any.new(true) if by_value
        result = command("Runtime.callFunctionOn", parameters, context[1])
          .as_h["result"].as_h
        Cdp.raise_on_exception(result, "evaluating")
        result
      end

      # The handles and the keyboard speak to the page through this, the way
      # FirefoxDriver's do through its protocol session.
      def command(method : String, params = {} of String => JSON::Any, session_id : String? = nil) : JSON::Any
        @next_id += 1
        wanted = @next_id
        request = {
          "id"     => JSON::Any.new(wanted),
          "method" => JSON::Any.new(method),
          "params" => JSON::Any.new(params),
        }
        request["sessionId"] = JSON::Any.new(session_id) if session_id
        @socket.send(request.to_json)
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

      private def attach_frame(frame_id : String) : String
        session = @frame_sessions[frame_id]?
        return session if session
        response = command("Target.attachToTarget", {
          "targetId" => JSON::Any.new(frame_id),
          "flatten"  => JSON::Any.new(true),
        })
        session = response.as_h["result"].as_h["sessionId"].as_s
        @frame_sessions[frame_id] = session
        command("Page.enable", session_id: session)
        command("Runtime.enable", session_id: session)
        session
      end

      private def evaluate_items(context_id : Int64?, session_id : String? = nil, layout = false) : Array(JSON::Any)
        expression = layout ? EXTRACT_AX.sub("{layout:false}", "{layout:true}") : EXTRACT_AX
        parameters = {
          "expression"    => JSON::Any.new(expression),
          "returnByValue" => JSON::Any.new(true),
          "awaitPromise"  => JSON::Any.new(true),
        }
        parameters["contextId"] = JSON::Any.new(context_id) if context_id
        response = command("Runtime.evaluate", parameters, session_id)
        result = response.as_h["result"].as_h
        if exception = result["exceptionDetails"]?
          raise IO::Error.new("accessibility extraction failed: #{exception.to_json}")
        end
        items = result["result"].as_h["value"].as_a
        needs_privileged = items.empty? || has_media_controls?(context_id, session_id)
        return items unless needs_privileged
        privileged_items(context_id, session_id, layout) || items
      end

      private def has_media_controls?(context_id : Int64?, session_id : String?) : Bool
        parameters = {
          "expression"    => JSON::Any.new("!!document.querySelector('video[controls],audio[controls]')"),
          "returnByValue" => JSON::Any.new(true),
        }
        parameters["contextId"] = JSON::Any.new(context_id) if context_id
        response = command("Runtime.evaluate", parameters, session_id)
        response.as_h["result"].as_h["result"].as_h["value"].as_bool
      rescue
        false
      end

      private def privileged_items(context_id : Int64?, session_id : String?, layout : Bool) : Array(JSON::Any)?
        document = command("DOM.getDocument", {
          "depth"  => JSON::Any.new(-1_i64),
          "pierce" => JSON::Any.new(true),
        }, session_id).as_h["result"].as_h["root"]
        pairs = [] of ShadowPair
        collect_shadow_pairs(document, pairs)
        return nil if pairs.empty?

        basket_params = {
          "expression" => JSON::Any.new("[]"),
        }
        basket_params["contextId"] = JSON::Any.new(context_id) if context_id
        basket_result = command("Runtime.evaluate", basket_params, session_id)
        basket = basket_result.as_h["result"].as_h["result"].as_h["objectId"].as_s
        registered = 0
        begin
          pairs.each do |pair|
            resolve_params = {"nodeId" => JSON::Any.new(pair.host_id)}
            resolve_params["executionContextId"] = JSON::Any.new(context_id) if context_id
            host = command("DOM.resolveNode", resolve_params, session_id)
              .as_h["result"].as_h["object"].as_h["objectId"].as_s
            resolve_params["nodeId"] = JSON::Any.new(pair.root_id)
            root = command("DOM.resolveNode", resolve_params, session_id)
              .as_h["result"].as_h["object"].as_h["objectId"].as_s
            arguments = [
              JSON::Any.new({"objectId" => JSON::Any.new(host)}),
              JSON::Any.new({"objectId" => JSON::Any.new(root)}),
              JSON::Any.new({"value" => JSON::Any.new(pair.kind)}),
            ]
            command("Runtime.callFunctionOn", {
              "objectId"            => JSON::Any.new(basket),
              "functionDeclaration" => JSON::Any.new("function (host, root, kind) { this.push([host, root, null, kind]); }"),
              "arguments"           => JSON::Any.new(arguments),
            }, session_id)
            registered += 1
          rescue
            # A node can disappear between the pierced listing and resolve.
          end
          return nil if registered == 0
          paired_expression = layout ? EXTRACT_AX_WITH_PAIRS.sub("layout:false", "layout:true") : EXTRACT_AX_WITH_PAIRS
          answer = command("Runtime.callFunctionOn", {
            "objectId"            => JSON::Any.new(basket),
            "functionDeclaration" => JSON::Any.new("function () { return #{paired_expression}; }"),
            "returnByValue"       => JSON::Any.new(true),
          }, session_id).as_h["result"].as_h
          if exception = answer["exceptionDetails"]?
            raise IO::Error.new("privileged accessibility extraction failed: #{exception.to_json}")
          end
          answer["result"].as_h["value"].as_a
        ensure
          command("Runtime.releaseObject", {"objectId" => JSON::Any.new(basket)}, session_id) rescue nil
        end
      rescue
        # A privileged scan is an enhancement. Keep the complete ordinary
        # extraction if the document navigated or a pierced node disappeared.
        nil
      end

      private def collect_shadow_pairs(node : JSON::Any, pairs : Array(ShadowPair)) : Nil
        object = node.as_h
        host_id = object["nodeId"]?.try(&.as_i64?)
        if host_id && (roots = object["shadowRoots"]?)
          roots.as_a.each do |root|
            root_object = root.as_h
            kind = root_object["shadowRootType"]?.try(&.as_s?) || "closed"
            if kind == "closed" || kind == "user-agent"
              pairs << ShadowPair.new(host_id, root_object["nodeId"].as_i64, kind)
            end
            collect_shadow_pairs(root, pairs)
          end
        end
        if content = object["contentDocument"]?
          collect_shadow_pairs(content, pairs)
        end
        if children = object["children"]?
          children.as_a.each { |child| collect_shadow_pairs(child, pairs) }
        end
      end

      private def frame_ids(tree : JSON::Any) : Array(String)
        ids = [tree.as_h["frame"].as_h["id"].as_s]
        if children = tree.as_h["childFrames"]?
          children.as_a.each { |child| ids.concat(frame_ids(child)) }
        end
        ids
      end

      # One pushed event, read for the bookkeeping it carries. Public because
      # the conformance harness feeds the announcements a real browser would
      # push, there being no browser behind a recorded channel.
      def note_event(message : JSON::Any) : Nil
        object = message.as_h
        case object["method"]?.try(&.as_s?)
        when "Target.targetCreated"
          info = object["params"].as_h["targetInfo"].as_h
          if info["type"]?.try(&.as_s?) == "iframe"
            @iframe_targets << info["targetId"].as_s
          end
        when "Target.targetDestroyed"
          @iframe_targets.delete(object["params"].as_h["targetId"].as_s)
        when "Runtime.executionContextCreated"
          context = object["params"].as_h["context"].as_h
          auxiliary = context["auxData"]?.try(&.as_h?)
          if auxiliary && auxiliary["isDefault"]?.try(&.as_bool?)
            if frame_id = auxiliary["frameId"]?.try(&.as_s?)
              @contexts[frame_id] = {context["id"].as_i64, object["sessionId"]?.try(&.as_s?)}
            end
          end
        when "Runtime.executionContextDestroyed"
          id = object["params"].as_h["executionContextId"].as_i64
          @contexts.reject! { |_frame, context| context[0] == id }
        when "Runtime.executionContextsCleared"
          @contexts.clear
        when "Page.lifecycleEvent"
          parameters = object["params"].as_h
          if parameters["frameId"]?.try(&.as_s?) == @main_frame_id
            name = parameters["name"]?.try(&.as_s?) || ""
            # A new document starts the count again; anything else it reaches
            # is something a wait can stop waiting for.
            if name == "init"
              @reached.clear
              @loading = true
            else
              @reached << name
              @loading = false if name == "load"
            end
          end
        when "Page.frameNavigated"
          frame = object["params"].as_h["frame"].as_h
          if frame["id"]?.try(&.as_s?) == @main_frame_id
            @url = frame["url"]?.try(&.as_s?) || @url
          end
        when "Page.navigatedWithinDocument"
          parameters = object["params"].as_h
          if parameters["frameId"]?.try(&.as_s?) == @main_frame_id
            @url = parameters["url"]?.try(&.as_s?) || @url
          end
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
