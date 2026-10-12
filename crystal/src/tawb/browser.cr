require "file_utils"
require "json"
require "socket"
require "./detach"
require "./transport"

module Tawb
  module Browser
    CANDIDATES      = {"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"}
    ENDPOINT_RECORD = "tawb-endpoint.json"
    LEGACY_RECORD   = ".tawb-devtools-port"

    class Session
      getter endpoint : String

      def initialize(@endpoint : String, @process : Process? = nil, @owned = false,
                     @profile_dir : String? = nil, @grouped = false)
      end

      def owned? : Bool
        @owned
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

    def self.open(connect : String?, profile : String?, timeout_ms : Int64?) : Session
      return Session.new(connect.not_nil!) if connect
      profile_dir = profile || default_profile
      FileUtils.mkdir_p(profile_dir)
      if endpoint = running_endpoint(profile_dir)
        return Session.new(endpoint)
      end
      executable = find_executable || raise IO::Error.new(
        "No browser found. Looked for: #{CANDIDATES.join(", ")}. Install Chrome or Chromium."
      )
      port = free_port
      arguments = [
        "--user-data-dir=#{profile_dir}",
        "--remote-debugging-port=#{port}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ]
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
      spawned = Detach.spawn(command, arguments)
      process = spawned.process
      endpoint = "http://127.0.0.1:#{port}"
      deadline = Time.instant + (timeout_ms || 25000).milliseconds
      last_error = nil
      loop do
        begin
          Transport.http(endpoint, "GET", "/json/version")
          File.write(File.join(profile_dir, ENDPOINT_RECORD), {
            "port"      => JSON::Any.new(port.to_i64),
            "pid"       => JSON::Any.new(process.pid.to_i64),
            "startedAt" => JSON::Any.new(Time.utc.to_unix_ms),
          }.to_json)
          return Session.new(endpoint, process, owned: true, profile_dir: profile_dir,
            grouped: spawned.grouped)
        rescue error
          last_error = error
          if Time.instant >= deadline
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

    private def self.default_profile : String
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
