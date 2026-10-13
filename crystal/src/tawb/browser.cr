require "file_utils"
require "json"
require "socket"
require "uri"
require "./a11y_bus"
require "./detach"
require "./log"
require "./registry"
require "./transport"

module Tawb
  module Browser
    CANDIDATES      = {"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"}
    ENDPOINT_RECORD = "tawb-endpoint.json"
    LEGACY_RECORD   = ".tawb-devtools-port"

    class Session
      getter endpoint : String
      # The accessibility bus this browser describes its own windows to, which
      # is where a native dialog is read from. Nil is an ordinary answer: a
      # machine with no D-Bus has no native dialogs to offer. See `atspi.cr`.
      getter a11y : A11yBus::Opened?
      # The process this reader started, which is how the application on the
      # accessibility bus is told apart from every other browser on the
      # desktop. Nil for a browser somebody else started.
      getter pid : Int64?

      def initialize(@endpoint : String, @process : Process? = nil, @owned = false,
                     @profile_dir : String? = nil, @grouped = false,
                     @a11y : A11yBus::Opened? = nil)
        @pid = @process.try(&.pid.to_i64)
      end

      def owned? : Bool
        @owned
      end

      # The port this browser is listening on, which is the name the registry
      # keeps it under.
      def port : Int32?
        URI.parse(@endpoint).port.try(&.to_i32)
      rescue
        nil
      end

      # Letting go of a browser this session started.
      #
      # Ours to close only while nobody else is reading it — starting the
      # browser makes this reader its first user, not its owner. A browser
      # left running on purpose is marked so, or a later sweep would mistake
      # it for one somebody crashed out of.
      def release(keep : Bool) : Bool
        return true unless @owned
        if keep
          Registry.mark_kept(port)
          return true
        end
        return true if ::Tawb::Session.other_readers_on(port || 0)
        close
        # Forgetting also stops a private accessibility-bus daemon recorded as
        # this browser's companion.
        Registry.forget(port)
        false
      end

      def close : Nil
        process = @process
        return unless process
        if @grouped
          # The browser leads a process group of its own, so the signalled
          # group takes the wrapper (xvfb-run) and every browser process with
          # it. Terminating the wrapper alone orphans the browser, which then
          # holds the profile and refuses the next launch.
          LibC.kill(-process.pid, LibC::SIGTERM)
        end
        process.terminate
        process.wait
      rescue
      ensure
        if profile_dir = @profile_dir
          File.delete?(File.join(profile_dir, ENDPOINT_RECORD))
          File.delete?(File.join(profile_dir, LEGACY_RECORD))
        end
      end
    end

    def self.open(connect : String?, profile : String?, timeout_ms : Int64?,
                  log : Log? = nil) : Session
      # A browser somebody else started: this reader has no pid of its own to
      # match on the accessibility bus, so the application is found by name
      # instead. See `Atspi::Accessibility#application_for`.
      return Session.new(connect.not_nil!, a11y: A11yBus.open(log)) if connect
      profile_dir = profile || default_profile
      FileUtils.mkdir_p(profile_dir)
      # Sweep before looking for a browser to rejoin: a stranded browser still
      # has a live endpoint, but belongs to no surviving reader.
      Registry.sweep_stranded(log)
      if endpoint = running_endpoint(profile_dir)
        # A browser already running on this profile: the reader that started
        # the browser recorded the bus it was given, and that recorded address
        # is the one to read native windows on.
        record = JSON.parse(File.read(File.join(profile_dir, ENDPOINT_RECORD))).as_h rescue nil
        return Session.new(endpoint, a11y: A11yBus.recorded(record) || A11yBus.open(log))
      end
      executable = find_executable || raise IO::Error.new(
        "No browser found. Looked for: #{CANDIDATES.join(", ")}. Install Chrome or Chromium."
      )
      port = free_port
      # Somewhere for Chromium to describe its own windows to, before Chromium
      # is started: the bus has to exist for the browser to register with, and
      # the browser's environment has to name it. See `a11y_bus.cr`.
      a11y = A11yBus.open(log)
      log.try(&.write("a11y.unavailable", {
        "reason" => JSON::Any.new(a11y.reason),
      })) unless a11y.available?
      arguments = [
        "--user-data-dir=#{profile_dir}",
        "--remote-debugging-port=#{port}",
        "--no-first-run",
        "--no-default-browser-check",
      ]
      # Platform accessibility, without which AT-SPI shows the application and
      # the window frame and nothing inside them:
      # `AXPlatformNodeAuraLinux::CreateAtkObject()` refuses to build a node
      # for anything that is not a top-level window unless `AXMode::kNativeAPIs`
      # is set, and nothing else sets it. `basic` is enough. See `atspi.cr`.
      arguments << "--force-renderer-accessibility=basic" if a11y.available?
      arguments << "about:blank"
      command = executable
      unless ENV["DISPLAY"]?
        xvfb = Detach.which("xvfb-run") || raise IO::Error.new(
          "No DISPLAY is set and xvfb-run was not found. Install xvfb, or run inside a graphical session."
        )
        command = xvfb
        arguments = ["-a", "-s", "-screen 0 1280x1024x24", executable] + arguments
      end
      # Detached into a session of its own, so a terminal's Ctrl+C and a
      # terminal closing both spare a browser that was asked to be kept. See
      # Detach.
      spawned = Detach.spawn(command, arguments, env: a11y.env)
      process = spawned.process
      endpoint = "http://127.0.0.1:#{port}"
      deadline = Time.instant + (timeout_ms || 25000).milliseconds
      last_error = nil
      loop do
        begin
          Transport.http(endpoint, "GET", "/json/version")
          File.write(File.join(profile_dir, ENDPOINT_RECORD), {
            "port"        => JSON::Any.new(port.to_i64),
            "pid"         => JSON::Any.new(process.pid.to_i64),
            "startedAt"   => JSON::Any.new(Time.utc.to_unix_ms),
            # Recorded for the reader that rejoins a kept browser: the bus is
            # a browser-lifetime resource, and a later reader has no other way
            # to find a private one.
            "a11yAddress" => a11y.available? ? JSON::Any.new(a11y.address) : JSON::Any.new(nil),
            "a11yPid"     => a11y.owned? ? JSON::Any.new(a11y.pid) : JSON::Any.new(nil),
          }.to_json)
          Registry.record(process.pid.to_i64, port, profile_dir, "chromium",
            a11y.owned? ? a11y.pid : nil, a11y.owned? ? a11y.address : nil)
          return Session.new(endpoint, process, owned: true, profile_dir: profile_dir,
            grouped: spawned.grouped, a11y: a11y)
        rescue error
          last_error = error
          if Time.instant >= deadline
            a11y.close
            process.terminate rescue nil
            raise IO::TimeoutError.new(
              "Chromium did not open its debugging port within #{timeout_ms || 25000}ms: #{last_error.message}"
            )
          end
          sleep 200.milliseconds
        end
      end
    end

    private def self.running_endpoint(profile_dir : String) : String?
      endpoint_record = File.join(profile_dir, ENDPOINT_RECORD)
      legacy_record = File.join(profile_dir, LEGACY_RECORD)
      chromium_record = File.join(profile_dir, "DevToolsActivePort")
      port = if File.file?(endpoint_record)
               JSON.parse(File.read(endpoint_record)).as_h["port"].as_i
             elsif File.file?(legacy_record)
               File.read_lines(legacy_record).first?.try(&.strip.to_i?)
             elsif File.file?(chromium_record)
               File.read_lines(chromium_record).first?.try(&.strip.to_i?)
             end
      return nil unless port
      endpoint = "http://127.0.0.1:#{port}"
      Transport.http(endpoint, "GET", "/json/version")
      endpoint
    rescue
      nil
    end

    private def self.find_executable : String?
      CANDIDATES.each do |candidate|
        found = Detach.which(candidate)
        return found if found
      end
      nil
    end

    # Where a Chromium profile lives when the reader was not told. Public
    # because the interactive path needs the same answer the dump path gets.
    def self.default_profile : String
      base = ENV["XDG_DATA_HOME"]? || File.join(Path.home, ".local", "share")
      File.join(base, "tawb", "profile")
    end

    private def self.free_port : Int32
      server = TCPServer.new("127.0.0.1", 0)
      port = server.local_address.port
      server.close
      port
    end
  end
end
