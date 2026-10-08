require "./blocks"
require "./browser"
require "./cdp"
require "./dump"
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

    The native Crystal reader is being ported incrementally. Browser sessions
    are not available from this executable yet.
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
        raise ArgumentError.new("the native Lynx dump is not ported yet") if options["frontEnd"].as_s == "lynx"
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
      page = Cdp::Page.new(session.endpoint)
      begin
        page.navigate(target)
        blocks = Blocks.build(page.accessibility_items)
        STDOUT << Dump.format_ax_blocks(blocks, options["escapeUnicode"].as_bool)
      ensure
        if session.owned?
          page.close_browser
        else
          page.close
        end
        session.close
      end
    end
  end
end
