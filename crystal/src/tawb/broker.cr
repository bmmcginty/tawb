require "json"
require "mutex"
require "socket"
require "./detach"
require "./endpoint"
require "./transport"

module Tawb
  module Broker

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    # One Firefox, more than one reader.
    #
    # Chromium's protocol takes as many clients as ask; every session opens
    # its own connection to one browser and they coexist. Firefox serves
    # exactly one WebDriver session per browser instance and publishes no way
    # to join the one it has. But BiDi is JSON-RPC over one socket — a command
    # carries an id, its reply carries the same id back, an event carries
    # none — and that is multiplexable. This holds the one real session and
    # serves as many local readers as ask for one, rewriting ids so replies
    # find their way home. A reader runs the ordinary Firefox driver, pointed
    # here rather than at Firefox, and nothing above the driver knows the
    # difference.
    #
    # As little of what it carries is read as possible: the id comes out of
    # the head of a frame, so a reply carrying an entire accessibility tree is
    # forwarded rather than parsed.
    #
    # A password challenge goes to whoever was doing something most recently,
    # or is cancelled when nobody is listening for it: a challenge raised
    # anywhere in the browser belongs to the session rather than to a
    # connection, and a request paused for ever is the one outcome that must
    # not happen, because the browser's own dialog is gone the moment the
    # interception is armed.
    AUTH_EVENT = "network.authRequired"

    # A local command, consumed by the broker and never sent to Firefox. A
    # reader that deliberately leaves the browser running also leaves its one
    # allowed BiDi session here, so the next reader can rejoin instead of
    # cold-starting.
    RETAIN_SESSION = "tawb.retainSession"

    # How long the browser is held after the last reader leaves. Long enough
    # to cover a reader restarting, short enough that a forgotten browser is
    # not being held open by a process nobody can see.
    IDLE_EXIT_MS = 5000_i64

    # And if the reader that started us never arrives at all.
    STARTUP_GRACE_MS = 30000_i64

    # The broker is recorded beside the browser it serves, because that is
    # what it belongs to: one per browser, found by any reader that joins
    # that browser.
    BROKER_FILE = "tawb-broker.json"

    # A compiled executable has no broker.js beside it, so it restarts itself
    # in a private dispatch mode named by this argument.
    INTERNAL_BROKER_ARG = "--tawb-internal-firefox-broker"

    def self.record_path(profile_dir : String) : String
      File.join(profile_dir, BROKER_FILE)
    end

    def self.read_record(profile_dir : String) : Hash(String, JSON::Any)?
      JSON.parse(File.read(record_path(profile_dir))).as_h
    rescue
      nil
    end

    def self.clear_record(profile_dir : String) : Nil
      File.delete?(record_path(profile_dir))
    rescue
      # already gone
    end

    def self.write_record(profile_dir : String, record : Hash(String, JSON::Any)) : Nil
      File.write(record_path(profile_dir), record.to_json)
    rescue
      # a lost record costs a second broker, not a crash
    end

    # Written with an exclusive create, so that two readers starting at the
    # same moment cannot both decide they are the one to start the browser's
    # broker.
    def self.claim(profile_dir : String, record : Hash(String, JSON::Any)) : Bool
      Dir.mkdir_p(profile_dir)
      target = record_path(profile_dir)
      staging = "#{target}.#{Process.pid}.#{Random::Secure.hex(4)}"
      File.write(staging, record.to_json)
      begin
        File.link(staging, target)
      ensure
        File.delete?(staging)
      end
      true
    rescue File::Error
      false
    end

    def self.url(port : Int32) : String
      "ws://127.0.0.1:#{port}/session"
    end

    def self.executable : String
      Process.executable_path || File.realpath("/proc/self/exe")
    end

    def self.process_alive?(pid : Int64) : Bool
      return false unless pid.in?(1..Int32::MAX)
      Process.exists?(pid.to_i32)
    rescue
      false
    end

    # The broker for this browser: the one already running, or one started
    # here.
    def self.ensure(profile_dir : String, endpoint : String) : NamedTuple(port: Int32, pid: Int64, url: String)
      40.times do
        record = read_record(profile_dir)
        pid = record.try(&.["pid"]?.try(&.as_i64?)) || 0_i64
        port = record.try(&.["port"]?.try(&.as_i?).try(&.to_i32))
        if record && record["upstream"]?.try(&.as_s?) == endpoint && process_alive?(pid)
          # It may still be opening its port; it was recorded before it
          # answered.
          if port && Endpoint.wait(port, Time.instant + 10.seconds)
            return {port: port, pid: pid, url: url(port)}
          end
        end
        unless record && process_alive?(pid) && port && Endpoint.ready?(port)
          clear_record(profile_dir)
        end

        fresh = Endpoint.free_port
        if claim(profile_dir, {
             "pid"      => JSON::Any.new(Process.pid.to_i64),
             "port"     => JSON::Any.new(fresh.to_i64),
             "upstream" => JSON::Any.new(endpoint),
             "at"       => JSON::Any.new(Time.utc.to_unix_ms),
           })
          # Detached into a session of its own: a terminal's Ctrl+C, and the
          # terminal closing, end the reader rather than the broker holding
          # the browser's session. See Detach.
          child = Detach.spawn(executable,
            [INTERNAL_BROKER_ARG, endpoint, fresh.to_s, profile_dir]).process
          if Endpoint.wait(fresh, Time.instant + 15.seconds)
            write_record(profile_dir, {
              "pid"      => JSON::Any.new(child.pid.to_i64),
              "port"     => JSON::Any.new(fresh.to_i64),
              "upstream" => JSON::Any.new(endpoint),
              "at"       => JSON::Any.new(Time.utc.to_unix_ms),
            })
            return {port: fresh, pid: child.pid.to_i64, url: url(fresh)}
          end
          clear_record(profile_dir)
          raise IO::TimeoutError.new("the broker did not open its port")
        end
        sleep 150.milliseconds # somebody else is starting it; wait and join theirs
      end
      raise IO::Error.new("could not reach a broker for this browser")
    end

    # As a program: hold the browser's one session and serve readers until
    # there is no reason left to keep it.
    def self.run_process(args : Array(String)) : Nil
      upstream = args[0]?
      port_text = args[1]?
      profile_dir = args[2]?
      unless upstream && port_text && profile_dir
        raise ArgumentError.new("the broker process needs an upstream, a port and a profile directory")
      end
      port = port_text.to_i?
      unless port && port.in?(0..65_535)
        raise ArgumentError.new("unreadable broker port #{port_text}")
      end
      Runner.new(upstream, port.to_i32, profile_dir).run
    end

    private class Runner
      @server : Server?

      def initialize(@upstream : String, @port : Int32, @profile_dir : String)
      end

      def run : Nil
        server = Server.new(@upstream, @port, on_idle: ->(reason : String) { departing(reason); nil })
        @server = server
        server.start
        STDOUT << %({"ready": true, "port": #{server.port}}) << '\n' unless STDOUT.tty?
        {Signal::INT, Signal::TERM, Signal::HUP}.each do |signal|
          signal.trap do
            spawn do
              signalled
              exit 0
            end
          end
        end
        sleep
      end

      # A signal means going now: the session is ended on the way out so the
      # next broker is not met by one Firefox still holds. A record left
      # behind names a broker nobody is serving, which is exactly what a
      # crashed broker leaves, and the next reader treats them the same.
      private def signalled : Nil
        @server.try(&.close)
      end

      private def departing(reason : String) : Nil
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] departing: #{reason}" }
        # The record goes first. A reader that arrives from here on starts a
        # broker of its own rather than joining one that is leaving — and the
        # gap between deciding to go and having gone is exactly when a reader
        # would otherwise connect to a socket about to close under it.
        if record = Broker.read_record(@profile_dir)
          Broker.clear_record(@profile_dir) if record["port"]?.try(&.as_i64?) == @port.to_i64
        end
        if reason == "idle"
          # The reprieve is for having no readers, which a reader arriving
          # undoes. It is not for having no browser: a broker whose browser
          # has gone can serve nobody, and staying to be found again would
          # hand the next reader a broker that answers nothing — their
          # session.new would wait out its whole timeout against a socket
          # that is never coming back.
          sleep 250.milliseconds
          if (@server.try(&.client_count) || 0) > 0
            # Somebody came in through that gap. Stay, and be findable again.
            Broker.write_record(@profile_dir, {
              "pid"      => JSON::Any.new(Process.pid.to_i64),
              "port"     => JSON::Any.new(@port.to_i64),
              "upstream" => JSON::Any.new(@upstream),
              "at"       => JSON::Any.new(Time.utc.to_unix_ms),
            })
            return
          end
        end
        @server.try(&.close)
        exit 0
      end
    end

    # The WebSocket handshake needs SHA-1, and the static artifact must not
    # grow a libcrypto dependency for it.
    module Sha1
      def self.digest(data : Bytes) : Bytes
        words = [0x67452301_u32, 0xefcdab89_u32, 0x98badcfe_u32, 0x10325476_u32, 0xc3d2e1f0_u32]
        bits = data.size.to_u64 * 8
        size = ((data.size + 9 + 63) // 64) * 64
        message = Bytes.new(size)
        data.copy_to(message)
        message[data.size] = 0x80_u8
        8.times do |index|
          message[size - 1 - index] = ((bits >> (8 * index)) & 0xff).to_u8
        end

        block = Array.new(80, 0_u32)
        (0...size).step(64) do |offset|
          16.times do |index|
            at = offset + index * 4
            block[index] = message[at].to_u32 << 24 | message[at + 1].to_u32 << 16 |
                           message[at + 2].to_u32 << 8 | message[at + 3].to_u32
          end
          (16...80).each do |index|
            block[index] = (block[index - 3] ^ block[index - 8] ^ block[index - 14] ^ block[index - 16])
              .rotate_left(1)
          end
          a, b, c, d, e = words
          80.times do |index|
            f, k = if index < 20
                     {(b & c) | (~b & d), 0x5a827999_u32}
                   elsif index < 40
                     {b ^ c ^ d, 0x6ed9eba1_u32}
                   elsif index < 60
                     {(b & c) | (b & d) | (c & d), 0x8f1bbcdc_u32}
                   else
                     {b ^ c ^ d, 0xca62c1d6_u32}
                   end
            temp = a.rotate_left(5) &+ f &+ e &+ k &+ block[index]
            e = d
            d = c
            c = b.rotate_left(30)
            b = a
            a = temp
          end
          words = [words[0] &+ a, words[1] &+ b, words[2] &+ c, words[3] &+ d, words[4] &+ e]
        end

        digest = Bytes.new(20)
        words.each_with_index do |word, index|
          4.times do |byte|
            digest[index * 4 + byte] = ((word >> (24 - 8 * byte)) & 0xff).to_u8
          end
        end
        digest
      end
    end

    def self.handshake_accept(key : String) : String
      Base64.strict_encode(Sha1.digest("#{key}#{GUID}".to_slice))
    end

    # A framed connection to one reader. Text frames in, text frames out; a
    # ping answered, a close obeyed, and continuation frames joined, because a
    # message here is routinely larger than anything one frame carries.
    class Peer
      @write = Mutex.new

      def initialize(@socket : TCPSocket, @on_text : Proc(String, Nil), @on_close : Proc(Nil))
      end

      def listen : Nil
        spawn do
          begin
            fragments = [] of Bytes
            loop do
              first = read_byte
              second = read_byte
              final = first.bit(7) == 1
              opcode = first & 0x0f
              # The 7-bit length field names the extended forms at 126 and
              # 127; a frame whose true length is exactly 127 arrives in the
              # 16-bit form and its length must not be taken for the
              # indicator again, or the mask is read as a 64-bit length.
              case second & 0x7f
              when 126 then length = read_u16.to_u64
              when 127 then length = read_u64
              else          length = (second & 0x7f).to_u64
              end
              raise IO::Error.new("frame exceeds the broker's 64MiB limit") if length > 67_108_864
              mask = second.bit(7) == 1 ? read_exact(4) : nil
              payload = read_exact(length.to_i32)
              payload.each_index { |index| payload[index] ^= mask[index % 4] } if mask
              case opcode
              when 0x8
                raise IO::EOFError.new("peer closed the connection")
              when 0x9
                write_frame(0x0a_u8, payload)
              when 0x0, 0x1
                fragments << payload
                if final
                  joined = IO::Memory.new
                  fragments.each { |part| joined.write(part) }
                  fragments = [] of Bytes
                  @on_text.call(String.new(joined.to_slice))
                end
              end
            end
          rescue e
            File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] peer died: #{e.class} #{e.message}" }
          ensure
            @socket.close rescue nil
            @on_close.call
          end
        end
      end

      def send(text : String) : Nil
        write_frame(0x01_u8, text.to_slice)
      end

      def close_socket : Nil
        @socket.close
      rescue
      end

      private def write_frame(opcode : UInt8, payload : Bytes) : Nil
        head = IO::Memory.new
        head.write_byte(0x80_u8 | opcode)
        if payload.size < 126
          head.write_byte(payload.size.to_u8)
        elsif payload.size < 65_536
          head.write_byte(126_u8)
          head.write_bytes(payload.size.to_u16, IO::ByteFormat::NetworkEndian)
        else
          head.write_byte(127_u8)
          head.write_bytes(payload.size.to_u64, IO::ByteFormat::NetworkEndian)
        end
        @write.synchronize do
          @socket.write(head.to_slice)
          @socket.write(payload) unless payload.empty?
          @socket.flush
        end
      rescue
        # A peer that left while the broker was writing is gone; the read loop
        # notices on its own.
      end

      private def read_byte : UInt8
        @socket.read_byte || raise IO::EOFError.new
      end

      private def read_u16 : UInt16
        IO::ByteFormat::NetworkEndian.decode(UInt16, read_exact(2))
      end

      private def read_u64 : UInt64
        IO::ByteFormat::NetworkEndian.decode(UInt64, read_exact(8))
      end

      private def read_exact(size : Int32) : Bytes
        bytes = Bytes.new(size)
        @socket.read_fully(bytes)
        bytes
      end
    end

    private class Client
      getter peer : Peer
      getter subscribed = Set(String).new
      property active_at : Time::Instant

      def initialize(@peer)
        @active_at = Time.instant
      end
    end

    private class Route
      getter client : Client
      getter client_id : JSON::Any?
      getter command : String?

      def initialize(@client, @client_id, @command)
      end
    end

    class Server
      @mutex = Mutex.new
      @clients = [] of Client
      @routes = {} of Int64 => Route
      @upstream : Transport::WebSocket?
      @upstream_attempted = false
      @upstream_failed = false
      @session_result : JSON::Any?
      @retained = false
      @ever_had_client = false
      @closed = false
      @idle_generation = 0
      @next_upstream_id = 1_000_000_i64
      @upstream_write = Mutex.new
      @server : TCPServer?

      getter port : Int32
      getter upstream_url : String

      def initialize(@upstream_url : String, @port : Int32 = 0,
                     @idle_ms : Int64 = IDLE_EXIT_MS, @grace_ms : Int64 = STARTUP_GRACE_MS,
                     @on_idle : Proc(String, Nil)? = nil)
      end

      def start : Nil
        server = TCPServer.new("127.0.0.1", @port)
        @server = server
        @port = server.local_address.port
        spawn { accept_loop(server) }
        return unless @on_idle
        spawn do
          sleep @grace_ms.milliseconds
          fire = @mutex.synchronize { !@ever_had_client && @clients.empty? && !@closed }
          @on_idle.try(&.call("idle")) if fire
        end
      end

      def client_count : Int32
        @mutex.synchronize { @clients.size }
      end

      # Ends the shared session on the way out, so the next broker is not met
      # by a session Firefox is still holding for a client that has gone.
      def close(end_session = true) : Nil
        @mutex.synchronize do
          return if @closed
          @closed = true
          @idle_generation += 1
        end
        if end_session && (socket = @mutex.synchronize { @upstream })
          id = @mutex.synchronize { @next_upstream_id += 1 }
          begin
            @upstream_write.synchronize do
              socket.send(JSON::Any.new({
                "id"     => JSON::Any.new(id),
                "method" => JSON::Any.new("session.end"),
                "params" => JSON::Any.new({} of String => JSON::Any),
              }).to_json)
            end
          rescue
            # the browser is already gone
          end
          sleep 100.milliseconds
        end
        peers = @mutex.synchronize { @clients.map(&.peer) }
        peers.each(&.close_socket)
        (@mutex.synchronize { @upstream }).try(&.close)
        @server.try(&.close)
      end

      private def accept_loop(server : TCPServer) : Nil
        loop do
          socket = begin
            server.accept
          rescue
            return if @mutex.synchronize { @closed }
            sleep 10.milliseconds
            next
          end
          spawn { handle_connection(socket) }
        end
      end

      private def handle_connection(socket : TCPSocket) : Nil
        client = accept_client(socket)
        return unless client
        register(client)
        client.peer.listen
      rescue
        socket.close rescue nil
      end

      private def accept_client(socket : TCPSocket) : Client?
        request = IO::Memory.new
        loop do
          byte = socket.read_byte || raise IO::EOFError.new("closed during the WebSocket handshake")
          request.write_byte(byte)
          data = request.to_slice
          break if data.size >= 4 && data[data.size - 4] == 13 && data[data.size - 3] == 10 &&
                   data[data.size - 2] == 13 && data[data.size - 1] == 10
          raise IO::Error.new("oversized WebSocket handshake") if data.size > 65_536
        end
        lines = String.new(request.to_slice).split("\r\n")
        headers = {} of String => String
        lines[1..].each do |line|
          colon = line.index(':')
          headers[line[0, colon].strip.downcase] = line[colon + 1..].strip if colon
        end
        unless lines.first?.try(&.upcase.starts_with?("GET")) && headers["sec-websocket-key"]?
          socket << "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"
          socket.flush
          socket.close
          return nil
        end
        socket << "HTTP/1.1 101 Switching Protocols\r\n"
        socket << "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        socket << "Sec-WebSocket-Accept: #{Broker.handshake_accept(headers["sec-websocket-key"])}\r\n\r\n"
        socket.flush
        socket.tcp_nodelay = true

        client = nil
        client = Client.new(Peer.new(socket,
          ->(text : String) { from_client(client.not_nil!, text) },
          -> { client_left(client.not_nil!) }))
        client
      end

      private def register(client : Client) : Nil
        @mutex.synchronize do
          @ever_had_client = true
          @idle_generation += 1
          @clients << client
        end
      end

      private def client_left(client : Client) : Nil
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] client_left" }
        was = @mutex.synchronize do
          present = @clients.includes?(client)
          @clients.delete(client)
          @routes.keys.each do |key|
            @routes.delete(key) if @routes[key].client == client
          end
          present
        end
        arm_idle if was
      end

      private def arm_idle : Nil
        generation = @mutex.synchronize do
          return unless !@retained && @clients.empty? && !@closed
          @idle_generation += 1
        end
        spawn do
          sleep @idle_ms.milliseconds
          fire = @mutex.synchronize do
            @idle_generation == generation && @clients.empty? && !@closed
          end
          @on_idle.try(&.call("idle")) if fire
        end
      end

      private def from_client(client : Client, text : String) : Nil
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] #{text[0, 100]}" }
        @mutex.synchronize { client.active_at = Time.instant }
        message = begin
          JSON.parse(text).as_h?
        rescue JSON::ParseException
          nil
        end
        return unless message
        id = message["id"]?
        method = message["method"]?.try(&.as_s?)

        case method
        when "session.status"
          # Answered here rather than upstream: every reader may have a
          # session, so every reader is told the browser is ready to give it
          # one.
          reply_success(client, id, JSON::Any.new({
            "ready"   => JSON::Any.new(true),
            "message" => JSON::Any.new(""),
          }))
          return
        when "session.new"
          if cached = @mutex.synchronize { @session_result }
            reply_success(client, id, tag_session(cached, "replayed"))
            return
          end
        when RETAIN_SESSION
          @mutex.synchronize { @retained = true }
          reply_success(client, id, JSON::Any.new({} of String => JSON::Any))
          return
        when "session.end"
          # One reader leaving is not the browser closing: session.end from
          # any connection deletes the session for everybody sharing it.
          shared = @mutex.synchronize do
            if @clients.size > 1
              true
            else
              @retained = false
              @session_result = nil
              false
            end
          end
          if shared
            reply_success(client, id, JSON::Any.new({} of String => JSON::Any))
            return
          end
        when "session.subscribe"
          events = message["params"]?.try(&.as_h?).try(&.["events"]?).try(&.as_a?) ||
                   [] of JSON::Any
          @mutex.synchronize do
            events.each do |event|
              client.subscribed << event.as_s if event.as_s?
            end
          end
        end

        forward(client, id, method, text)
      end

      private def forward(client : Client, id : JSON::Any?, method : String?, text : String) : Nil
        ours = @mutex.synchronize do
          claimed = @next_upstream_id
          @next_upstream_id += 1
          @routes[claimed] = Route.new(client, id, method)
          claimed
        end
        begin
          socket = connect_upstream
          @upstream_write.synchronize do
            socket.send(text.sub(/"id"\s*:\s*\d+/, "\"id\":#{ours}"))
          end
        rescue
          @mutex.synchronize { @routes.delete(ours) }
          reply_error(client, id, "the browser is not there")
        end
      end

      private def connect_upstream : Transport::WebSocket
        @mutex.synchronize do
          unless @upstream_attempted
            @upstream_attempted = true
            spawn { establish_upstream }
          end
        end
        deadline = Time.instant + 15.seconds
        loop do
          if socket = @mutex.synchronize { @upstream }
            return socket
          end
          if @mutex.synchronize { @upstream_failed }
            raise IO::Error.new("no browser at #{@upstream_url}")
          end
          raise IO::TimeoutError.new("the browser did not answer") if Time.instant >= deadline
          sleep 5.milliseconds
        end
      end

      private def establish_upstream : Nil
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] establish_upstream" }
        connected = begin
          Transport::WebSocket.new(@upstream_url, read_timeout: nil)
        rescue
          @mutex.synchronize { @upstream_failed = true }
          nil
        end
        return unless connected
        socket = connected.not_nil!
        @mutex.synchronize { @upstream = socket }
        loop do
          from_upstream(socket.receive)
        end
      rescue e
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] upstream loop died: #{e.class} #{e.message}" }
        browser_gone
      end

      private def browser_gone : Nil
        File.open("/tmp/brokerdbg.log", "a") { |__f| __f.puts "[dbg] browser_gone" }
        closed, peers = @mutex.synchronize do
          @upstream = nil
          @upstream_failed = true
          {@closed, @clients.map(&.peer)}
        end
        peers.each(&.close_socket)
        # The distinction matters because the broker is given a reprieve when
        # it is only idle: a reader arriving in that moment cancels the
        # departure. A broker with no browser must not take that reprieve —
        # staying to be found again hands the next reader a session.new that
        # waits out its whole timeout against a socket that is never coming
        # back.
        @on_idle.try(&.call("browser-gone")) unless closed
      end

      private def from_upstream(text : String) : Nil
        head = text.size > 200 ? text[0, 200] : text
        id = /"id"\s*:\s*(\d+)/.match(head).try(&.[1]?.try(&.to_i64))
        if id
          route = @mutex.synchronize { @routes.delete(id) }
          return unless route
          if route.command == "session.new"
            parsed = begin
              JSON.parse(text).as_h?
            rescue JSON::ParseException
              nil
            end
            if parsed && (result = parsed["result"]?)
              # Tell diagnostics whether this reader caused Firefox to create
              # the shared session or received the broker's existing answer.
              # This is a private extension capability on the local hop only;
              # Firefox never sees it.
              @mutex.synchronize { @session_result = JSON.parse(result.to_json) }
              parsed["result"] = tag_session(result, "created")
              parsed["id"] = route.client_id || JSON::Any.new(nil)
              route.client.peer.send(parsed.to_json)
              return
            end
          end
          route.client.peer.send(
            text.sub(/"id"\s*:\s*\d+/, "\"id\":#{route.client_id.to_json}")
          )
          return
        end

        method = /"method"\s*:\s*"([^"]+)"/.match(head).try(&.[1]?)
        if method == AUTH_EVENT
          asking = most_recently_active(AUTH_EVENT)
          if asking
            asking.peer.send(text)
          else
            cancel_challenge(text)
          end
          return
        end

        recipients = @mutex.synchronize do
          if method
            module_name = method.partition('.')[0]
            @clients.select do |client|
              client.subscribed.includes?(method) || client.subscribed.includes?(module_name)
            end
          else
            @clients.dup
          end
        end
        recipients.each(&.peer.send(text))
      rescue
        # A message the broker cannot route must not take the browser
        # connection down with it.
      end

      private def most_recently_active(event : String) : Client?
        module_name = event.partition('.')[0]
        @mutex.synchronize do
          best = nil
          @clients.each do |client|
            next unless client.subscribed.includes?(event) ||
                        client.subscribed.includes?(module_name)
            best = client if best.nil? || client.active_at > best.not_nil!.active_at
          end
          best
        end
      end

      private def cancel_challenge(text : String) : Nil
        request = /"request"\s*:\s*"([^"]+)"/.match(text).try(&.[1]?)
        return unless request
        socket = @mutex.synchronize { @upstream }
        return unless socket
        id = @mutex.synchronize { @next_upstream_id += 1 }
        @upstream_write.synchronize do
          socket.not_nil!.send(JSON::Any.new({
            "id"     => JSON::Any.new(id),
            "method" => JSON::Any.new("network.continueWithAuth"),
            "params" => JSON::Any.new({
              "request" => JSON::Any.new(request),
              "action"  => JSON::Any.new("cancel"),
            }),
          }).to_json)
        end
      end

      private def reply_success(client : Client, id : JSON::Any?, result : JSON::Any) : Nil
        client.peer.send(JSON::Any.new({
          "type"   => JSON::Any.new("success"),
          "id"     => id || JSON::Any.new(nil),
          "result" => result,
        }).to_json)
      end

      private def reply_error(client : Client, id : JSON::Any?, message : String) : Nil
        client.peer.send(JSON::Any.new({
          "type"    => JSON::Any.new("error"),
          "id"      => id || JSON::Any.new(nil),
          "error"   => JSON::Any.new("unknown error"),
          "message" => JSON::Any.new(message),
        }).to_json)
      end

      private def tag_session(result : JSON::Any, tag : String) : JSON::Any
        object = result.as_h? || {} of String => JSON::Any
        capabilities = object["capabilities"]?.try(&.as_h?) || {} of String => JSON::Any
        capabilities["tawb:brokerSession"] = JSON::Any.new(tag)
        object["capabilities"] = JSON::Any.new(capabilities)
        JSON::Any.new(object)
      end
    end
  end
end
