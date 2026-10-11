require "json"

module Tawb
  # Opt-in NDJSON diagnostics. The logger opens lazily, creates a private
  # directory and file, and treats every filesystem failure as a disabled log:
  # diagnostics must never take the browser or terminal down.
  class Log
    REVISION = {{ `git rev-parse HEAD 2>/dev/null || printf unknown`.strip.stringify }}

    getter path : String?

    def self.timestamp(now : Time) : String
      now.to_s("%Y%m%d%H%M%S")
    end

    def self.default_path(now : Time = Time.local, pid : Int64 = Process.pid.to_i64,
                          home : String = Path.home.to_s,
                          directory : String? = nil) : String
      File.join(directory || home, ".tawb.#{timestamp(now)}.#{pid}.log")
    end

    def initialize
      @path = nil
      @enabled_at = nil.as(Time?)
      @file = nil.as(File?)
      @started = Time.instant
      @counters = {} of String => Int64
    end

    def enable(directory : String? = nil, now : Time = Time.local,
               pid : Int64 = Process.pid.to_i64, home : String = Path.home.to_s) : String
      return @path.not_nil! if @path
      @enabled_at = now
      @path = Log.default_path(now, pid, home, directory)
      @path.not_nil!
    end

    def write(event : String, fields : Hash(String, JSON::Any) = {} of String => JSON::Any) : Nil
      output = open_file || return
      record = {"t" => JSON::Any.new((Time.instant - @started).total_milliseconds.to_i64),
                "event" => JSON::Any.new(event)}
      fields.each { |key, value| record[key] = value }
      output << record.to_json << '\n'
      output.flush
    rescue
      close_file
    end

    def timed(event : String, fields : Hash(String, JSON::Any) = {} of String => JSON::Any,
              &block : -> T) : T forall T
      started = Time.instant
      begin
        answer = yield
        write(event, fields.merge({"ms" => JSON::Any.new((Time.instant - started).total_milliseconds.to_i64)}))
        answer
      rescue error
        detail = (error.message || error.to_s)[0, Math.min((error.message || error.to_s).size, 200)]
        write(event, fields.merge({
          "ms"    => JSON::Any.new((Time.instant - started).total_milliseconds.to_i64),
          "error" => JSON::Any.new(detail),
        }))
        raise error
      end
    end

    def count(name : String, amount : Int64 = 1_i64) : Nil
      return unless @path
      @counters[name] = (@counters[name]? || 0_i64) + amount
    end

    def flush_counters(extra : Hash(String, JSON::Any) = {} of String => JSON::Any) : Nil
      return unless @path
      snapshot = {} of String => JSON::Any
      @counters.each { |key, value| snapshot[key] = JSON::Any.new(value) }
      extra.each { |key, value| snapshot[key] = value }
      @counters.clear
      write("counters", snapshot) unless snapshot.empty?
    end

    def flush : Nil
      @file.try(&.flush)
    rescue
    end

    def close : Nil
      close_file
    end

    def disable : String?
      disabled = @path
      close_file
      @path = nil
      @enabled_at = nil
      @counters.clear
      disabled
    end

    private def open_file : File?
      return nil unless path = @path
      return @file if @file
      Dir.mkdir_p(File.dirname(path), 0o700)
      file = File.open(path, "w", perm: 0o600)
      enabled = @enabled_at || Time.local
      file << "# tawb log #{enabled.to_rfc3339} pid #{Process.pid} commit #{REVISION}\n"
      file.flush
      @file = file
    rescue
      @file = nil
    end

    private def close_file : Nil
      file = @file
      @file = nil
      file.try(&.close)
    rescue
    end
  end
end
