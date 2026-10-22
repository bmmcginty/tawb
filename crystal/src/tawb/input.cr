# The native port of src/input.js. A terminal is a byte stream, not a
# keyboard event stream. One `data` chunk may hold several keys, and one
# escape sequence may be split across chunks. This reader turns that stream
# back into complete keystrokes. Escape alone needs a short wait because it
# is also the prefix of every special key.

module Tawb
  module Input
    # The keyboard is gone and is not coming back.
    #
    # Every way a terminal dies that arrives as a signal is handled where the
    # program shuts down. This is the one that does not: stdin ending under a
    # process that goes on running — a pty closed without a hangup, input from
    # a pipe that reached its end, a stream destroyed under us. A waiter that
    # can never be answered is worse than one answered with nothing, because a
    # password prompt is holding a request the browser has paused, and neither
    # the prompt nor the page can move again. So the end of the stream is
    # delivered as a keystroke of its own, and whoever is waiting decides what
    # it means: a prompt declines, and the reading loop leaves.
    #
    # JavaScript marks this with a Symbol so no real key can collide with it;
    # the Crystal reader carries it as its own class for the same reason.
    class Eof
      def to_s(io : IO) : Nil
        io << "eof"
      end
    end

    EOF = Eof.new

    # Escape-string introducers. OSC ends with BEL or ST; the others end with
    # ST. They are kept whole because their payload is terminal data, not keys.
    STRING_INTRODUCERS = Set(Char).new([']', 'P', 'X', '^', '_'])

    alias Key = String | Eof

    # Who the keystrokes belong to. Normally nobody, and the reading loop
    # takes them. See #claim.
    class Token; end

    # One side of a race next_or lost or won: either the operation finished
    # first and this carries what it finished with, or a key arrived first.
    class OperationResult(T)
      getter value : T

      def initialize(@value : T); end
    end

    class KeyResult
      getter key : Key

      def initialize(@key : Key); end
    end

    # A chunk of decoded text, or the news that the stream is over. Anything
    # that ends the stream — a quiet finish, a destroyed stream, an error —
    # arrives here as StreamEnd, because all three mean the same thing to a
    # reader waiting for a key.
    class Chunk
      getter text : String

      def initialize(@text); end
    end

    class StreamEnd; end

    # One waiter for one key. JavaScript kept an array of {owner, resolve}
    # objects and settled their promises; here each waiter carries a one-slot
    # channel that the answer is sent down, and a flag saying whether anything
    # was sent, so a losing side of next_or can tell a delivered key from an
    # abandoned wait without peeking into the channel.
    private class Waiter
      getter channel = Channel(Key).new(1)
      getter owner : Token?
      property delivered = false

      def initialize(@owner); end
    end

    class KeyReader
      @input : IO::FileDescriptor
      @escape_ms : Int32
      @events : Channel(Chunk | StreamEnd)
      @buffer = ""
      @keys = [] of String
      @waiters = [] of Waiter
      @owner : Token? = nil
      @ended = false
      @mutex = Mutex.new

      def initialize(@input, @escape_ms : Int32 = 80)
        # The read end has to be non-blocking, because the reader parks on the
        # event loop between keystrokes — a blocking descriptor would park the
        # whole program instead. Node kept stdin blocking and read it from
        # libuv's thread pool; this is the same arrangement with a fiber in
        # place of the pool. Nothing else in the process reads the descriptor,
        # so the flag touches nobody else.
        IO::FileDescriptor.set_blocking(@input.fd, false)
        @events = Channel(Chunk | StreamEnd).new
        # JavaScript hangs this reader off the stream's own events and lets
        # the event loop interleave everything. Here a reader fiber does the
        # reads, a parser fiber turns them into keys, and all the state the
        # event loop used to serialize is either parser-local (the buffer) or
        # behind the mutex.
        spawn { read_loop }
        spawn { parse_loop }
      end

      # Take the keyboard, so a prompt that has to be answered while the
      # reading loop is blocked can be answered at all.
      #
      # The loop is one key at a time and everything it calls is awaited, so a
      # password prompt raised from inside a navigation is raised while the
      # loop is sitting in the middle of that navigation, unable to reach its
      # next keystroke — and the navigation cannot finish until the prompt is
      # answered. Whoever holds the claim is served instead, and the loop's own
      # waiting call stays parked until the claim is given back.
      #
      # Anything typed before the claim is dropped. Those keys were pressed at
      # a page, by a reader who had not yet been told a password was wanted,
      # and the least welcome place for them is a username field.
      def claim : Token
        token = Token.new
        @mutex.synchronize do
          @keys.clear
          @owner = token
        end
        token
      end

      def release(token : Token) : Nil
        @mutex.synchronize do
          @owner = nil if @owner == token
        end
      end

      def next(owner : Token? = nil) : Key
        answer : Key? = nil
        waiter : Waiter? = nil
        @mutex.synchronize do
          if owner == @owner && !@keys.empty?
            answer = @keys.shift
          elsif @ended
            answer = EOF
          else
            waiter = Waiter.new(owner)
            @waiters << waiter
          end
        end
        return answer.not_nil! if answer
        waiter.not_nil!.channel.receive
      end

      # Wait for either a key or an operation to finish. Unlike a bare race
      # with next(), this removes the key waiter when the operation wins, so
      # the next key cannot disappear into an abandoned promise.
      def next_or(operation : Channel(T), owner : Token? = nil) : OperationResult(T) | KeyResult forall T
        answer : OperationResult(T) | KeyResult? = nil
        waiter : Waiter? = nil
        @mutex.synchronize do
          if owner == @owner && !@keys.empty?
            answer = KeyResult.new(@keys.shift)
          elsif @ended
            answer = KeyResult.new(EOF)
          else
            waiter = Waiter.new(owner)
            @waiters << waiter
          end
        end
        return answer.not_nil! if answer

        waiter = waiter.not_nil!
        outcome = select
        when value = operation.receive
          OperationResult.new(value)
        when key = waiter.channel.receive
          KeyResult.new(key)
        end
        if outcome.is_a?(OperationResult(T))
          # The race is over, but a key may have raced in behind it. Whoever
          # delivered it removed the waiter on the way; put the key back where
          # the next next() finds it rather than lose a keystroke the reader
          # pressed.
          @mutex.synchronize do
            @waiters.delete(waiter)
            if waiter.delivered
              stolen = waiter.channel.receive
              @keys.unshift(stolen) if stolen.is_a?(String)
            end
          end
        end
        outcome
      end

      # Deliberate teardown ends the stream as far as this reader is concerned,
      # so a call for a key made after it answers rather than hanging.
      #
      # JavaScript also detaches the stream's listeners and pauses it, which
      # keeps Node's event loop from staying alive on nothing; a background
      # thread here cannot keep the process alive, so there is nothing to
      # pause. Like close() there, a pending lone Escape is simply dropped —
      # nobody is waiting to be told about it.
      def close : Nil
        @mutex.synchronize do
          @ended = true
        end
      end

      # One read at a time, decoded as far as the bytes allow. A code point
      # split across reads is held back until the rest of it arrives — the
      # same thing stream.setEncoding('utf8') did on the JavaScript side, so
      # no key is ever half a character. The fiber parks on the event loop
      # whenever nothing is readable, and any failure — a quiet end, a
      # destroyed stream, an error — lands as StreamEnd, because all three
      # mean the same thing to a reader waiting for a key.
      private def read_loop : Nil
        buffer = Bytes.new(8192)
        hold = Bytes.new(0)
        loop do
          count = @input.read(buffer)
          break if count <= 0
          hold = decode(hold + buffer[0, count])
        end
      rescue
        # ignored: falling through delivers StreamEnd below
      ensure
        @events.send(StreamEnd.new)
      end

      # Decodes whole code points out of the front of *bytes*, sends them on
      # as one chunk, and returns whatever incomplete tail must wait.
      private def decode(bytes : Bytes) : Bytes
        builder = String::Builder.new
        index = 0
        while index < bytes.size
          width = utf8_width(bytes[index])
          if width == 0
            # A stray continuation or an impossible lead byte. Node's decoder
            # answers these with U+FFFD, and so does this.
            builder << '\u{FFFD}'
            index += 1
            next
          end
          break if index + width > bytes.size
          if (1...width).all? { |offset| (bytes[index + offset] & 0xC0) == 0x80 }
            builder.write(bytes[index, width])
          else
            builder << '\u{FFFD}'
          end
          index += width
        end
        text = builder.to_s
        @events.send(Chunk.new(text)) unless text.empty?
        bytes[index..]
      end

      private def utf8_width(lead : UInt8) : Int32
        return 1 if lead < 0x80
        return 0 if lead < 0xC0
        return 2 if lead < 0xE0
        return 3 if lead < 0xF0
        return 4 if lead < 0xF8
        0
      end

      # All parsing happens on one fiber, so the buffer needs no lock. The
      # escape timer is a select timeout rather than a setTimeout: a lone
      # Escape waits escape_ms for company and is delivered on its own when
      # none comes, and any chunk that does arrive is parsed before the timer
      # can fire — the order of events the event loop used to guarantee.
      private def parse_loop : Nil
        loop do
          event =
            if pending_escape?
              select
              when received = @events.receive
                received
              when timeout @escape_ms.milliseconds
                nil
              end
            else
              @events.receive
            end
          case event
          when Nil
            next if ended?
            parse(true)
          when Chunk
            next if ended?
            @buffer += event.text
            parse(false)
          when StreamEnd
            end_stream
            return
          end
        end
      end

      # A timer is outstanding when the buffer is a prefix that could still
      # become a key but is also a key on its own: Escape, Alt+Escape, Alt+[,
      # Alt+O, or one of the Alt+string-introducer keys.
      private def pending_escape? : Bool
        return false if @buffer.empty? || @buffer[0] != '\e'
        step = complete_escape
        step[:length].nil? && step[:fallback] > 0
      end

      private def ended? : Bool
        @mutex.synchronize { @ended }
      end

      private def parse(expire_escape : Bool) : Nil
        while !@buffer.empty?
          first = @buffer[0]
          if first != '\e'
            @buffer = @buffer[first.bytesize..]
            emit(first.to_s)
            next
          end

          step = complete_escape
          if length = step[:length]
            emit(@buffer[0, length])
            @buffer = @buffer[length..]
          elsif step[:fallback] > 0 && expire_escape
            count = Math.min(step[:fallback], @buffer.size)
            emit(@buffer[0, count])
            @buffer = @buffer[count..]
          else
            return
          end
        end
      end

      # How much of the buffer one escape sequence occupies, or nil for “not
      # complete yet”. `fallback` is how many characters can be taken as a key
      # if no more arrive; it is what keeps a prefix that is also a valid
      # press — Escape, Alt+Escape, Alt+[, Alt+O, Alt+] — usable on its own.
      private def complete_escape : NamedTuple(length: Int32?, fallback: Int32)
        if @buffer.size == 1
          return {length: nil, fallback: 1}
        end

        second = @buffer[1]
        # A terminal writes Alt+<key> as Escape followed by the key it would
        # otherwise send. For a function key that key is itself an escape
        # sequence, so Alt+F12 arrives as Escape, Escape, "[24~".
        if second == '\e'
          return {length: nil, fallback: 2} if @buffer.size == 2
          third = @buffer[2]
          if third == '[' || third == 'O'
            final = csi_end(2)
            return {length: nil, fallback: 0} if final < 0
            return {length: final + 1, fallback: 0}
          end
          if STRING_INTRODUCERS.includes?(third)
            final = string_end(2)
            return {length: nil, fallback: 2} if final < 0
            return {length: final, fallback: 0}
          end
          return {length: 2, fallback: 0}
        end

        if second == '[' || second == 'O'
          final = csi_end(1)
          if final < 0
            return {length: nil, fallback: @buffer.size == 2 ? 2 : 0}
          end
          # X10 mouse reports are a CSI sequence followed by three payload
          # bytes. Keeping the payload with the introducer stops coordinate
          # bytes being read as ordinary keys.
          if second == '[' && @buffer[2]? == 'M' && final == 2
            payload_end = final + 1 + 3
            return {length: nil, fallback: 0} if @buffer.size < payload_end
            return {length: payload_end, fallback: 0}
          end
          return {length: final + 1, fallback: 0}
        end

        if STRING_INTRODUCERS.includes?(second)
          final = string_end(1)
          return {length: nil, fallback: 2} if final < 0
          return {length: final, fallback: 0}
        end

        # An escape followed by one character is the traditional Alt encoding.
        {length: 2, fallback: 0}
      end

      # The final byte of a CSI or SS3 sequence whose introducer is at
      # *start*. Kept here rather than inline because an Alt prefix puts the
      # same sequence one byte further into the buffer.
      private def csi_end(start : Int32) : Int32
        bytes = @buffer.to_slice
        (start + 1...bytes.size).each do |index|
          # ESC[[A is a historical function-key form whose extra "[" is an
          # introducer rather than its final byte.
          next if index == start + 1 && bytes[index] == '['.ord
          return index if bytes[index] >= 0x40 && bytes[index] <= 0x7e
        end
        -1
      end

      # One past the end of an OSC/DCS/SOS/PM/APC string, or -1 when it has
      # not finished arriving. BEL ends an OSC string; ST — Escape followed by
      # a backslash — ends any of them.
      private def string_end(start : Int32) : Int32
        bytes = @buffer.to_slice
        index = start + 1
        while index < bytes.size
          return index + 1 if bytes[index] == 0x07
          if bytes[index] == 0x1b
            return -1 if index + 1 >= bytes.size
            return index + 2 if bytes[index + 1] == '\\'.ord
          end
          index += 1
        end
        -1
      end

      private def emit(key : String) : Nil
        @mutex.synchronize do
          waiter = @waiters.find { |candidate| candidate.owner == @owner }
          if waiter
            # One answer per waiter, ever: delivering a key removes the
            # waiter, so the one-slot channel always has room and this send
            # cannot block even before the waiter reaches its receive.
            @waiters.delete(waiter)
            waiter.delivered = true
            waiter.channel.send(key)
          else
            @keys << key
          end
        end
      end

      private def end_stream : Nil
        @mutex.synchronize do
          return if @ended
          @ended = true
        end
        # A lone Escape is held back for the few milliseconds that tell it from
        # an Alt key. This is the last chance to decide it was one, and it is a
        # keystroke the reader typed: it goes out before the end does. An
        # incomplete sequence the stream ended in the middle of is dropped,
        # exactly as parse(true) there left it.
        parse(true) unless @buffer.empty?
        doomed = nil
        @mutex.synchronize do
          doomed = @waiters
          @waiters = [] of Waiter
        end
        # Everybody hears it: whoever holds the claim, and the reading loop
        # parked behind them. Both have to — the prompt so it can decline the
        # challenge it is holding open, the loop so it can shut the session
        # down.
        doomed.not_nil!.each do |waiter|
          waiter.delivered = true
          waiter.channel.send(EOF)
        end
      end
    end

    # Take the terminal raw the way Node's setRawMode did: save the line
    # discipline, apply cfmakeraw — which is what libuv's raw mode amounts to,
    # down to Enter arriving as \r — and hand the saved state back for
    # restore_raw. Nil when the descriptor is not a terminal or the kernel
    # refuses; the JavaScript reader carried on in cooked mode when stdin was
    # a pipe, and so does this.
    def self.grab_raw(fd : Int) : LibC::Termios?
      state = LibC::Termios.new
      return nil unless LibC.isatty(fd) == 1
      return nil unless LibC.tcgetattr(fd, pointerof(state)) == 0
      raw = state
      LibC.cfmakeraw(pointerof(raw))
      return nil unless LibC.tcsetattr(fd, LibC::TCSANOW, pointerof(raw)) == 0
      state
    end

    def self.restore_raw(fd : Int, state : LibC::Termios) : Bool
      LibC.tcsetattr(fd, LibC::TCSANOW, pointerof(state)) == 0
    end
  end
end
