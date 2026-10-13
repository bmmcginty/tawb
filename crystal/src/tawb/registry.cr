require "json"
require "./log"
require "./processes"
require "./session"

module Tawb
  # The browsers tawb has started, so that one it never got to close can be
  # found and taken down later.
  #
  # Closing a session kills the browser's whole process group, which is enough
  # whenever a session gets to finish. A session that does not — killed
  # outright, or by the out-of-memory killer — leaves a browser running with
  # no parent and no record of it anywhere a later session would look. The
  # endpoint record in the profile directory names it, but only that
  # profile's; nothing enumerates them, so nothing could ever clean up after a
  # crash.
  #
  # So every browser this program starts is written down here, beside the tab
  # claims, and every launch sweeps the list first. An entry is only a hint,
  # in the same way a tab claim is: it is believed as far as a live process
  # group whose command line still names the profile it was recorded against.
  #
  # One file per browser, named by its port, rather than one file listing them
  # all. Sessions start browsers concurrently — a test run starts several at
  # once — and a shared list means read, modify, write, which is a lost update
  # whenever two of them overlap. A lost entry here is a browser that can
  # never be swept, which is the one thing this is for. Separate files never
  # collide.
  module Registry
    record Entry,
      pid : Int64,
      port : Int32,
      profile_dir : String?,
      engine : String?,
      owner : Int64?,
      keep : Bool,
      at : Int64,
      a11y_pid : Int64?,
      a11y_address : String?

    def self.directory : String
      File.join(Session.state_dir, "browsers")
    end

    def self.entry_path(port : Int32) : String
      File.join(directory, "#{port}.json")
    end

    def self.read_entry(port : Int32) : Entry?
      object = JSON.parse(File.read(entry_path(port))).as_h
      pid = object["pid"]?.try(&.as_i64?)
      held = object["port"]?.try(&.as_i64?)
      return nil unless pid && held && pid != 0 && held != 0
      Entry.new(
        pid: pid,
        port: held.to_i32,
        profile_dir: object["profileDir"]?.try(&.as_s?),
        engine: object["engine"]?.try(&.as_s?),
        owner: object["owner"]?.try(&.as_i64?),
        keep: object["keep"]?.try(&.as_bool?) || false,
        at: object["at"]?.try(&.as_i64?) || 0_i64,
        a11y_pid: object["a11yPid"]?.try(&.as_i64?),
        a11y_address: object["a11yAddress"]?.try(&.as_s?),
      )
    rescue
      nil
    end

    def self.write_entry(entry : Entry) : Nil
      Dir.mkdir_p(directory)
      File.write(entry_path(entry.port), {
        "pid"         => JSON::Any.new(entry.pid),
        "port"        => JSON::Any.new(entry.port.to_i64),
        "profileDir"  => JSON::Any.new(entry.profile_dir),
        "engine"      => JSON::Any.new(entry.engine),
        "owner"       => entry.owner ? JSON::Any.new(entry.owner.not_nil!) : JSON::Any.new(nil),
        "keep"        => JSON::Any.new(entry.keep),
        "at"          => JSON::Any.new(entry.at),
        "a11yPid"     => entry.a11y_pid ? JSON::Any.new(entry.a11y_pid.not_nil!) : JSON::Any.new(nil),
        "a11yAddress" => JSON::Any.new(entry.a11y_address),
      }.to_json)
    rescue
      # A lost entry costs a sweep, not a crash.
    end

    def self.drop_entry(port : Int32) : Nil
      File.delete?(entry_path(port))
    rescue
      # Nothing to drop.
    end

    def self.read : Array(Entry)
      names = begin
        Dir.children(directory)
      rescue
        return [] of Entry
      end
      found = [] of Entry
      names.each do |name|
        next unless name.ends_with?(".json")
        port = name[0, name.size - ".json".size].to_i?
        next unless port
        entry = read_entry(port)
        found << entry if entry
      end
      found
    end

    # Replaces the whole set. Nothing in a session needs this — a session only
    # ever writes its own browser's entry — but a test setting up a situation
    # does.
    def self.write(entries : Array(Entry)) : Nil
      read.each { |entry| drop_entry(entry.port) }
      entries.each { |entry| write_entry(entry) }
    end

    # Whether this process id is still the browser that was recorded, rather
    # than whatever inherited its number afterwards.
    #
    # This is the check that makes the sweep safe to run. Signalling a whole
    # process group by a remembered pid is a large thing to be wrong about,
    # and a pid is reused freely, so the group is only signalled when the
    # process still carries the profile directory it was started with on its
    # command line — which both the browser and the xvfb-run wrapping it do.
    def self.ours?(pid : Int64, profile_dir : String?) : Bool
      return false if profile_dir.nil? || profile_dir.empty?
      command = begin
        File.read("/proc/#{pid}/cmdline")
      rescue
        return false # gone, not ours to read, or a platform without /proc
      end
      arguments = command.split('\0')
      arguments.includes?("--user-data-dir=#{profile_dir}") || arguments.includes?(profile_dir)
    end

    def self.record(pid : Int64?, port : Int32?, profile_dir : String?, engine : String?,
                    a11y_pid : Int64? = nil, a11y_address : String? = nil) : Nil
      return if pid.nil? || port.nil? || pid == 0 || port == 0
      write_entry(Entry.new(
        pid: pid, port: port, profile_dir: profile_dir, engine: engine,
        owner: Process.pid.to_i64, keep: false, at: Time.utc.to_unix_ms,
        a11y_pid: a11y_pid, a11y_address: a11y_address,
      ))
    end

    # A private session bus belongs to the browser that was started on it.
    # Check the command before signalling: a pid can be reused, and stopping
    # an unrelated desktop bus would be much worse than leaking one of this
    # program's.
    def self.stop_companion(entry : Entry?) : Bool
      return false unless entry
      pid = entry.a11y_pid
      return false if pid.nil? || pid == 0
      command = begin
        File.read("/proc/#{pid}/cmdline")
      rescue
        return false
      end
      socket = (entry.a11y_address || "").match(/^unix:path=([^,;]+)/).try(&.[1])
      return false if socket.nil?
      return false unless command.includes?("dbus-daemon") && command.includes?("--nofork") &&
                          command.includes?("--address=unix:path=#{socket}")
      begin
        Processes.kill_group(pid)
        File.delete?(socket)
        # The bus's configuration is written beside its socket; a sweep runs
        # in a process that never held the daemon, so that process's own exit
        # cleanup will not run.
        File.delete?("#{socket}.conf")
        true
      rescue
        false
      end
    end

    # A browser that has been taken down, or one that was never this
    # program's to take down.
    def self.forget(port : Int32?) : Nil
      return if port.nil? || port == 0
      entry = read_entry(port)
      stop_companion(entry) if entry
      drop_entry(port)
    end

    # --keep-browser: left running on purpose, so never swept.
    def self.mark_kept(port : Int32?) : Nil
      return if port.nil? || port == 0
      entry = read_entry(port) || return
      write_entry(Entry.new(
        pid: entry.pid, port: entry.port, profile_dir: entry.profile_dir,
        engine: entry.engine, owner: entry.owner, keep: true, at: entry.at,
        a11y_pid: entry.a11y_pid, a11y_address: entry.a11y_address,
      ))
    end

    # Take down browsers left behind by sessions that are no longer running.
    #
    # A browser is stranded when the session that started it has gone without
    # closing it, no other reader has claimed a tab in it, and it was not
    # left running on purpose. Anything else is somebody's — a live session's
    # browser, a browser a second reader joined, or one --keep-browser asked
    # to stay — and is left alone.
    def self.sweep_stranded(log : Log? = nil) : Int32
      entries = read
      return 0 if entries.empty?
      swept = 0
      entries.each do |entry|
        unless Processes.alive?(entry.pid) && ours?(entry.pid, entry.profile_dir)
          # The browser may have crashed while its private accessibility bus
          # kept running. Both were recorded together, so both are forgotten
          # together.
          forget(entry.port)
          next
        end
        next if entry.keep || Processes.alive?(entry.owner) || Session.other_readers_on(entry.port)
        log.try(&.write("browser.stranded", {
          "pid"        => JSON::Any.new(entry.pid),
          "port"       => JSON::Any.new(entry.port.to_i64),
          "engine"     => JSON::Any.new(entry.engine),
          "profileDir" => JSON::Any.new(entry.profile_dir),
        }))
        Processes.kill_group(entry.pid)
        forget(entry.port)
        swept += 1
      end
      swept
    end
  end
end
