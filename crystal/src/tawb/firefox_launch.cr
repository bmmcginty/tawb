require "json"
require "./a11y_bus"
require "./detach"
require "./endpoint"
require "./log"
require "./marionette"
require "./registry"

module Tawb
  module FirefoxLaunch
    CANDIDATES = {"firefox", "firefox-esr", "librewolf"}

    def self.find_firefox(path = ENV["PATH"]? || "") : NamedTuple(executable: String, name: String)?
      CANDIDATES.each do |name|
        if executable = Detach.which(name, path)
          return {executable: executable, name: name}
        end
      end
      nil
    end

    def self.launch_preferences(marionette_port : Int32) : Hash(String, JSON::Any)
      {
        "media.autoplay.default"                   => JSON::Any.new(0_i64),
        "media.autoplay.blocking_policy"           => JSON::Any.new(0_i64),
        "media.block-autoplay-until-in-foreground" => JSON::Any.new(false),
        "signon.rememberSignons"                   => JSON::Any.new(true),
        "signon.autofillForms"                     => JSON::Any.new(true),
        "browser.altClickSave"                     => JSON::Any.new(true),
        # A portal file chooser can belong to another application, and under
        # Xvfb its backend has no usable display at all. Keep only file and
        # folder choosers in Firefox's own accessible GTK process; this does
        # not disable microphone, camera or screen-sharing portals.
        "widget.use-xdg-desktop-portal.file-picker" => JSON::Any.new(0_i64),
        "marionette.port"                          => JSON::Any.new(marionette_port.to_i64),
      }
    end

    def self.default_profile(executable : String? = nil, home = Path.home.to_s,
                             xdg_data_home = ENV["XDG_DATA_HOME"]?) : String
      if snap = snap_package_name(executable)
        return File.join(home, "snap", snap, "common", "tawb", "firefox-profile")
      end
      File.join(xdg_data_home || File.join(home, ".local", "share"), "tawb", "firefox-profile")
    end

    class Started
      getter endpoint : String
      getter port : Int32
      getter marionette_port : Int32?
      getter library_port : Int32?
      getter profile_dir : String
      # The accessibility bus this Firefox describes its own windows to, which
      # is where a permission doorhanger is read from. Nil is an ordinary
      # answer: a machine with no D-Bus has no native dialogs to offer. See
      # `atspi.cr`.
      getter a11y : A11yBus::Opened?
      # The process this reader started, which is how the application on the
      # accessibility bus is told apart from every other browser on the
      # desktop. Nil for a Firefox somebody else started.
      getter pid : Int64?

      def initialize(@endpoint, @port, @marionette_port, @library_port, @profile_dir,
                     @process : Process? = nil, @owned = false, @grouped = false,
                     @a11y : A11yBus::Opened? = nil)
        @pid = @process.try(&.pid.to_i64)
      end

      def owned? : Bool
        @owned
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
          Registry.mark_kept(@port)
          return true
        end
        return true if Session.other_readers_on(@port)
        close
        # Forgetting also stops a private accessibility-bus daemon recorded as
        # this browser's companion.
        Registry.forget(@port)
        false
      end

      def close : Nil
        process = @process
        return unless process
        if @grouped
          # The browser leads a process group of its own, so the signalled
          # group takes the wrapper (xvfb-run) and every browser process with
          # it — the territory JavaScript's detached spawn and
          # killProcessGroup cover.
          LibC.kill(-process.pid, LibC::SIGTERM)
        end
        # Where setsid was not available the group is won or lost in a race
        # with the child's exec, so the outcome is not assumed: everything
        # still descended from the browser we started is signalled too. A
        # wrapper that dies alone orphans the browser, which then holds the
        # profile and refuses the next launch.
        signal_descendants(process.pid)
        process.terminate
        process.wait
        File.delete?(Endpoint.record_path(@profile_dir))
      rescue
      end

      private def signal_descendants(root : Int64) : Nil
        parent_of = {} of Int64 => Int64
        Dir.each_child("/proc") do |entry|
          next unless entry.matches?(/^\d+$/)
          stat = File.read("/proc/#{entry}/stat")
          after = stat.rindex(')') || next
          fields = stat[after + 2..].split
          ppid = fields[1]?.try(&.to_i64?) || next
          parent_of[entry.to_i] = ppid
        rescue
          # a process that left while it was being read has no vote
        end
        children = {} of Int64 => Array(Int64)
        parent_of.each do |child, parent|
          (children[parent] ||= [] of Int64) << child
        end
        queue = [root]
        until queue.empty?
          (children[queue.shift]? || [] of Int64).each do |pid|
            LibC.kill(pid, LibC::SIGTERM) rescue nil
            queue << pid
          end
        end
      end
    end

    def self.launch(profile_dir : String, timeout_ms = 45000_i64,
                    path = ENV["PATH"]? || "", display = ENV["DISPLAY"]?,
                    log : Log? = nil) : Started
      process : Process? = nil
      Dir.mkdir_p(profile_dir)
      # Sweep before looking for a browser to rejoin: a stranded browser still
      # has a live endpoint, but belongs to no surviving reader.
      Registry.sweep_stranded(log)
      if port = Endpoint.running(profile_dir)
        record = Endpoint.read_record(profile_dir) || {} of String => JSON::Any
        return Started.new(
          "ws://127.0.0.1:#{port}/session", port,
          record["marionettePort"]?.try(&.as_i?).try(&.to_i32),
          record["libraryPort"]?.try(&.as_i?).try(&.to_i32), profile_dir,
          # A Firefox already running on this profile: the reader that started
          # it recorded the bus it was given, and that recorded address is the
          # one to read native windows on.
          a11y: A11yBus.recorded(record) || A11yBus.open(log)
        )
      end

      found = find_firefox(path) || raise IO::Error.new(
        "No Firefox found. Looked for: #{CANDIDATES.join(", ")}. Install Firefox, or use --browser chromium."
      )
      require_compatible_profile(found[:executable], found[:name], profile_dir)
      port = Endpoint.free_port
      marionette_port = Endpoint.free_port
      write_profile_prefs(profile_dir, launch_preferences(marionette_port))
      # Somewhere for Firefox to describe its own windows to, before Firefox is
      # started: the bus has to exist for Firefox to register with, and
      # Firefox's environment has to name it. Firefox needs no command-line
      # flag for platform accessibility the way Chromium does — what Firefox's
      # GTK bridge waits for is GNOME_ACCESSIBILITY in the environment, which
      # `A11yBus.open` sets. See `a11y_bus.cr`.
      a11y = A11yBus.open(log)
      log.try(&.write("a11y.unavailable", {
        "reason" => JSON::Any.new(a11y.reason),
      })) unless a11y.available?
      # On a bus this program made there is no desktop portal, and this
      # program answers the portal's own file chooser. So the file picker is
      # asked to go there after all — the opposite of the managed value, which
      # exists because a portal on a *desktop* bus delegates to a backend that
      # cannot start on this browser's private display.
      if a11y.owned?
        write_profile_prefs(profile_dir,
          launch_preferences(marionette_port).merge({
            "widget.use-xdg-desktop-portal.file-picker" => JSON::Any.new(1_i64),
          }))
      end
      arguments = [
        "--no-remote",
        "-profile", profile_dir,
        "--remote-debugging-port=#{port}",
        "--marionette",
        "--remote-allow-system-access",
        "about:blank",
      ]
      command = found[:executable]
      unless display && !display.empty?
        xvfb = Detach.which("xvfb-run", path) || raise IO::Error.new(
          "No DISPLAY is set and xvfb-run was not found. A browser with a display is required " +
          "(headless browsers fail bot checks that a real one passes). Install xvfb, or run " +
          "inside a graphical session."
        )
        command = xvfb
        arguments = [xvfb_display_option(xvfb), "-s", "-screen 0 1280x1024x24", found[:executable]] + arguments
      end

      # Detached into a session of its own, so a terminal's Ctrl+C and a
      # terminal closing both spare a browser somebody may be reading, and so
      # close can take the browser's whole group down with the wrapper that
      # started it. See Detach.
      # GTK only asks the portal when it is told to. On a bus this program
      # made, the portal is this program, so the ask is the point.
      browser_env = a11y.owned? ? a11y.env.merge({"GTK_USE_PORTAL" => "1"}) : a11y.env
      spawned = Detach.spawn(command, arguments, path, env: browser_env)
      process = spawned.process
      grouped = spawned.grouped
      deadline = Time.instant + timeout_ms.milliseconds
      unless Endpoint.wait(port, deadline)
        process.terminate rescue nil
        process.wait rescue nil
        raise IO::TimeoutError.new(
          "#{found[:name]} did not open its debugging port within #{timeout_ms}ms"
        )
      end

      Endpoint.write_record(profile_dir, {
        "port"           => JSON::Any.new(port.to_i64),
        "marionettePort" => JSON::Any.new(marionette_port.to_i64),
        "pid"            => JSON::Any.new(process.pid.to_i64),
        "startedAt"      => JSON::Any.new(Time.utc.to_unix_ms),
        # Recorded for the reader that rejoins a kept browser: the bus is a
        # browser-lifetime resource, and a later reader has no other way to
        # find a private one.
        "a11yAddress"    => a11y.available? ? JSON::Any.new(a11y.address) : JSON::Any.new(nil),
        "a11yPid"        => a11y.owned? ? JSON::Any.new(a11y.pid) : JSON::Any.new(nil),
      })
      unless Endpoint.wait(marionette_port, Time.instant + Marionette::TIMEOUT)
        process.terminate rescue nil
        process.wait rescue nil
        raise IO::TimeoutError.new("Marionette never opened its port")
      end
      cleared = Marionette.clear_automation(marionette_port).as_h
      library_port = cleared["libraryPort"]?.try(&.as_i?).try(&.to_i32)
      record = Endpoint.read_record(profile_dir) || {} of String => JSON::Any
      record["libraryPort"] = library_port ? JSON::Any.new(library_port.to_i64) : JSON::Any.new(nil)
      Endpoint.write_record(profile_dir, record)
      Registry.record(process.pid.to_i64, port, profile_dir, "firefox",
        a11y.owned? ? a11y.pid : nil, a11y.owned? ? a11y.address : nil)
      Started.new(
        "ws://127.0.0.1:#{port}/session", port, marionette_port, library_port,
        profile_dir, process, owned: true, grouped: grouped, a11y: a11y
      )
    rescue error
      a11y.try(&.close) rescue nil
      process.try(&.terminate) rescue nil
      process.try(&.wait) rescue nil
      File.delete?(Endpoint.record_path(profile_dir))
      raise error
    end

    def self.write_profile_prefs(profile_dir : String, preferences : Hash(String, JSON::Any)) : Nil
      target = File.join(profile_dir, "user.js")
      names = preferences.keys
      kept = begin
        File.read(target).lines(chomp: true).reject do |line|
          line.strip.empty? || names.any? { |name| line.includes?(%("#{name}")) }
        end
      rescue
        [] of String
      end
      written = preferences.map do |name, value|
        %(user_pref("#{name}", #{value.to_json});)
      end
      File.write(target, (kept + written).join('\n') + '\n')
    end

    def self.profile_last_version(profile_dir : String) : String?
      text = File.read(File.join(profile_dir, "compatibility.ini"))
      /^LastVersion=([^\s_\/]+)/m.match(text).try(&.[1]?)
    rescue
      nil
    end

    def self.installed_version(executable : String) : String?
      begin
        app_dir = File.dirname(File.realpath(executable))
        text = File.read(File.join(app_dir, "platform.ini"))
        if found = /^Milestone=(\S+)/m.match(text)
          return found[1]
        end
      rescue
        # Ask the executable when its installation metadata is unavailable.
      end

      output = IO::Memory.new
      status = Process.run(executable, ["--version"],
        input: Process::Redirect::Close, output: output, error: Process::Redirect::Close)
      return nil unless status.success?
      /(\d+(?:\.\d+)+[^\s]*)/.match(output.to_s).try(&.[1]?)
    rescue
      nil
    end

    def self.require_compatible_profile(executable : String, name : String, profile_dir : String) : Nil
      wrote_it_last = profile_last_version(profile_dir)
      return unless wrote_it_last
      installed = installed_version(executable)
      return unless installed
      return unless first_version_is_newer(wrote_it_last, installed)

      raise IO::Error.new(
        "#{name} #{installed} at #{executable} cannot open #{profile_dir}: Firefox #{wrote_it_last} " +
        "used that profile last, and Firefox refuses to open a profile a newer Firefox has " +
        "written. It shows a warning on a screen nobody can see here and waits there, which is " +
        "why the launch times out with no output from the browser. " +
        "Install Firefox #{wrote_it_last} again, or move #{profile_dir} aside and let this session " +
        "make a new profile, or run `#{executable} --allow-downgrade -profile #{profile_dir}` " +
        "once yourself — which lets Firefox #{installed} keep the profile, and can lose what " +
        "Firefox #{wrote_it_last} saved in it."
      )
    end

    private def self.snap_package_name(executable : String?) : String?
      return nil unless executable
      current = executable
      10.times do
        if name = snap_name_of_path(current)
          return name
        end
        target = File.readlink?(current)
        break unless target
        current = Path[target].absolute? ? target : File.expand_path(target, File.dirname(current))
      end

      script = File.read(current)
      return nil unless script.starts_with?("#!")
      names = script.scan(%r{/snap/bin/([A-Za-z0-9][\w.+-]*)|snap\s+run\s+([A-Za-z0-9][\w.+-]*)}).map do |match|
        match[1]? || match[2]?
      end.compact
      name = names.last?
      name if name && File.exists?("/snap/bin/#{name}")
    rescue
      nil
    end

    private def self.xvfb_display_option(executable : String) : String
      output = IO::Memory.new
      status = Process.run(executable, ["--help"],
        input: Process::Redirect::Close, output: output, error: Process::Redirect::Close)
      status.success? && output.to_s.includes?("--auto-display") ? "-d" : "-a"
    rescue
      "-a"
    end

    private def self.snap_name_of_path(target : String) : String?
      if target.starts_with?("/snap/bin/")
        File.basename(target).presence
      elsif target.starts_with?("/snap/")
        target.split('/')[2]?
      end
    end

    private def self.version_parts(text : String) : Array(Int32)?
      found = /^\d+(?:\.\d+)*/.match(text.strip)
      found.try(&.[0].split('.').map(&.to_i))
    end

    private def self.first_version_is_newer(candidate : String, against : String) : Bool
      left = version_parts(candidate)
      right = version_parts(against)
      return false unless left && right
      {left.size, right.size}.max.times do |index|
        mine = left[index]? || 0
        theirs = right[index]? || 0
        return true if mine > theirs
        return false if mine < theirs
      end
      false
    end
  end
end
