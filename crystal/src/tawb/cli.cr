require "./blocks"
require "./browser"
require "./cdp"
require "./dump"
require "./firefox_dump"
require "./frames"
require "./interactive"
require "./layout"
require "./lynx_display"
require "./lynx_settings"
require "./lynx_state"
require "./log"
require "./options"
require "./runtime"
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

    The native Crystal reader supports interactive Firefox and default or
    Lynx dumps with Firefox and Chromium. Interactive Chromium and edb are
    not yet available.
    TEXT

    def self.run(argv : Array(String) = ARGV, env : Hash(String, String) = ENV.to_h) : Nil
      Runtime.restore_invocation_directory(env["INIT_CWD"]?)
      options = Options.parse_reader(argv, env)
      if options["help"].as_bool
        STDOUT << USAGE
        return
      end
      if options["frontEnd"].as_s == "edb" && (options["keyboard"].as_bool || options["dump"].as_bool)
        raise ArgumentError.new("--front-end edb cannot be combined with --keyboard or --dump")
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

    private def self.run_interactive(options : Hash(String, JSON::Any), logger : Log) : Nil
      unless options["engine"].as_s == "firefox"
        raise ArgumentError.new(
          "The native interactive reader currently needs --browser firefox; Chromium interactive support is not ported yet.")
      end
      if options["frontEnd"].as_s == "edb"
        raise ArgumentError.new("The native edb front end is not ported yet")
      end
      if options["keyboard"].as_bool
        raise ArgumentError.new("The standalone native keyboard wizard is not connected yet")
      end

      profile = options["profile"].as_s? || FirefoxLaunch.default_profile
      timeout = options["browserTimeoutMs"].as_i64? || 45_000_i64
      startup = StartupStatus.new(->(text : String) { STDOUT << text; STDOUT.flush; nil },
        LibC.isatty(STDOUT.fd) == 1)
      startup.update("Starting Firefox…")
      launched = nil.as(FirefoxLaunch::Started?)
      endpoint = begin
        if connected = options["connect"].as_s?
          firefox_endpoint(connected)
        else
          launched = FirefoxLaunch.launch(profile, timeout)
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
      browser = FirefoxDriver::BrowserSession.new(broker_url)
      terminal = Runtime::Terminal.new(STDOUT, STDIN.fd, options["altScreen"].as_bool)
      reader = nil.as(Input::KeyReader?)
      page = nil.as(FirefoxDriver::Page?)
      adopted = false
      begin
        begin
          browser.start
        ensure
          startup.finish
        end
        browser.subscribe(FirefoxDriver::NAVIGATION_EVENTS)
        existing = browser.list_pages.reject(&.closed?)
        if options["connect"].as_s? && options["url"].as_s?.nil?
          page = existing.reverse.find { |candidate| candidate.url != "about:blank" }
          adopted = !page.nil?
        end
        page ||= existing.first? || browser.create_page

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
        state.rows = terminal_rows
        state.cols = terminal_columns
        state.keys = if state.interface == "lynx"
                       LynxState.lynx_keymap_for(options["lynxReimport"].as_bool,
                         options["lynxExecutable"].as_s, options["lynxConfig"].as_s?)
                     else
                       Keys::Keymap.new(profile: state.interface)
                     end

        target = options["url"].as_s?.try do |typed|
          Address.resolve(typed, options["search"].as_s)["url"].as_s?
        end || "https://www.google.com"
        unless adopted
          logger.timed("goto", {"url" => JSON::Any.new(target)}) { page.not_nil!.goto(target) }
        end

        terminal.acquire
        reader = Input::KeyReader.new(STDIN)
        keyboard = Interactive::Keyboard.new(reader.not_nil!)
        Reader.refresh(state, tabs.current_page, true)
        Reader.render(terminal, state, tabs.current_page.url, true)
        core.attach_live rescue nil

        loop do
          key = reader.not_nil!.next
          break if key.is_a?(Input::Eof)
          chunk = key.as(String)
          break if chunk == ReaderKeys::ALWAYS_QUIT
          current = tabs.current_page
          verdict = case state.mode
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
                    else
                      ReaderKeys.handle_browse_key(terminal, state, current, keyboard, chunk,
                        Time.utc.to_unix_ms)
                    end
          break if verdict == "quit"
        end
      ensure
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
        if options["keepBrowser"].as_bool || adopted
          browser.protocol.command(Broker::RETAIN_SESSION) rescue nil
          browser.close(false)
        else
          browser.close
        end
        if started = launched
          started.close if started.owned? && !options["keepBrowser"].as_bool
        end
      end
    end

    private def self.firefox_endpoint(connect : String) : String
      return connect if connect.starts_with?("ws://") || connect.starts_with?("wss://")
      uri = URI.parse(connect)
      port = uri.port
      raise ArgumentError.new("--connect needs a port or WebSocket URL, not #{connect}") unless port
      "ws://127.0.0.1:#{port}/session"
    end

    private def self.terminal_rows : Int32
      ENV["LINES"]?.try(&.to_i32?) || 24
    end

    private def self.terminal_columns : Int32
      ENV["COLUMNS"]?.try(&.to_i32?) || 80
    end

    private def self.run_dump(options : Hash(String, JSON::Any)) : Nil
      if options["engine"].as_s == "firefox"
        FirefoxDump.run(options)
        return
      end
      target = Dump.resolve_target(options["url"].as_s?, search: options["search"].as_s)
      timeout = options["browserTimeoutMs"].as_i64?
      session = Browser.open(options["connect"].as_s?, options["profile"].as_s?, timeout)
      page = nil
      begin
        page = Cdp::Page.new(session.endpoint)
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
          end
        elsif session.owned?
          session.close
        end
      end
    end
  end
end
