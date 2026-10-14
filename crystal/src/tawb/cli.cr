require "./blocks"
require "./browser"
require "./cdp"
require "./dump"
require "./edb"
require "./firefox_dump"
require "./frames"
require "./interactive"
require "./layout"
require "./lynx_display"
require "./library_chromium"
require "./lynx_settings"
require "./lynx_state"
require "./log"
require "./options"
require "./runtime"
require "./settings"
require "./startup"

module Tawb
  module Cli
    USAGE = <<-TEXT
    Usage: tawb [options] [address]

    Read a page in a full-screen terminal interface.

    Front end:
      --front-end <name>            default, lynx or edb (TAWB_FRONT_END)

    Reader:
      --keyboard                    open the key binding wizard and exit
      --dump                        write the page as plain text and exit
      --alt-screen                  use the alternate screen (default)
      --no-alt-screen               keep the session on the ordinary screen
      --escape-unicode              write non-ASCII text as Unicode escapes
      --link-address                announce the link under the cursor (default)
      --no-link-address             start with the status row quiet
      --short-links                 shorten same-site links to their path
      --close-initial-tab-on-exit   close the tab this session opened on exit
      --search <url>                search template with %s (TAWB_SEARCH)

    Browser:
      --browser <name>              chromium or firefox
      --connect <port|url>          attach to a browser already running
      --profile <dir>               the browser profile to use
      --keep-browser                leave the browser running after quitting
      --browser-timeout <seconds>   how long to wait for the browser to start

    Logging:
      --log                         write a diagnostic log
      --log-dir <dir>               where to write it (TAWB_LOG_DIR)

    Other:
      -h, --help                    show this help and exit

    The native Crystal reader reads pages interactively through Firefox and
    Chromium, in this interface or Lynx's, and writes dumps through either.
    The edb front end hands the same browser to edbrowse over http, which
    brings edbrowse's own screen and its editor with it; see `--front-end edb
    --help`.
    TEXT

    def self.run(argv : Array(String) = ARGV, env : Hash(String, String) = ENV.to_h) : Nil
      Runtime.restore_invocation_directory(env["INIT_CWD"]?)
      # Options a reader wrote down once come first, so anything typed on the
      # command line wins — which is what a reader expects of a configuration
      # file.
      argv = Settings.read(env) + argv
      # The edbrowse front end takes its own options — a port to listen on,
      # and none of the reader's screen settings — so it parses the command
      # line itself rather than being handed the reader's answers. Which front
      # end was asked for is the one thing both parses agree about.
      if asked_for_edb?(argv, env)
        if argv.includes?("--keyboard") || argv.includes?("--dump")
          raise ArgumentError.new("--front-end edb cannot be combined with --keyboard or --dump")
        end
        return run_edb(argv, env)
      end
      options = Options.parse_reader(argv, env)
      if options["help"].as_bool
        STDOUT << USAGE
        return
      end
      if options["keyboard"].as_bool && options["dump"].as_bool
        raise ArgumentError.new("--keyboard cannot be combined with --dump")
      end
      logger = Log.new
      log_path = options["log"].as_bool ? logger.enable(options["logDir"].as_s?) : nil
      logger.write("start", {
        "url"       => options["url"],
        "logPath"   => log_path ? JSON::Any.new(log_path) : JSON::Any.new(nil),
        "connect"   => options["connect"],
        "engine"    => options["engine"],
        "interface" => options["frontEnd"],
      })
      if options["dump"].as_bool
        begin
          run_dump(options)
          logger.write("exit")
        ensure
          logger.close
        end
        return
      end
      # The keyboard screen is a flag on a reader front end rather than a
      # front end of its own, and it needs no browser: it edits the key file
      # and nothing else.
      if options["keyboard"].as_bool
        begin
          run_keyboard_wizard(options)
          logger.write("exit")
        ensure
          logger.close
        end
        return
      end
      begin
        run_interactive(options, logger)
        logger.write("exit")
      ensure
        logger.close
      end
    rescue error
      STDERR.puts(error.message || error.class.name)
      exit 1
    end

    # What the browser calls itself on the accessibility bus, which is the
    # fallback for a browser reached with --connect: that browser was running
    # before this reader existed, so there is no pid of this reader's to match.
    CHROMIUM_NAMES = ["Chromium", "Chrome", "Google Chrome", "Chromium-browser"]
    FIREFOX_NAMES  = ["Firefox", "Mozilla Firefox", "firefox"]

    # What a browser this reader is about to drive looks like once it is
    # open: the session to act through, the address it is listening on, and
    # the pieces of shutdown that are the engine's own.
    private record OpenedBrowser,
      browser : Engine::Session,
      endpoint : String,
      library_port : Int32?,
      launched : FirefoxLaunch::Started?,
      chromium : Browser::Session?,
      # The accessibility bus this browser describes its own windows to, and
      # the process that is this browser on it. Both nil for a machine with no
      # D-Bus, which is an ordinary state of affairs rather than a failure:
      # that reader never meets a native dialog and never notices.
      a11y : A11yBus::Opened? = nil,
      pid : Int64? = nil,
      names : Array(String) = [] of String

    private def self.run_interactive(options : Hash(String, JSON::Any), logger : Log) : Nil
      chromium = options["engine"].as_s != "firefox"
      profile = options["profile"].as_s? ||
                (chromium ? Browser.default_profile : FirefoxLaunch.default_profile)
      timeout = options["browserTimeoutMs"].as_i64? || 45_000_i64
      startup = StartupStatus.new(->(text : String) { STDOUT << text; STDOUT.flush; nil },
        LibC.isatty(STDOUT.fd) == 1)
      opened = if chromium
                 open_chromium(options, profile, timeout, startup, logger)
               else
                 open_firefox(options, profile, timeout, startup, logger)
               end
      browser = opened.browser
      endpoint = opened.endpoint
      launched = opened.launched
      terminal = Runtime::Terminal.new(STDOUT, STDIN.fd, options["altScreen"].as_bool)
      reader = nil.as(Input::KeyReader?)
      page = nil.as(Engine::Page?)
      adopted = false
      begin
        begin
          # Firefox announces navigation on the session; Chromium announces
          # it on the tab, so there is nothing session-wide to subscribe to.
          if browser.is_a?(FirefoxDriver::BrowserSession)
            browser.start_verified(opened.library_port)
            browser.subscribe(FirefoxDriver::NAVIGATION_EVENTS)
          end
        ensure
          startup.finish
        end
        existing = browser.list_pages.reject(&.closed?).map(&.as(Engine::Page))
        if options["connect"].as_s? && options["url"].as_s?.nil?
          page = existing.reverse.find { |candidate| candidate.url != "about:blank" }
          adopted = !page.nil?
        end
        page ||= existing.first? || browser.create_page.as(Engine::Page)

        layout = options["frontEnd"].as_s == "lynx"
        browser_port = URI.parse(endpoint).port.try(&.to_i32)
        core = Core.new(source: "ax", layout: layout, driver: browser,
          page: page, browser_port: browser_port)
        core.adopt_tab(page.not_nil!)
        binding = Interactive::CoreBinding.new(core)
        tabs = Interactive::Tabs.new(core, browser, page.not_nil!)
        state = Reader::State.new
        state.core = binding
        state.tabs = tabs
        state.interface = options["frontEnd"].as_s
        state.link_address = options["linkAddress"].as_bool
        state.short_links = options["shortLinks"].as_bool
        state.escape_unicode = options["escapeUnicode"].as_bool
        state.search = options["search"].as_s
        # The views the backslash cycle offers: what the native extraction
        # can actually build, which today is AX alone.
        state.sources = Core::EXTRACTABLE_SOURCES.dup
        # The browser's own bookmarks, history and downloads. Firefox answers
        # through the privileged agent installed while it starts; Chromium
        # answers through pages of its own. Each engine is asked the way that
        # engine can be asked, and the reader's screens cannot tell which
        # answered.
        case session = browser
        when Cdp::BrowserSession
          state.browser_library = Interactive::ChromiumLibraryBinding.new(session)
        else
          if library_port = opened.library_port
            state.browser_library = Interactive::LibraryBinding.new(library_port)
          end
        end
        size = Runtime.terminal_size
        state.rows = size[:rows]
        state.cols = size[:cols]
        state.keys = if state.interface == "lynx"
                       LynxState.lynx_keymap_for(options["lynxReimport"].as_bool,
                         options["lynxExecutable"].as_s, options["lynxConfig"].as_s?)
                     else
                       Keys::Keymap.new(profile: state.interface)
                     end

        resolved = options["url"].as_s?.try do |typed|
          Address.resolve(typed, options["search"].as_s)["url"].as_s?
        end || "https://www.google.com"
        split = Auth.split_credentials(resolved)
        target = split["url"].as_s
        state.home_url = target

        # Authentication can interrupt the first navigation, so the terminal
        # and keyboard must belong to the reader before that navigation starts.
        terminal.acquire
        reader = Input::KeyReader.new(STDIN)
        keyboard = Interactive::Keyboard.new(reader.not_nil!)
        credentials = Auth::Credentials.new(
          ->(challenge : JSON::Any, refused : Bool, _attempt : Int32) {
            ReaderKeys.ask_for_password(terminal, state, keyboard, challenge, refused)
          },
          ->(event : String, fields : Hash(String, JSON::Any)) { logger.write(event, fields); nil })
        state.credentials = Interactive::CredentialBinding.new(credentials)
        if username = split["username"].as_s?
          credentials.remember(JSON::Any.new({"url" => JSON::Any.new(target)}),
            JSON::Any.new({"username" => JSON::Any.new(username),
                           "password" => split["password"]}))
        end
        # The password prompt a 401 raises is drawn by browser chrome, so it
        # can only be answered through an interception the engine offers.
        # Firefox has an auth-only intercept, armed for the whole session;
        # Chromium's goes through Fetch and is armed per tab, as the tab is
        # adopted — see Core#adopt_tab.
        case session = browser
        when FirefoxDriver::BrowserSession
          session.attach_auth(->(challenge : JSON::Any, id : String, _page : FirefoxDriver::Page?) {
            credentials.answer(challenge, id)
          })
        when Cdp::BrowserSession
          session.attach_auth(->(challenge : JSON::Any, id : String) {
            credentials.answer(challenge, id)
          })
          # The tab was adopted before the handler existed, so it is armed
          # now; every tab adopted afterwards arms itself.
          page.not_nil!.arm_auth rescue nil
        end
        unless adopted
          logger.timed("goto", {"url" => JSON::Any.new(target)}) { page.not_nil!.goto(target) }
        end

        Reader.refresh(state, tabs.current_page, true)
        Reader.render(terminal, state, tabs.current_page.url, true)
        core.attach_live rescue nil

        # Dialogs the browser draws for itself: an extension asking for
        # consent, a file to be chosen, permission for something. Neither
        # protocol has them; the browser's own accessibility interface does.
        # The question goes on the terminal, the reader answers there, and the
        # answer presses the dialog's own button — the same move the password
        # prompt makes, for the same reason.
        #
        # Nothing is arranged if the browser cannot describe its windows. That
        # is an ordinary state of affairs — a browser somebody else started, a
        # machine with no D-Bus — and it costs a reader who never installs
        # anything nothing at all.
        native = NativePrompt.arm(bus: opened.a11y, pid: opened.pid,
          names: opened.names, log: logger) do |request|
          ReaderKeys.answer_native_dialog(terminal, state, tabs.current_page, keyboard,
            Interactive::DialogBinding.new(request), logger)
        end

        # A window that changed shape: the lines were wrapped to the old
        # width and the rows counted to the old height, so neither describes
        # what is on screen now. The wizard and the options screen draw their
        # own rows, so they are left to redraw themselves.
        Signal::WINCH.trap do
          resized = Runtime.terminal_size
          state.rows = resized[:rows]
          state.cols = resized[:cols]
          unless state.mode == "keyboard" || state.mode == "options"
            Reader.redraw_after_resize(terminal, state, tabs.current_page.url) rescue nil
          end
        end

        loop do
          key = reader.not_nil!.next
          break if key.is_a?(Input::Eof)
          chunk = key.as(String)
          break if chunk == ReaderKeys::ALWAYS_QUIT
          current = tabs.current_page
          verdict = case state.mode
                    when "library"
                      ReaderKeys.handle_library_key(terminal, state, current, keyboard, chunk)
                    when "choose"
                      ReaderKeys.handle_choose_key(terminal, state, current, chunk); nil
                    when "type"
                      ReaderKeys.handle_type_key(terminal, state, current, chunk); nil
                    when "field-command"
                      ReaderKeys.handle_field_command_key(terminal, state, current, chunk); nil
                    when "forms"
                      ReaderKeys.handle_forms_key(terminal, state, current, keyboard, chunk); nil
                    when "control"
                      ReaderKeys.handle_control_key(terminal, state, current, chunk); nil
                    when "page"
                      ReaderKeys.handle_page_key(terminal, state, current, chunk, Time.utc.to_unix_ms); nil
                    when "address"
                      ReaderKeys.handle_address_key(terminal, state, current, keyboard, chunk); nil
                    when "find"
                      ReaderKeys.handle_find_key(terminal, state, current.url, chunk); nil
                    when "number"
                      ReaderKeys.handle_number_key(terminal, state, current, keyboard, chunk); nil
                    when "options"
                      ReaderKeys.handle_lynx_options_key(terminal, state, current, chunk); nil
                    else
                      ReaderKeys.handle_browse_key(terminal, state, current, keyboard, chunk,
                        Time.utc.to_unix_ms)
                    end
          break if verdict == "quit"
        end
      ensure
        Signal::WINCH.reset rescue nil
        native.try(&.stop) rescue nil
        reader.try(&.close)
        terminal.restore
        if options["closeInitialTabOnExit"].as_bool && !adopted && page
          count = browser.list_pages.reject(&.closed?).size rescue 0
          Runtime.close_initial_tab(Interactive::Page.new(page.not_nil!), count,
            options["keepBrowser"].as_bool,
            ->(event : String, fields : Hash(String, JSON::Any)) { logger.write(event, fields); nil })
        end
        if release_port = URI.parse(endpoint).port
          Session.release_tab(release_port.to_i32) rescue nil
        end
        keep = options["keepBrowser"].as_bool || adopted
        case session = browser
        when FirefoxDriver::BrowserSession
          if keep
            # The broker holds the BiDi session for the next reader, which is
            # what keeps a kept browser usable rather than merely running.
            session.protocol.command(Broker::RETAIN_SESSION) rescue nil
            session.close(false)
          else
            session.close
          end
        when Cdp::BrowserSession
          # Detach this reader's flat target sessions and close its persistent
          # connection; the tabs and browser belong to their own processes.
          session.close
        end
        keep_browser = options["keepBrowser"].as_bool
        browser_stays = if started = launched
                          started.release(keep_browser)
                        elsif chromium = opened.chromium
                          chromium.release(keep_browser)
                        else
                          true # a browser reached through --connect is not ours
                        end
        # A browser that stays — deliberately or because another reader is in
        # it — keeps the bus it was started with. The registry owns that bus
        # until the browser itself is forgotten.
        if bus = opened.a11y
          if browser_stays && bus.owned?
            bus.leave_running rescue nil
          else
            bus.close rescue nil
          end
        end
      end
    end

    # Which front end `--front-end <name>` asked for, read off the command
    # line before anything is parsed. The reader's parser rejects the edb
    # front end's own options and the edb parser rejects the reader's, so
    # which parser to use has to be decided first.
    private def self.asked_for_edb?(argv : Array(String), env : Hash(String, String)) : Bool
      return true if argv.includes?("edb") || argv.includes?("--front-end=edb")
      named = front_end_argument(argv)
      return named == "edb" if named
      Options.front_end_name(env["TAWB_FRONT_END"]?) == "edb"
    end

    private def self.front_end_argument(argv : Array(String)) : String?
      at = 0
      while at < argv.size
        value = argv[at]
        return Options.front_end_name(argv[at + 1]?) if value == "--front-end"
        if value.starts_with?("--front-end=")
          return Options.front_end_name(value["--front-end=".size..])
        end
        at += 1
      end
      nil
    end

    # The front-end argument removed, in both spellings, so that the edb
    # parser is handed only options it knows about. `tawb edb` is accepted as
    # a bare word too, the way the Node program's own command is spelled.
    private def self.without_front_end(argv : Array(String)) : Array(String)
      kept = [] of String
      at = 0
      while at < argv.size
        value = argv[at]
        if value == "--front-end"
          at += 2
          next
        end
        if value == "--front-end=edb" || value == "edb"
          at += 1
          next
        end
        kept << value
        at += 1
      end
      kept
    end

    # The edbrowse bridge: a browser, and an http origin that serves it. The
    # settings file is read first, exactly as the reader reads it, so a
    # `--front-end edb` in there brings its own browser options with it.
    private def self.run_edb(argv : Array(String), env : Hash(String, String)) : Nil
      options = Options.parse_edb(without_front_end(argv), env)
      if options["help"].as_bool
        STDOUT << Edb::USAGE
        return
      end
      logger = Log.new
      logger.enable(options["logDir"].as_s?) if options["log"].as_bool
      begin
        Edb.run(options, logger)
      ensure
        logger.close
      end
    end

    # The keyboard screen, standing alone. There is no session screen to draw
    # on, so the wizard takes the one the session would have: the alternate
    # screen unless the reader said otherwise.
    private def self.run_keyboard_wizard(options : Hash(String, JSON::Any)) : Nil
      keymap = if options["frontEnd"].as_s == "lynx"
                 LynxState.lynx_keymap_for(options["lynxReimport"].as_bool,
                   options["lynxExecutable"].as_s, options["lynxConfig"].as_s?)
               else
                 Keys::Keymap.new(profile: options["frontEnd"].as_s)
               end
      terminal = Runtime::Terminal.new(STDOUT, STDIN.fd, options["altScreen"].as_bool)
      reader = Input::KeyReader.new(STDIN)
      begin
        terminal.acquire
        KeyWizard.run(Runtime::WizardScreen.new(terminal), keymap,
          Runtime::WizardKeys.new(reader), options["altScreen"].as_bool)
      ensure
        reader.close
        terminal.restore
      end
    end

    # Firefox, through the broker that holds its one session: every reader on
    # this profile shares that session, so the browser is reached through the
    # broker rather than directly.
    private def self.open_firefox(options : Hash(String, JSON::Any), profile : String,
                                  timeout : Int64, startup : StartupStatus,
                                  logger : Log) : OpenedBrowser
      startup.update("Starting Firefox…")
      launched = nil.as(FirefoxLaunch::Started?)
      endpoint = begin
        if connected = options["connect"].as_s?
          firefox_endpoint(connected)
        else
          launched = FirefoxLaunch.launch(profile, timeout, log: logger)
          launched.not_nil!.endpoint
        end
      rescue error
        startup.finish
        raise error
      end
      broker_url = begin
        Broker.ensure(profile, endpoint)[:url]
      rescue error
        startup.finish
        launched.try(&.close) unless options["keepBrowser"].as_bool
        raise error
      end
      library_port = launched.try(&.library_port) ||
                     Endpoint.read_record(profile).try(&.["libraryPort"]?.try(&.as_i?).try(&.to_i32))
      OpenedBrowser.new(
        browser: FirefoxDriver::BrowserSession.new(broker_url),
        endpoint: endpoint,
        library_port: library_port,
        launched: launched,
        chromium: nil,
        a11y: launched.try(&.a11y) || A11yBus.open(logger),
        pid: launched.try(&.pid),
        names: FIREFOX_NAMES)
    end

    # Chromium, over its own HTTP endpoint. There is no broker: CDP permits
    # each reader its own persistent browser connection and flat target
    # sessions, so readers do not share a session that one must hold open for
    # the other.
    private def self.open_chromium(options : Hash(String, JSON::Any), profile : String,
                                   timeout : Int64, startup : StartupStatus,
                                   logger : Log) : OpenedBrowser
      startup.update("Starting Chromium…")
      session = begin
        Browser.open(chromium_endpoint(options["connect"].as_s?), profile, timeout, logger)
      rescue error
        startup.finish
        raise error
      end
      OpenedBrowser.new(
        browser: Cdp::BrowserSession.new(session.endpoint),
        endpoint: session.endpoint,
        library_port: nil,
        launched: nil,
        chromium: session,
        a11y: session.a11y,
        pid: session.pid,
        names: CHROMIUM_NAMES)
    end

    # What --connect means to Chromium: an HTTP endpoint. A bare port is the
    # ordinary way to say it, so a port becomes one.
    private def self.chromium_endpoint(connect : String?) : String?
      return nil unless connect
      return connect if connect.starts_with?("http://") || connect.starts_with?("https://")
      port = connect.to_i32?
      raise ArgumentError.new("--connect needs a port or HTTP URL, not #{connect}") unless port
      "http://127.0.0.1:#{port}"
    end

    private def self.firefox_endpoint(connect : String) : String
      return connect if connect.starts_with?("ws://") || connect.starts_with?("wss://")
      uri = URI.parse(connect)
      port = uri.port
      raise ArgumentError.new("--connect needs a port or WebSocket URL, not #{connect}") unless port
      "ws://127.0.0.1:#{port}/session"
    end

    private def self.run_dump(options : Hash(String, JSON::Any)) : Nil
      if options["engine"].as_s == "firefox"
        FirefoxDump.run(options)
        return
      end
      target = Dump.resolve_target(options["url"].as_s?, search: options["search"].as_s)
      timeout = options["browserTimeoutMs"].as_i64?
      session = Browser.open(options["connect"].as_s?, options["profile"].as_s?, timeout)
      browser = Cdp::BrowserSession.new(session.endpoint)
      page = nil
      begin
        page = browser.create_page
        page.navigate(target)
        Dump.settle_embedded_frames(page)
        lynx = options["frontEnd"].as_s == "lynx"
        tree, documents = page.accessibility_documents(layout: lynx)
        blocks = Frames.build(tree, documents)
        if lynx
          display = LynxDisplay.blocks(blocks, LynxSettings.preferences, options["escapeUnicode"].as_bool)
          lines = Layout.lines(display, 80)
          unless lines.empty?
            STDOUT << lines.map { |line| LynxDisplay.row_text(line, line.as_h["text"].as_s) }.join('\n') << '\n'
          end
        else
          STDOUT << Dump.format_ax_blocks(blocks, options["escapeUnicode"].as_bool)
        end
      ensure
        if current_page = page
          if session.owned? && !options["keepBrowser"].as_bool
            current_page.close_browser
            session.close
          else
            current_page.close
            session.release(true) if session.owned? && options["keepBrowser"].as_bool
          end
        elsif session.owned?
          session.close
        end
        browser.close rescue nil
      end
    end
  end
end
