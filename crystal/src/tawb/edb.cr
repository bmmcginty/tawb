require "json"
require "./a11y_bus"
require "./actions"
require "./broker"
require "./browser"
require "./core"
require "./edb_server"
require "./engine"
require "./firefox_launch"
require "./log"

module Tawb
  # The edbrowse side of tawb: a browser, and an http origin that serves it.
  #
  # Same browser as the reader — started normally, attached to, never launched
  # by an automation harness — for the same reason: a browser that fails bot
  # checks is not a degraded reader, it is a broken one. What differs is who
  # does the reading. Here edbrowse renders the html and owns the screen, and
  # this program is only the thing that knows how to drive a real browser.
  #
  #     tawb --front-end edb
  #
  # It prints the addresses to use, writes them to
  # ~/.local/share/tawb/edb.json for the entry-point plugin to find, and then
  # stays out of the way until it is stopped.
  #
  # This file is the seam between `edb_server.cr`, which knows what edbrowse
  # needs and nothing about a browser, and the engines. See
  # `Edb::BrowserEnv`.
  module Edb
    # The three things that run inside the page, from `src/edb_page.js`. A
    # descriptor is how an element is named on the wire — a path through the
    # document, the tag, the accessible name, the position in document order —
    # and any process with a connection to the browser can resolve one, which
    # is what keeps the transport open.
    EXTRACT = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/edb_extract.js") }})
    RESOLVE = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/edb_resolve.js") }})
    APPLY   = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/edb_apply.js") }})

    # The walk, called with the closed shadow roots the protocol can lend it.
    # `this` is the array of pairs; see `Cdp::Page#privileged_run`.
    EXTRACT_WITH_PAIRS = "(#{EXTRACT})({pairs:this,pierce:true})"

    # Asking for the roots the page can reach itself, which is what Firefox's
    # privileged parent script installs. Harmless on Chromium, where the
    # symbol is absent.
    PIERCE_OPTION = JSON::Any.new({"pierce" => JSON::Any.new(true)})

    # The element the resolver left behind, ready to be pressed.
    RESOLVED = "() => window[Symbol.for('tweb.resolved')]"
    FOCUS_RESOLVED = "() => { const el = window[Symbol.for('tweb.resolved')]; " \
                     "if (el && typeof el.focus === 'function') el.focus(); return true; }"

    # One document of a real browser.
    class EngineDocument
      include DocumentEnv

      def initialize(@page : Engine::Page, @frame : Engine::Frame, @log : Log? = nil)
      end

      def url : String
        @frame.url
      rescue
        ""
      end

      def extract : JSON::Any
        first = @frame.evaluate(EXTRACT, PIERCE_OPTION)
        tokens = first.as_h?.try(&.["tokens"]?.try(&.as_a?)) || [] of JSON::Any
        return first unless tokens.empty?
        # Nothing to read is what a document behind a closed shadow root looks
        # like, and it is what a bot check looks like, so this is where
        # edbrowse would otherwise be shown nothing at all.
        pierced = begin
          @frame.pierce_and_run(EXTRACT_WITH_PAIRS)
        rescue
          nil
        end
        pierced && !pierced.raw.nil? ? pierced : first
      end

      # The documents the markup mentions, in document order. Matched by the
      # element that hosts each one, which Chromium answers directly and
      # Firefox answers by position — the same two answers the JavaScript
      # original gets from the same two engines.
      def ordered_frames : Array(DocumentEnv)
        found = [] of DocumentEnv
        @frame.query_all("iframe, frame").each do |handle|
          begin
            child = handle.content_frame
            found << EngineDocument.new(@page, child, @log) if child
          rescue
            # Inaccessible frame: detached, or a sandbox that cannot be
            # reached.
          ensure
            handle.dispose rescue nil
          end
        end
        found
      end

      # The documents the markup never mentions. An <iframe> inside a closed
      # shadow root cannot be found by walking for elements, so the browser is
      # asked instead and whatever the elements did not account for is what
      # the markup never mentioned.
      def hidden_frames : Array(DocumentEnv)
        placed = Set(String).new
        ordered_frames.each do |each|
          placed << each.as(EngineDocument).document_id
        end
        found = [] of DocumentEnv
        @frame.child_frames.each do |child|
          document = EngineDocument.new(@page, child, @log)
          next if placed.includes?(document.document_id)
          found << document
        end
        found
      end

      # A name that means "the same document" across two listings of it.
      def document_id : String
        @frame.document_id
      rescue
        ""
      end

      def apply_fields(entries : Array(FieldEntry)) : Applied
        payload = JSON::Any.new(entries.map do |entry|
          JSON::Any.new({
            "path"  => JSON::Any.new(entry.path),
            "tag"   => JSON::Any.new(entry.tag),
            "value" => JSON::Any.new(entry.value),
          })
        end)
        answered = @frame.evaluate(APPLY, payload).as_h?
        Applied.new(
          (answered.try(&.["applied"]?.try(&.as_i?)) || 0),
          (answered.try(&.["missed"]?.try(&.as_a?)) || [] of JSON::Any).map(&.as_s),
        )
      rescue
        Applied.new(0, [] of String)
      end

      def activate(desc : JSON::Any, real : Bool) : Outcome
        handle = resolve(desc)
        return Outcome.new(false, why: "that element is no longer on the page") unless handle
        begin
          # Resolving is this program's — a descriptor handed out in a form is
          # not something the core knows about — but what happens to the
          # element once it is held is the ordinary action, timeouts and all.
          # It is the same press the reader makes.
          unless real
            Actions.activate(handle)
            return Outcome.new(true, how: "path")
          end
          answered = Actions.real_click(handle).as_h?
          if answered.try(&.["ok"]?.try(&.as_bool?))
            Outcome.new(true, how: "path")
          else
            reason = answered.try(&.["reason"]?.try(&.as_s?)) || "could not be found on the page"
            Outcome.new(false, why: "a real click cannot reach it: it #{reason}")
          end
        ensure
          handle.dispose rescue nil
        end
      end

      def press_enter(desc : JSON::Any) : Bool
        return false unless resolve_in_page(desc)
        @frame.evaluate(FOCUS_RESOLVED)
        @page.keyboard.press("Enter")
        true
      rescue
        false
      end

      # The descriptor resolved in this document, as a reference. The path is
      # tried first and is right almost always; when the structure has shifted
      # the tag and the accessible name identify the element, and document
      # order picks between duplicates.
      private def resolve(desc : JSON::Any) : Engine::Handle?
        return nil unless resolve_in_page(desc)
        @frame.evaluate_handle(RESOLVED)
      rescue
        nil
      end

      private def resolve_in_page(desc : JSON::Any) : Bool
        argument = JSON::Any.new({"desc" => desc, "pierce" => JSON::Any.new(true)})
        found = @frame.evaluate(RESOLVE, argument)
        return true unless found.raw.nil?
        # Not found by ordinary means may mean the element is behind a closed
        # shadow root, which is where the extractor found it in the first
        # place. Being able to see something that cannot then be acted on is
        # no use at all.
        pierced = begin
          @frame.pierce_and_run("(#{RESOLVE})({desc:#{desc.to_json},pairs:this,pierce:true})")
        rescue
          nil
        end
        !(pierced.nil? || pierced.raw.nil?)
      rescue
        false
      end
    end

    # One tab of a real browser.
    class EngineTab
      include TabEnv

      getter page : Engine::Page

      def initialize(@page : Engine::Page, @session : Engine::Session,
                     @layout : Bool = false, @log : Log? = nil)
      end

      def url : String
        @page.url
      rescue
        ""
      end

      def title : String
        @page.title
      rescue
        ""
      end

      def closed? : Bool
        @page.closed?
      rescue
        true
      end

      def goto(url : String) : Nil
        @page.goto(url)
      end

      # Back, in the tab the reader is reading. The page's own history object
      # is the one both engines already reach, and it is the same history a
      # back button moves through.
      def back : Nil
        @page.evaluate("() => window.history.back()")
      end

      def close : Nil
        @page.close
      end

      # The Firefox session caches the url it was last told to visit, so a
      # move through history leaves the cache naming the page before. The
      # document knows.
      def sync_url : Nil
        real = @page.evaluate("() => location.href").as_s?
        @page.set_url(real) if real && !real.empty?
      rescue
        # A tab that will not answer keeps whatever url it had.
      end

      def document : DocumentEnv
        EngineDocument.new(@page, @page.main_frame, @log)
      end

      # The reader's own four line lists, built by the same extraction the
      # reader uses: a core of its own in that view, asked once. This is how
      # the accessibility tree stays reachable from edbrowse, which matters
      # because it is the view that is right when a page's markup is wrong.
      def view(kind : String) : Array(String)
        core = Core.new(source: kind, layout: @layout, driver: @session, page: @page)
        core.rescan(@page).map(&.text)
      rescue error
        @log.try(&.write("edb.view.failed", {
          "view"  => JSON::Any.new(kind),
          "error" => JSON::Any.new((error.message || "")[0, 160]),
        }))
        [] of String
      end

      def arm_auth : Nil
        page = @page
        page.arm_auth if page.is_a?(Cdp::Page)
      rescue
        # Firefox's intercept is armed for the whole session, not per tab.
      end

      def same?(other : EngineTab) : Bool
        @page.same?(other.page)
      rescue
        false
      end
    end

    # The browser, as a tab inventory.
    #
    # Tabs are identified by the page object the session answers with, so the
    # wrapper has to be stable: `Tabs` keys its numbers by the tab it was
    # handed, and a fresh wrapper per listing would hand out a fresh number
    # every time. So the wrappers are kept here, one per page.
    class EngineBrowser
      include BrowserEnv

      @asked : AuthAsk?

      def initialize(@session : Engine::Session, @layout : Bool = false, @log : Log? = nil)
        @wrappers = [] of EngineTab
        @asked = nil
      end

      def name : String
        @session.is_a?(Cdp::BrowserSession) ? "chromium" : "firefox"
      end

      def alive? : Bool
        @session.list_pages
        true
      rescue
        false
      end

      def tabs : Array(TabEnv)
        open = begin
          @session.list_pages.reject(&.closed?).map(&.as(Engine::Page))
        rescue
          [] of Engine::Page
        end
        open.map { |page| wrapper_for(page).as(TabEnv) }
      end

      def new_tab : TabEnv
        wrapper_for(@session.create_page.as(Engine::Page))
      end

      # The password prompt a 401 raises is answered through the engine's own
      # intercept: Firefox's is armed for the whole session, Chromium's goes
      # through Fetch and is armed per tab as the tab is handed out. Which tab
      # a challenge belongs to is what the server needs, so the page a
      # challenge arrived on is looked up among the wrappers.
      #
      def attach_auth(asked : AuthAsk) : Nil
        @asked = asked
        session = @session
        if session.is_a?(FirefoxDriver::BrowserSession)
          session.attach_auth(
            ->(challenge : JSON::Any, id : String, page : FirefoxDriver::Page?) : JSON::Any? {
              answer_challenge(challenge, id, page)
            })
        elsif session.is_a?(Cdp::BrowserSession)
          session.attach_auth(
            ->(challenge : JSON::Any, id : String) : JSON::Any? {
              answer_challenge(challenge, id, nil)
            })
        end
      end

      private def answer_challenge(challenge : JSON::Any, id : String,
                                   page : Engine::Page?) : JSON::Any?
        asked = @asked || return nil
        asked.call(challenge, id, page ? wrapper_for(page).as(TabEnv) : nil)
      end

      def close : Nil
        @session.close
      end

      private def wrapper_for(page : Engine::Page) : EngineTab
        found = @wrappers.find do |wrapper|
          begin
            wrapper.page.same?(page)
          rescue
            false
          end
        end
        return found if found
        fresh = EngineTab.new(page, @session, @layout, @log)
        @wrappers << fresh
        fresh
      end
    end

    # ------------------------------------------------------------------
    # Running it
    # ------------------------------------------------------------------

    # One way to get a browser, used twice: once at the start, and again
    # whenever the reader closes the one they were reading. Nothing about the
    # server outlives a browser, so the second time has to be the same as the
    # first — an ordinary browser, started or rejoined exactly as before,
    # never an automated one.
    record Opened,
      browser : EngineBrowser,
      launched : FirefoxLaunch::Started?,
      chromium : Browser::Session?,
      a11y : A11yBus::Opened?

    def self.open_browser(options : Hash(String, JSON::Any), logger : Log) : Opened
      profile = options["profile"].as_s? ||
                (options["engine"].as_s == "firefox" ? FirefoxLaunch.default_profile : Browser.default_profile)
      timeout = options["browserTimeoutMs"].as_i64? || 45_000_i64
      if options["engine"].as_s == "firefox"
        launched = nil.as(FirefoxLaunch::Started?)
        endpoint = if connected = options["connect"].as_s?
                     connected.starts_with?("ws") ? connected : "ws://127.0.0.1:#{connected}/session"
                   else
                     launched = FirefoxLaunch.launch(profile, timeout, log: logger)
                     launched.not_nil!.endpoint
                   end
        session = FirefoxDriver::BrowserSession.new(Broker.ensure(profile, endpoint)[:url])
        session.start
        session.subscribe(FirefoxDriver::NAVIGATION_EVENTS)
        Opened.new(EngineBrowser.new(session, log: logger), launched, nil,
          launched.try(&.a11y) || A11yBus.open(logger))
      else
        endpoint = options["connect"].as_s?
        endpoint = "http://127.0.0.1:#{endpoint}" if endpoint && !endpoint.starts_with?("http")
        chromium = Browser.open(endpoint, profile, timeout, logger)
        Opened.new(EngineBrowser.new(Cdp::BrowserSession.new(chromium.endpoint), log: logger),
          nil, chromium, chromium.a11y)
      end
    end

    USAGE = <<-TEXT
    Usage: tawb --front-end edb [options] [address]

    Run the edbrowse bridge: a browser and an http origin that serves it.

      --browser <name>              chromium or firefox
      --connect <port|url>          attach to a browser already running
      --profile <dir>               the browser profile to use
      --keep-browser                leave the browser running after quitting
      --browser-timeout <seconds>   how long to wait for the browser to start
      --port <number>               the port to listen on
      --log                         write a diagnostic log
      --log-dir <dir>               where to write it (TAWB_LOG_DIR)
      -h, --help                    show this help and exit

    TEXT

    def self.run(options : Hash(String, JSON::Any), logger : Log) : Nil
      logger.write("edb.start", {"engine" => options["engine"]})
      opened = open_browser(options, logger)
      server = Server.new(
        opened.browser,
        reopen: ->{ open_browser(options, logger).browser.as(BrowserEnv) },
        port: (options["port"]?.try(&.as_i?) || 0).to_i32,
        log: logger,
      )
      record = {
        "port"      => JSON::Any.new(server.port.to_i64),
        "token"     => JSON::Any.new(server.token),
        "pid"       => JSON::Any.new(Process.pid.to_i64),
        "startedAt" => JSON::Any.new(Time.utc.to_unix_ms),
      } of String => JSON::Any
      endpoint = Edb.write_endpoint(record)
      logger.write("edb.listen", {
        "port"     => JSON::Any.new(server.port.to_i64),
        "endpoint" => JSON::Any.new(endpoint),
      })

      first = nil.as(String?)
      if typed = options["url"].as_s?
        target = Edb.normalise_target(typed)
        if url = target.url
          tab = opened.browser.new_tab
          tab.goto(url)
          first = server.absolute_tab_url(server.tabs.number_for(tab))
        end
      end

      STDOUT << "tawb is serving #{options["engine"].as_s} for edbrowse.\n\n"
      STDOUT << "  tabs:   #{server.url}\n"
      STDOUT << "  page:   #{first}\n" if first
      STDOUT << "  open:   <t <address>        in edbrowse, once the plugin is\n"
      STDOUT << "                              installed — see edbrowse-plugin/\n"
      STDOUT << "\nStop with ctrl-c; the browser stays as you left it.\n"
      STDOUT.flush

      # The browser is the reader's, and a signal means the reader is done
      # with this bridge rather than with the browser: the browser stays as
      # they left it unless they asked otherwise.
      stopping = ::Channel(Nil).new(1)
      {Signal::INT, Signal::TERM, Signal::HUP}.each do |signal|
        signal.trap { stopping.send(nil) rescue nil }
      end
      spawn { server.listen }
      stopping.receive
      logger.write("edb.stop")
      server.close
      shut_down(options, opened)
    end

    private def self.shut_down(options : Hash(String, JSON::Any), opened : Opened) : Nil
      keep = options["keepBrowser"].as_bool
      browser_stays = if launched = opened.launched
                        launched.release(keep)
                      elsif chromium = opened.chromium
                        chromium.release(keep)
                      else
                        true # a browser reached through --connect is not ours
                      end
      if bus = opened.a11y
        if browser_stays && bus.owned?
          bus.leave_running rescue nil
        else
          bus.close rescue nil
        end
      end
    end
  end
end
