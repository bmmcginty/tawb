require "./blocks"
require "./browser"
require "./cdp"
require "./dump"
require "./frames"
require "./layout"
require "./lynx_display"
require "./lynx_settings"
require "./options"

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

    Other:
      -h, --help                    show this help and exit

    The native Crystal reader is being ported incrementally. Default and Lynx
    Chromium --dump are available; interactive, Firefox, and edb are not yet.
    TEXT

    def self.run(argv : Array(String) = ARGV, env : Hash(String, String) = ENV.to_h) : Nil
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
      if options["dump"].as_bool
        unless options["engine"].as_s == "chromium"
          raise ArgumentError.new("the native Firefox dump is not ported yet")
        end
        run_dump(options)
        return
      end
      STDERR.puts "The native Crystal interactive reader is not ported yet; use --dump or --help."
      exit 2
    rescue error
      STDERR.puts(error.message || error.class.name)
      exit 1
    end

    private def self.run_dump(options : Hash(String, JSON::Any)) : Nil
      target = Dump.resolve_target(options["url"].as_s?, search: options["search"].as_s)
      timeout = options["browserTimeoutMs"].as_i64?
      session = Browser.open(options["connect"].as_s?, options["profile"].as_s?, timeout)
      page = nil
      begin
        page = Cdp::Page.new(session.endpoint)
        page.navigate(target)
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
