require "file_utils"
require "json"
require "./dbus"
require "./detach"
require "./log"

module Tawb
  # Somewhere for the browser to describe its own windows to.
  #
  # Reading a native dialog needs two things (see `atspi.cr`): a browser
  # started with platform accessibility on, and an accessibility bus for the
  # browser to register with. The bus is the awkward one. A graphical desktop
  # already has an accessibility bus, run by at-spi2-core, and every screen
  # reader on the machine uses that one. A terminal with no desktop — which is
  # exactly where this program is most at home, with the browser under Xvfb —
  # has neither an accessibility bus nor the session bus an accessibility bus
  # would live on.
  #
  # So an accessibility bus is provided, and only where one is missing:
  #
  #   * A session bus that already answers for org.a11y.Bus is used as it
  #     stands. That is the desktop case, and nothing is disturbed.
  #   * A session bus with no accessibility bus behind it gets this program's:
  #     the name is claimed only if nobody owns the name, and what the name
  #     hands out is the session bus itself. An accessibility bus is an
  #     ordinary bus; the separate one a desktop runs is for isolation, not for
  #     a different protocol.
  #   * No session bus at all means a session bus is started for the browser. A
  #     started session bus normally ends with the reader, but a browser
  #     deliberately kept alive keeps the browser's bus too; both are recorded
  #     and swept as one browser-lifetime resource.
  #
  # The name is released when the reader ends, so a desktop that later starts a
  # real accessibility bus finds the name free. A kept browser already has the
  # direct bus address in the browser's environment, and later readers use the
  # same recorded address.
  module A11yBus
    A11Y_NAME         = "org.a11y.Bus"
    A11Y_PATH         = "/org/a11y/bus"
    A11Y_INTERFACE    = "org.a11y.Bus"
    STATUS_INTERFACE  = "org.a11y.Status"
    PROPERTIES        = "org.freedesktop.DBus.Properties"

    # RequestName's answer. 1 is "the name is yours now"; anything else means
    # somebody else has the name, which is a reason to leave the name alone
    # rather than an error.
    NAME_PRIMARY_OWNER = 1_u32

    # DBUS_NAME_FLAG_DO_NOT_QUEUE. Queueing behind an accessibility service
    # that appeared between the probe and the request would make this program
    # the owner later, unasked, replacing the desktop's own service.
    DO_NOT_QUEUE = 4_u32

    START_TIMEOUT = 5.seconds

    # Where a session bus already is. The environment names a session bus if a
    # desktop started one; systemd puts a user bus at a known path whether or
    # not anything exported the variable, and the systemd one is what a bare
    # login session has.
    def self.session_bus_address : String?
      named = ENV["DBUS_SESSION_BUS_ADDRESS"]?
      return named if named && !named.empty?
      path = "/run/user/#{LibC.getuid}/bus"
      File.exists?(path) ? "unix:path=#{path}" : nil
    rescue
      nil
    end

    # Whether the desktop's session bus is to be left alone even where it
    # exists. A run that must not start the desktop services a browser asks a
    # session bus for — a portal, dconf, GVfs, a keyring, each a process of its
    # own that outlives the run — asks for a bus of this program's own instead.
    # The private bus has no service directories, so those names are not
    # activatable at all; see `private_bus_config`.
    def self.isolated? : Bool
      value = ENV["TAWB_A11Y_BUS"]?
      value == "private" || value == "isolated"
    end

    # A session bus of this program's own, for a machine that has none. The
    # address is chosen here rather than read from the daemon's stdout so that
    # the daemon can have no pipe back to the reader. Closing that pipe when
    # the launching process exits otherwise takes down a bus that a kept
    # browser still needs.
    #
    # The daemon is given a configuration written here rather than `--session`,
    # and the reason is the one thing that can make a browser unusable on a
    # private bus. The machine's session configuration names the desktop
    # services the machine will activate on demand — portals, dconf, GVfs, a
    # keyring — and D-Bus's StartServiceByName does not return until the
    # service has started or failed. On a terminal with no desktop those
    # launchers cannot come up, so a browser that asks for one waits out the
    # full activation timeout, and the browser's own first network request
    # waits with it. With no <servicedir> the names are simply not activatable,
    # the browser is refused at once, and the browser carries on.
    def self.private_bus_config(socket_path : String) : String
      [
        %(<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"),
        %( "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">),
        "<busconfig>",
        "  <type>session</type>",
        "  <listen>unix:path=#{socket_path}</listen>",
        "  <auth>EXTERNAL</auth>",
        %(  <policy context="default">),
        %(    <allow send_destination="*"/>),
        %(    <allow receive_sender="*"/>),
        %(    <allow own="*"/>),
        "  </policy>",
        "</busconfig>",
        "",
      ].join('\n')
    end

    record StartedBus, address : String, process : Process, socket_path : String

    def self.start_session_bus(log : Log? = nil) : StartedBus
      # Put a random socket path in the daemon's command line. If the daemon's
      # pid is ever reused, the browser registry can prove that a process is
      # this particular companion before signalling the process, rather than
      # accepting any unrelated dbus-daemon with the same pid.
      socket_path = File.join(
        Dir.tempdir, "tawb-a11y-#{Process.pid}-#{Random::Secure.hex(6)}.sock"
      )
      config_path = "#{socket_path}.conf"
      address = "unix:path=#{socket_path}"
      remove_files = -> do
        File.delete?(socket_path)
        File.delete?(config_path)
      end
      spawned = begin
        File.open(config_path, "w", perm: File::Permissions.new(0o600)) do |file|
          file << private_bus_config(socket_path)
        end
        # `--address` repeats what the configuration's <listen> already says,
        # on purpose: the browser registry proves a companion daemon is this
        # program's by finding the socket path in the daemon's command line
        # before signalling the daemon.
        Detach.spawn("dbus-daemon", [
          "--config-file=#{config_path}", "--address=#{address}", "--nofork",
        ])
      rescue error
        remove_files.call
        raise IO::Error.new(
          "no session bus, and dbus-daemon could not be started: #{error.message}"
        )
      end
      process = spawned.process
      # The daemon removes nothing on the way out, so the files are removed
      # here when the daemon goes. A daemon deliberately left for a kept
      # browser outlives this fiber, and the browser registry sweeps the files
      # with the browser.
      spawn do
        process.wait
        remove_files.call
      rescue
      end

      deadline = Time.instant + START_TIMEOUT
      loop do
        if File.exists?(socket_path)
          log.try(&.write("a11y.bus.started", {"address" => JSON::Any.new(address)}))
          return StartedBus.new(address, process, socket_path)
        end
        unless process.exists?
          remove_files.call
          raise IO::Error.new("dbus-daemon exited before opening its private socket")
        end
        if Time.instant >= deadline
          process.terminate rescue nil
          remove_files.call
          raise IO::TimeoutError.new("dbus-daemon did not open its private socket")
        end
        sleep 10.milliseconds
      end
    end

    # Answer for org.a11y.Bus on a connection this program holds, handing out
    # the bus this program is already on. Two members are asked in practice:
    # GetAddress, by every application looking for the accessibility bus, and
    # the Status properties, which is how Chromium decides whether
    # accessibility is wanted here at all.
    def self.serve_accessibility_bus(connection : Dbus::Connection, address : String) : Nil
      connection.on_method_call do |message, answer|
        next false unless message.path == A11Y_PATH
        if message.iface == A11Y_INTERFACE && message.member == "GetAddress"
          answer.reply("s", [address.as(Dbus::Argument)])
          next true
        end
        if message.iface == PROPERTIES && message.member == "Get"
          wanted = message.body[0]?
          property = message.body[1]?
          next false unless wanted == STATUS_INTERFACE
          if property == "IsEnabled"
            answer.reply("v", [Dbus::Variant.new("b", true).as(Dbus::Argument)])
            next true
          end
          if property == "ScreenReaderEnabled"
            # True is the honest answer. Something is about to read this
            # browser's windows aloud to a person who cannot see them, and that
            # is what the property is asking.
            answer.reply("v", [Dbus::Variant.new("b", true).as(Dbus::Argument)])
            next true
          end
          answer.fail("org.freedesktop.DBus.Error.UnknownProperty", "no #{property} here")
          next true
        end
        if message.iface == PROPERTIES && message.member == "Set"
          answer.reply
          next true
        end
        false
      end
    end

    # An accessibility bus, however one has to be come by.
    #
    # What comes back names the bus to read trees on, the environment a browser
    # must be started with to find the bus, and how to put back whatever was
    # set up. `available? == false` is an ordinary answer rather than a
    # failure: a machine without D-Bus is one where native dialogs cannot be
    # read, and everything else about the browser still works.
    class Opened
      getter address : String?
      getter env : Hash(String, String)
      getter reason : String?
      getter pid : Int64?

      def initialize(@address : String? = nil,
                     @env : Hash(String, String) = {} of String => String,
                     @reason : String? = nil,
                     @owned : Bool = false,
                     @session : Dbus::Connection? = nil,
                     @daemon : Process? = nil,
                     @daemon_socket : String? = nil)
        @pid = @daemon.try(&.pid.to_i64)
        @released = false
      end

      def available? : Bool
        !@address.nil?
      end

      # Whether the bus behind this answer is one this program started, which
      # is the only case in which there is anything to hand to a kept browser.
      def owned? : Bool
        @owned
      end

      def close : Nil
        return if @released
        @released = true
        @session.try(&.close)
        stop_daemon
      end

      # A kept browser still has DBUS_SESSION_BUS_ADDRESS and
      # AT_SPI_BUS_ADDRESS pointing here. Release the service connection owned
      # by this reader, but leave the daemon alive for the browser. The browser
      # registry owns the daemon from this point and removes the daemon with
      # the browser.
      def leave_running : Nil
        return if @released
        @released = true
        @session.try(&.close)
      end

      private def stop_daemon : Nil
        daemon = @daemon
        return unless daemon
        begin
          daemon.terminate
        rescue
          # Already gone.
        end
        if socket = @daemon_socket
          File.delete?(socket)
        end
      end
    end

    # A private accessibility bus is a browser-lifetime resource. The reader
    # that launched a kept browser leaves the daemon running and records the
    # daemon's address; a later reader rejoining that browser connects to the
    # recorded address directly. The later reader does not own the daemon and
    # must not stop the daemon on the way out, which is what `owned?` being
    # false here says.
    def self.recorded(record : Hash(String, JSON::Any)?) : Opened?
      address = record.try(&.["a11yAddress"]?).try(&.as_s?)
      return nil if address.nil? || address.empty?
      Opened.new(address: address)
    end

    def self.open(log : Log? = nil) : Opened
      session_address = isolated? ? nil : session_bus_address
      daemon = nil.as(Process?)
      daemon_socket = nil.as(String?)
      env = {} of String => String

      start_own_bus = -> do
        started = start_session_bus(log)
        session_address = started.address
        daemon = started.process
        daemon_socket = started.socket_path
        # Override an exported address too. A stale DBUS_SESSION_BUS_ADDRESS is
        # indistinguishable from a desktop bus until connecting to the address
        # fails, and passing that stale value through would leave Firefox
        # describing no permission prompts at all.
        env["DBUS_SESSION_BUS_ADDRESS"] = started.address
        # AT-SPI clients can use the accessibility bus directly. Setting the
        # address also avoids relying on a toolkit to discover this program's
        # service through a session bus that exists only for this browser.
        env["AT_SPI_BUS_ADDRESS"] = started.address
        # Firefox's GTK accessibility bridge does not start merely because an
        # isolated bus answers ScreenReaderEnabled. GNOME_ACCESSIBILITY is the
        # standard GTK startup signal; without GNOME_ACCESSIBILITY Firefox
        # never registers an AT-SPI tree and microphone permission doorhangers
        # remain invisible to the reader.
        env["GNOME_ACCESSIBILITY"] = "1"
      end

      if session_address.nil?
        begin
          start_own_bus.call
        rescue error
          return Opened.new(reason: error.message || error.class.name)
        end
      end

      session = begin
        Dbus.connect(session_address.not_nil!)
      rescue error
        # Login shells can retain DBUS_SESSION_BUS_ADDRESS after their desktop
        # session has ended. An address that cannot be reached is treated the
        # same as no address, and the browser is given a private bus instead.
        if existing = daemon
          begin
            existing.terminate
          rescue
          end
          if socket = daemon_socket
            File.delete?(socket)
          end
          return Opened.new(reason: error.message || error.class.name)
        end
        log.try(&.write("a11y.bus.unreachable", {
          "address" => JSON::Any.new(session_address),
          "error"   => JSON::Any.new((error.message || "")[0, 160]),
        }))
        begin
          start_own_bus.call
          Dbus.connect(session_address.not_nil!)
        rescue fallback_error
          if existing = daemon
            begin
              existing.terminate
            rescue
            end
            if socket = daemon_socket
              File.delete?(socket)
            end
          end
          return Opened.new(reason: fallback_error.message || fallback_error.class.name)
        end
      end

      # Somebody else's accessibility bus, which is the desktop case: use the
      # desktop's bus and hold nothing of this program's own. A private bus is
      # deliberately not asked first: a private bus's standard service
      # directories may contain an AT-SPI launcher inherited from the machine,
      # and activating that launcher can hand back the dead desktop socket that
      # made this program start a private bus in the first place.
      if daemon.nil?
        begin
          found = session.call(
            destination: A11Y_NAME, path: A11Y_PATH, iface: A11Y_INTERFACE, member: "GetAddress",
          )[0]?.as?(String)
          if found
            session.close
            log.try(&.write("a11y.bus.found", {"address" => JSON::Any.new(found)}))
            return Opened.new(address: found, env: env)
          end
        rescue
          # Nobody is answering for the accessibility bus, so this program will.
        end
      end

      owned = begin
        session.request_name(A11Y_NAME, DO_NOT_QUEUE)
      rescue error
        session.close
        if existing = daemon
          begin
            existing.terminate
          rescue
          end
          if socket = daemon_socket
            File.delete?(socket)
          end
        end
        return Opened.new(reason: error.message || error.class.name)
      end
      unless owned == NAME_PRIMARY_OWNER
        # The name has an owner that did not answer. Whatever that owner is
        # doing, the name is not this program's to take over.
        session.close
        if existing = daemon
          begin
            existing.terminate
          rescue
          end
          if socket = daemon_socket
            File.delete?(socket)
          end
        end
        return Opened.new(reason: "an accessibility bus is registered but not answering")
      end

      address = session_address.not_nil!
      serve_accessibility_bus(session, address)
      log.try(&.write("a11y.bus.served", {
        "address"    => JSON::Any.new(address),
        "ownSession" => JSON::Any.new(!daemon.nil?),
      }))
      Opened.new(
        address: address,
        env: env,
        owned: !daemon.nil?,
        session: session,
        daemon: daemon,
        daemon_socket: daemon_socket,
      )
    end
  end
end
