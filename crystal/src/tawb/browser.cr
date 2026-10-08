require "file_utils"
require "socket"
require "./transport"

module Tawb
  module Browser
    CANDIDATES = {"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"}

    class Session
      getter endpoint : String

      def initialize(@endpoint : String, @process : Process? = nil)
      end

      def owned? : Bool
        !@process.nil?
      end

      def close : Nil
        process = @process
        return unless process
        process.terminate
        process.wait
      rescue
      end
    end

    def self.open(connect : String?, profile : String?, timeout_ms : Int64?) : Session
      return Session.new(connect.not_nil!) if connect
      executable = find_executable || raise IO::Error.new(
        "No browser found. Looked for: #{CANDIDATES.join(", ")}. Install Chrome or Chromium."
      )
      port = free_port
      profile_dir = profile || default_profile
      FileUtils.mkdir_p(profile_dir)
      arguments = [
        "--user-data-dir=#{profile_dir}",
        "--remote-debugging-port=#{port}",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ]
      command = executable
      unless ENV["DISPLAY"]?
        xvfb = which("xvfb-run") || raise IO::Error.new(
          "No DISPLAY is set and xvfb-run was not found. Install xvfb, or run inside a graphical session."
        )
        command = xvfb
        arguments = ["-a", "-s", "-screen 0 1280x1024x24", executable] + arguments
      end
      process = Process.new(command, arguments,
        input: Process::Redirect::Close,
        output: Process::Redirect::Close,
        error: Process::Redirect::Close)
      endpoint = "http://127.0.0.1:#{port}"
      deadline = Time.instant + (timeout_ms || 25000).milliseconds
      last_error = nil
      loop do
        begin
          Transport.http(endpoint, "GET", "/json/version")
          return Session.new(endpoint, process)
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

    def self.which(command : String) : String?
      (ENV["PATH"]? || "").split(':').each do |directory|
        candidate = File.join(directory, command)
        info = File.info?(candidate)
        return candidate if info && info.file? && File::Info.executable?(candidate)
      end
      nil
    end

    private def self.find_executable : String?
      CANDIDATES.each do |candidate|
        found = which(candidate)
        return found if found
      end
      nil
    end

    private def self.default_profile : String
      base = ENV["XDG_DATA_HOME"]? || File.join(Path.home, ".local", "share")
      File.join(base, "tawb", "profile-crystal")
    end

    private def self.free_port : Int32
      server = TCPServer.new("127.0.0.1", 0)
      port = server.local_address.port
      server.close
      port
    end
  end
end
