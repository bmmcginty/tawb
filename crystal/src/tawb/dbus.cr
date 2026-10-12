require "json"
require "socket"

module Tawb
  # D-Bus, spoken directly, because the accessibility bus is the only place a
  # browser's own windows can be read.
  #
  # A native dialog — Chrome's "Add extension?", a file picker, a print sheet —
  # is not a document. A native dialog is not in CDP, a native dialog is not in
  # BiDi, and nothing in either protocol will ever describe a native dialog,
  # because CDP and BiDi describe pages. What does describe a native dialog is
  # the accessibility interface the browser already implements for screen
  # readers, and on Linux that interface is AT-SPI: plain D-Bus method calls on
  # a socket. See `atspi.cr` for what is asked; this file is only how to ask.
  #
  # Hand-written for the same reason `cdp.cr` and `bidi.cr` are, and for one
  # more: a `libdbus` binding would make the client link against a C library
  # the client otherwise does without, and the client is meant to be static.
  # What is needed of D-Bus is small — connect, authenticate, call a method,
  # read the reply — and the wire format is fixed and twenty years old.
  #
  # The parts of the format that matter here, since nothing about the format is
  # guessable from the code alone:
  #
  #   * Every value starts on a multiple of the size of the value's own type,
  #     measured from the start of the message. A string starts on a multiple
  #     of 4, an int64 on a multiple of 8, and a struct on a multiple of 8
  #     whatever the struct holds. Getting alignment wrong does not produce an
  #     error, getting alignment wrong produces garbage.
  #   * A message is a fixed 12-byte prologue, an array of header fields, a pad
  #     to 8, and the body. The body's own length is in the prologue, which is
  #     what makes a stream of messages separable.
  #   * A signature says what the body holds: 's' a string, 'u' an unsigned
  #     32-bit int, 'v' a variant, 'a(so)' an array of (string, object path)
  #     pairs. Values are marshalled with no type information of their own, so
  #     the signature is the only thing that makes the bytes readable.
  module Dbus
    LITTLE_ENDIAN    = 0x6c_u8 # 'l'
    PROTOCOL_VERSION =    1_u8

    MESSAGE_METHOD_CALL   = 1
    MESSAGE_METHOD_RETURN = 2
    MESSAGE_ERROR         = 3
    MESSAGE_SIGNAL        = 4

    # Header field codes, in the order the specification numbers the codes.
    FIELD_PATH         = 1
    FIELD_INTERFACE    = 2
    FIELD_MEMBER       = 3
    FIELD_ERROR_NAME   = 4
    FIELD_REPLY_SERIAL = 5
    FIELD_DESTINATION  = 6
    FIELD_SENDER       = 7
    FIELD_SIGNATURE    = 8

    DEFAULT_TIMEOUT = 10.seconds

    class Error < Exception
      getter dbus_name : String?

      def initialize(message : String, @dbus_name : String? = nil)
        super(message)
      end
    end

    # What a D-Bus value can be once decoded. A variant decodes to whatever the
    # variant held, so `Value` has to admit everything.
    alias Value = Bool | UInt8 | Int16 | UInt16 | Int32 | UInt32 | Int64 | UInt64 | Float64 | String | Array(Value)

    # What a D-Bus value can be while being encoded. `Variant` carries the
    # signature of what a variant holds, which is the whole point of a variant.
    alias Argument = Nil | Bool | UInt8 | Int16 | UInt16 | Int32 | UInt32 | Int64 | UInt64 | Float64 | String | Array(Argument) | Variant

    # A class rather than a struct: a variant can hold a variant, and a struct
    # that can hold itself has no fixed size.
    class Variant
      getter signature : String
      getter value : Argument

      def initialize(@signature : String, @value : Argument)
      end
    end

    # How wide a value of each type has to start. Containers take the alignment
    # of the container's kind rather than of the container's contents: a struct
    # of one byte still starts on a multiple of 8.
    ALIGNMENT = {
      'y' => 1, 'b' => 4, 'n' => 2, 'q' => 2, 'i' => 4, 'u' => 4, 'x' => 8,
      't' => 8, 'd' => 8, 'h' => 4, 's' => 4, 'o' => 4, 'g' => 1, 'v' => 1,
      'a' => 4,
    }

    def self.alignment_of(type : String) : Int32
      first = type[0]
      return 8 if first == '(' || first == '{'
      ALIGNMENT[first]? || raise Error.new(%(unknown D-Bus type "#{first}"))
    end

    # How many characters of a signature one complete type takes. 'a(so)' is
    # one type five characters long; 'ss' is two types one character each.
    def self.type_length(signature : String, at : Int32 = 0) : Int32
      raise Error.new("signature ended mid-type") if at >= signature.size
      first = signature[at]
      return 1 + type_length(signature, at + 1) if first == 'a'
      if first == '(' || first == '{'
        close = first == '(' ? ')' : '}'
        depth = 1
        index = at + 1
        while index < signature.size && depth > 0
          here = signature[index]
          if here == '(' || here == '{'
            depth += 1
          elsif here == ')' || here == '}'
            depth -= 1
          end
          index += 1
        end
        raise Error.new(%(unbalanced #{first} in signature "#{signature}")) unless depth == 0
        raise Error.new(%(mismatched brackets in "#{signature}")) unless signature[index - 1] == close
        return index - at
      end
      1
    end

    # A signature as the list of types the signature holds, so a body of
    # several values can be walked one value at a time.
    def self.split_signature(signature : String) : Array(String)
      types = [] of String
      at = 0
      while at < signature.size
        length = type_length(signature, at)
        types << signature[at, length]
        at += length
      end
      types
    end

    # A buffer that grows, and that knows where the buffer is — which is what
    # alignment needs. Positions are absolute within the message, because the
    # message is what the format aligns against.
    class Writer
      getter pos : Int32

      def initialize
        @buffer = Bytes.new(512)
        @pos = 0
      end

      private def room(bytes : Int32) : Nil
        return if @pos + bytes <= @buffer.size
        size = @buffer.size * 2
        while size < @pos + bytes
          size *= 2
        end
        bigger = Bytes.new(size)
        @buffer[0, @pos].copy_to(bigger.to_unsafe, @pos)
        @buffer = bigger
      end

      def align(width : Int32) : Nil
        pad = (width - (@pos % width)) % width
        return if pad == 0
        room(pad)
        pad.times { |offset| @buffer[@pos + offset] = 0_u8 }
        @pos += pad
      end

      def byte(value : Int) : Nil
        room(1)
        @buffer[@pos] = (value.to_i64 & 0xff).to_u8
        @pos += 1
      end

      def uint32(value : Int) : Nil
        align(4)
        room(4)
        IO::ByteFormat::LittleEndian.encode(value.to_u32!, @buffer[@pos, 4])
        @pos += 4
      end

      def raw(bytes : Bytes) : Nil
        room(bytes.size)
        bytes.copy_to(@buffer[@pos, bytes.size])
        @pos += bytes.size
      end

      # A string is the string's length, the string's bytes, and a terminating
      # nul that the length does not count.
      def string(value : String) : Nil
        bytes = value.to_slice
        uint32(bytes.size)
        raw(bytes)
        byte(0)
      end

      # A signature is the same shape with a single byte of length, since no
      # signature may be longer than 255 characters.
      def signature(value : String) : Nil
        bytes = value.to_slice
        byte(bytes.size)
        raw(bytes)
        byte(0)
      end

      def patch_uint32(at : Int32, value : Int) : Nil
        IO::ByteFormat::LittleEndian.encode(value.to_u32!, @buffer[at, 4])
      end

      def done : Bytes
        @buffer[0, @pos].dup
      end
    end

    def self.write_value(writer : Writer, type : String, value : Argument) : Nil
      case type[0]
      when 'y'
        writer.byte(as_integer(value))
      when 'b'
        writer.uint32(truthy?(value) ? 1 : 0)
      when 'n'
        writer.align(2)
        bytes = Bytes.new(2)
        IO::ByteFormat::LittleEndian.encode(as_integer(value).to_i16!, bytes)
        writer.raw(bytes)
      when 'q'
        writer.align(2)
        bytes = Bytes.new(2)
        IO::ByteFormat::LittleEndian.encode(as_integer(value).to_u16!, bytes)
        writer.raw(bytes)
      when 'i'
        writer.align(4)
        bytes = Bytes.new(4)
        IO::ByteFormat::LittleEndian.encode(as_integer(value).to_i32!, bytes)
        writer.raw(bytes)
      when 'u', 'h'
        writer.uint32(as_integer(value))
      when 'x'
        writer.align(8)
        bytes = Bytes.new(8)
        IO::ByteFormat::LittleEndian.encode(as_integer(value).to_i64!, bytes)
        writer.raw(bytes)
      when 't'
        writer.align(8)
        bytes = Bytes.new(8)
        IO::ByteFormat::LittleEndian.encode(as_integer(value).to_u64!, bytes)
        writer.raw(bytes)
      when 'd'
        writer.align(8)
        bytes = Bytes.new(8)
        IO::ByteFormat::LittleEndian.encode(as_float(value), bytes)
        writer.raw(bytes)
      when 's', 'o'
        writer.string(value.is_a?(String) ? value : value.to_s)
      when 'g'
        writer.signature(value.is_a?(String) ? value : value.to_s)
      when 'v'
        # A variant carries the variant's own signature, which is the whole
        # point of a variant: a variant is how a value of a type the caller
        # does not know travels.
        if value.is_a?(Variant)
          inner = value.signature
          held = value.value
        else
          inner = "s"
          held = value
        end
        writer.signature(inner)
        write_value(writer, inner, held)
      when 'a'
        element = type[1..]
        writer.align(4)
        length_at = writer.pos
        writer.uint32(0)
        # The length counts the elements only, and is measured from after the
        # padding that the first element's own alignment demands.
        writer.align(alignment_of(element))
        start = writer.pos
        items = value.is_a?(Array) ? value : [] of Argument
        items.each { |item| write_value(writer, element, item) }
        writer.patch_uint32(length_at, writer.pos - start)
      when '(', '{'
        types = split_signature(type[1..-2])
        writer.align(8)
        held = value.is_a?(Array) ? value : [] of Argument
        types.each_with_index { |each, index| write_value(writer, each, held[index]?) }
      else
        raise Error.new(%(cannot write D-Bus type "#{type}"))
      end
    end

    private def self.as_integer(value : Argument) : Int64
      case value
      when Bool   then value ? 1_i64 : 0_i64
      when Int    then value.to_i64
      when Float  then value.to_i64
      when String then value.to_i64? || 0_i64
      when Nil    then 0_i64
      else             0_i64
      end
    end

    private def self.as_float(value : Argument) : Float64
      case value
      when Float  then value
      when Int    then value.to_f64
      when String then value.to_f64? || 0.0
      else             0.0
      end
    end

    private def self.truthy?(value : Argument) : Bool
      case value
      when Nil    then false
      when Bool   then value
      when Int    then value != 0
      when Float  then value != 0
      when String then !value.empty?
      else             true
      end
    end

    # Reading is the mirror of writing, and the same alignment rules apply. A
    # reader is given the whole message so that the reader's positions are the
    # ones the message was marshalled against.
    class Reader
      property pos : Int32

      def initialize(@buffer : Bytes, @pos : Int32 = 0)
      end

      def align(width : Int32) : Nil
        @pos += (width - (@pos % width)) % width
      end

      def byte : UInt8
        value = @buffer[@pos]
        @pos += 1
        value
      end

      def uint32 : UInt32
        align(4)
        value = IO::ByteFormat::LittleEndian.decode(UInt32, @buffer[@pos, 4])
        @pos += 4
        value
      end

      def string : String
        length = uint32.to_i
        value = String.new(@buffer[@pos, length])
        @pos += length + 1
        value
      end

      def signature : String
        length = byte.to_i
        value = String.new(@buffer[@pos, length])
        @pos += length + 1
        value
      end

      def value(type : String) : Value
        case type[0]
        when 'y' then byte
        when 'b' then uint32 != 0
        when 'n'
          align(2)
          held = IO::ByteFormat::LittleEndian.decode(Int16, @buffer[@pos, 2])
          @pos += 2
          held
        when 'q'
          align(2)
          held = IO::ByteFormat::LittleEndian.decode(UInt16, @buffer[@pos, 2])
          @pos += 2
          held
        when 'i'
          align(4)
          held = IO::ByteFormat::LittleEndian.decode(Int32, @buffer[@pos, 4])
          @pos += 4
          held
        when 'u', 'h' then uint32
        when 'x'
          align(8)
          held = IO::ByteFormat::LittleEndian.decode(Int64, @buffer[@pos, 8])
          @pos += 8
          held
        when 't'
          align(8)
          held = IO::ByteFormat::LittleEndian.decode(UInt64, @buffer[@pos, 8])
          @pos += 8
          held
        when 'd'
          align(8)
          held = IO::ByteFormat::LittleEndian.decode(Float64, @buffer[@pos, 8])
          @pos += 8
          held
        when 's', 'o' then string
        when 'g'      then signature
        when 'v'      then value(signature)
        when 'a'
          element = type[1..]
          bytes = uint32.to_i
          align(Dbus.alignment_of(element))
          finish = @pos + bytes
          items = [] of Value
          while @pos < finish
            items << value(element)
          end
          @pos = finish
          items
        when '(', '{'
          types = Dbus.split_signature(type[1..-2])
          align(8)
          types.map { |each| value(each) }
        else
          raise Error.new(%(cannot read D-Bus type "#{type}"))
        end
      end
    end

    # One message, in either direction. The fields a particular message does
    # not carry stay nil, which is also how the encoder decides which header
    # fields to write at all.
    class Message
      property type : Int32
      property flags : Int32
      property serial : UInt32
      property body_length : UInt32
      property signature : String
      property body : Array(Value)
      property path : String?
      property iface : String?
      property member : String?
      property destination : String?
      property sender : String?
      property error_name : String?
      property reply_serial : UInt32?

      def initialize(
        @type : Int32 = MESSAGE_METHOD_CALL,
        @flags : Int32 = 0,
        @serial : UInt32 = 1_u32,
        @body_length : UInt32 = 0_u32,
        @signature : String = "",
        @body : Array(Value) = [] of Value,
        @path : String? = nil,
        @iface : String? = nil,
        @member : String? = nil,
        @destination : String? = nil,
        @sender : String? = nil,
        @error_name : String? = nil,
        @reply_serial : UInt32? = nil,
      )
      end
    end

    def self.encode_message(
      type : Int32 = MESSAGE_METHOD_CALL,
      flags : Int32 = 0,
      serial : UInt32 = 1_u32,
      path : String? = nil,
      iface : String? = nil,
      member : String? = nil,
      destination : String? = nil,
      error_name : String? = nil,
      reply_serial : UInt32? = nil,
      signature : String = "",
      body : Array(Argument) = [] of Argument,
    ) : Bytes
      writer = Writer.new
      writer.byte(LITTLE_ENDIAN)
      writer.byte(type)
      writer.byte(flags)
      writer.byte(PROTOCOL_VERSION)
      body_length_at = writer.pos
      writer.uint32(0)
      writer.uint32(serial)

      writer.align(4)
      fields_length_at = writer.pos
      writer.uint32(0)
      writer.align(8)
      fields_start = writer.pos
      write_field(writer, FIELD_PATH, "o", path)
      write_field(writer, FIELD_INTERFACE, "s", iface)
      write_field(writer, FIELD_MEMBER, "s", member)
      write_field(writer, FIELD_ERROR_NAME, "s", error_name)
      write_field(writer, FIELD_REPLY_SERIAL, "u", reply_serial)
      write_field(writer, FIELD_DESTINATION, "s", destination)
      write_field(writer, FIELD_SIGNATURE, "g", signature.empty? ? nil : signature)
      writer.patch_uint32(fields_length_at, writer.pos - fields_start)

      writer.align(8)
      body_start = writer.pos
      split_signature(signature).each_with_index do |each, index|
        write_value(writer, each, body[index]?)
      end
      writer.patch_uint32(body_length_at, writer.pos - body_start)
      writer.done
    end

    # A header field, which is written only when the message carries one. A
    # field is a code, the field's own signature, and the field's value, all
    # inside a struct, so every field starts on a multiple of 8.
    private def self.write_field(writer : Writer, code : Int32, field_type : String, value : Argument) : Nil
      return if value.nil?
      writer.align(8)
      writer.byte(code)
      writer.signature(field_type)
      write_value(writer, field_type, value)
    end

    # How long the message beginning at the front of `buffer` is, or nil if not
    # all of the message has arrived. A stream of messages is separable only
    # through the two lengths in the prologue, so `message_length` is what
    # makes reading one message possible.
    def self.message_length(buffer : Bytes) : Int32?
      return nil if buffer.size < 16
      body_length = IO::ByteFormat::LittleEndian.decode(UInt32, buffer[4, 4]).to_i64
      fields_length = IO::ByteFormat::LittleEndian.decode(UInt32, buffer[12, 4]).to_i64
      header_end = 16 + fields_length
      body_start = header_end + ((8 - (header_end % 8)) % 8)
      total = body_start + body_length
      buffer.size >= total ? total.to_i32 : nil
    end

    def self.decode_message(buffer : Bytes) : Message
      reader = Reader.new(buffer, 1)
      type = reader.byte.to_i
      flags = reader.byte.to_i
      reader.byte # protocol version
      body_length = reader.uint32
      serial = reader.uint32

      message = Message.new(type: type, flags: flags, serial: serial, body_length: body_length)
      fields = reader.value("a(yv)")
      if fields.is_a?(Array)
        fields.each do |entry|
          next unless entry.is_a?(Array)
          code = entry[0]?
          value = entry[1]?
          next unless code.is_a?(UInt8)
          case code.to_i
          when FIELD_PATH         then message.path = value.as?(String)
          when FIELD_INTERFACE    then message.iface = value.as?(String)
          when FIELD_MEMBER       then message.member = value.as?(String)
          when FIELD_ERROR_NAME   then message.error_name = value.as?(String)
          when FIELD_REPLY_SERIAL then message.reply_serial = value.as?(UInt32)
          when FIELD_DESTINATION  then message.destination = value.as?(String)
          when FIELD_SENDER       then message.sender = value.as?(String)
          when FIELD_SIGNATURE    then message.signature = value.as?(String) || ""
          end
        end
      end

      reader.align(8)
      unless message.signature.empty? || body_length == 0
        # Built as an `Array(Value)` rather than mapped, because `map` would
        # answer an array of only the types this particular body happens to
        # hold, and an `Array` of a narrower union is not an `Array(Value)`.
        body = [] of Value
        split_signature(message.signature).each { |each| body << reader.value(each) }
        message.body = body
      end
      message
    end

    # An address is a transport and the transport's parameters —
    # "unix:path=/run/user/1000/at-spi/bus_99", sometimes with a guid after the
    # path, sometimes several addresses separated by semicolons. Only unix
    # sockets are worth supporting: the accessibility bus is always one.
    def self.parse_address(address : String?) : String
      (address || "").split(';').each do |candidate|
        transport, _, rest = candidate.partition(':')
        next unless transport == "unix"
        parameters = {} of String => String
        rest.split(',').each do |pair|
          at = pair.index('=')
          if at.nil?
            parameters[pair] = ""
          else
            parameters[pair[0, at]] = pair[(at + 1)..]
          end
        end
        if path = parameters["path"]?
          return path
        end
        # An abstract socket is a Linux one with no filesystem name, spelled
        # with a leading nul exactly as the kernel spells an abstract socket.
        if abstract_path = parameters["abstract"]?
          return "\0#{abstract_path}"
        end
      end
      raise Error.new(%(no unix socket in D-Bus address "#{address}"))
    end

    # What a handler of an incoming method call is handed, so that the handler
    # can answer without knowing how a message is framed.
    class Answer
      def initialize(@connection : Connection, @message : Message)
      end

      def reply(signature : String = "", body : Array(Argument) = [] of Argument) : Nil
        @connection.send_message(
          type: MESSAGE_METHOD_RETURN,
          destination: @message.sender,
          reply_serial: @message.serial,
          signature: signature,
          body: body,
        )
      end

      def fail(name : String, text : String) : Nil
        @connection.send_message(
          type: MESSAGE_ERROR,
          destination: @message.sender,
          reply_serial: @message.serial,
          error_name: name,
          signature: "s",
          body: [text.as(Argument)],
        )
      end
    end

    # One connection to one bus. Commands carry a serial and the reply names
    # the serial, which is the same shape as every other protocol here.
    #
    # JavaScript reads the socket from the event loop. Crystal reads the socket
    # from a fiber of its own, so a call can block on a channel while the
    # reader fiber keeps draining — which is also what lets a signal or an
    # incoming method call arrive while a call is outstanding.
    class Connection
      getter name : String?
      getter? closed : Bool

      def initialize(@socket : UNIXSocket)
        @pending = {} of UInt32 => ::Channel(Message | Error)
        @signal_handlers = [] of Message -> Nil
        @call_handlers = [] of (Message, Answer) -> Bool
        @next_serial = 1_u32
        @closed = false
        @name = nil
        @mutex = Mutex.new
        # The socket is drained by a fiber of its own, so a call can wait on a
        # channel while replies, signals and incoming calls keep arriving.
        spawn { read_loop }
      end

      protected def name=(value : String?)
        @name = value
      end

      def on_signal(&handler : Message -> Nil) : self
        @mutex.synchronize { @signal_handlers << handler }
        self
      end

      # Answering calls, rather than making calls.
      #
      # Answering is here for one purpose: a machine with no desktop has no
      # accessibility bus, and the service that would provide an accessibility
      # bus is a daemon that lives in a different place on every distribution.
      # Owning the name here is a name request and one method to answer — see
      # `a11y_bus.cr` — which is less to go wrong than finding somebody else's
      # binary.
      def on_method_call(&handler : (Message, Answer) -> Bool) : self
        @mutex.synchronize { @call_handlers << handler }
        self
      end

      private def read_loop : Nil
        buffer = IO::Memory.new
        chunk = Bytes.new(16384)
        loop do
          read = @socket.read(chunk)
          break if read == 0
          buffer.write(chunk[0, read])
          loop do
            data = buffer.to_slice
            length = Dbus.message_length(data)
            break if length.nil?
            raw = data[0, length].dup
            remainder = data[length, data.size - length].dup
            buffer.clear
            buffer.write(remainder)
            begin
              message = Dbus.decode_message(raw)
            rescue
              # A message that cannot be parsed is a message that cannot be
              # answered either; dropping the message is better than tearing
              # down a connection over a type that was never asked for.
              next
            end
            deliver(message)
          end
        end
        shut_down(Error.new("the D-Bus connection closed"))
      rescue error
        shut_down(Error.new("D-Bus connection failed: #{error.message}"))
      end

      private def deliver(message : Message) : Nil
        if message.type == MESSAGE_SIGNAL
          handlers = @mutex.synchronize { @signal_handlers.dup }
          handlers.each do |handler|
            begin
              handler.call(message)
            rescue
              # A listener's problem, not this connection's.
            end
          end
          return
        end
        if message.type == MESSAGE_METHOD_CALL
          answer_call(message)
          return
        end
        reply_serial = message.reply_serial
        return if reply_serial.nil?
        waiter = @mutex.synchronize { @pending.delete(reply_serial) }
        return if waiter.nil?
        if message.type == MESSAGE_ERROR
          first = message.body[0]?
          detail = first.is_a?(String) ? ": #{first}" : ""
          waiter.send(Error.new("#{message.error_name}#{detail}", message.error_name))
          return
        end
        waiter.send(message)
      end

      private def answer_call(message : Message) : Nil
        answer = Answer.new(self, message)
        handlers = @mutex.synchronize { @call_handlers.dup }
        handlers.each do |handler|
          begin
            return if handler.call(message, answer)
          rescue error
            answer.fail("org.freedesktop.DBus.Error.Failed", error.message || error.class.name)
            return
          end
        end
        answer.fail(
          "org.freedesktop.DBus.Error.UnknownMethod",
          "#{message.iface}.#{message.member} is not here",
        )
      end

      protected def send_message(
        type : Int32,
        path : String? = nil,
        iface : String? = nil,
        member : String? = nil,
        destination : String? = nil,
        error_name : String? = nil,
        reply_serial : UInt32? = nil,
        signature : String = "",
        body : Array(Argument) = [] of Argument,
      ) : Nil
        serial = @mutex.synchronize do
          taken = @next_serial
          @next_serial += 1
          taken
        end
        raw = Dbus.encode_message(
          type: type, serial: serial, path: path, iface: iface, member: member,
          destination: destination, error_name: error_name, reply_serial: reply_serial,
          signature: signature, body: body,
        )
        @socket.write(raw)
        @socket.flush
      rescue
        # The connection is gone, and so is whoever was asking.
      end

      def call(
        destination : String? = nil,
        path : String? = nil,
        iface : String? = nil,
        member : String? = nil,
        signature : String = "",
        body : Array(Argument) = [] of Argument,
        timeout : Time::Span = DEFAULT_TIMEOUT,
      ) : Array(Value)
        raise Error.new("the D-Bus connection closed") if @closed
        waiter = ::Channel(Message | Error).new(1)
        serial = @mutex.synchronize do
          taken = @next_serial
          @next_serial += 1
          @pending[taken] = waiter
          taken
        end
        raw = Dbus.encode_message(
          type: MESSAGE_METHOD_CALL, serial: serial, destination: destination,
          path: path, iface: iface, member: member, signature: signature, body: body,
        )
        begin
          @socket.write(raw)
          @socket.flush
        rescue error
          @mutex.synchronize { @pending.delete(serial) }
          raise Error.new("#{iface}.#{member}: #{error.message}")
        end

        select
        when answered = waiter.receive
          case answered
          when Error   then raise answered
          when Message then answered.body
          else              raise Error.new("#{iface}.#{member} answered nothing")
          end
        when timeout(timeout)
          @mutex.synchronize { @pending.delete(serial) }
          raise Error.new("#{iface}.#{member} did not answer within #{timeout.total_seconds}s")
        end
      end

      # Claim a name on the bus. Answers with what the bus decided: 1 is
      # "yours", 3 is "somebody else already has it", and the difference is the
      # whole question when the point is not to disturb a service that exists.
      def request_name(name : String, flags : UInt32 = 0_u32) : UInt32
        outcome = call(
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          iface: "org.freedesktop.DBus",
          member: "RequestName",
          signature: "su",
          body: [name.as(Argument), flags.as(Argument)],
        )[0]?
        outcome.as?(UInt32) || 0_u32
      end

      # What a bus name's owner is, as a process. `process_id_of` is how an
      # application on the accessibility bus is identified as the browser that
      # was started here rather than some other window on the same desktop: the
      # bus knows the pid behind every connection and will say so.
      def process_id_of(name : String) : UInt32
        pid = call(
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          iface: "org.freedesktop.DBus",
          member: "GetConnectionUnixProcessID",
          signature: "s",
          body: [name.as(Argument)],
        )[0]?
        pid.as?(UInt32) || 0_u32
      end

      def close : Nil
        shut_down(Error.new("the D-Bus connection was closed here"))
      end

      private def shut_down(error : Error) : Nil
        waiting = @mutex.synchronize do
          return if @closed
          @closed = true
          taken = @pending.values.dup
          @pending.clear
          taken
        end
        waiting.each do |waiter|
          begin
            waiter.send(error)
          rescue
            # Nobody is listening any more.
          end
        end
        begin
          @socket.close
        rescue
          # Already gone.
        end
      end
    end

    # The handshake, which is a line protocol that runs before the binary one.
    #
    # A nul byte first — the nul byte carries the credentials the kernel
    # attaches to a unix socket — then EXTERNAL authentication, which is the
    # client saying "I am this uid" and the bus checking the claim against what
    # the kernel told the bus. No secret is exchanged because no secret is
    # needed: being able to open the socket and being that uid is the whole of
    # the claim.
    def self.handshake(socket : UNIXSocket, timeout : Time::Span) : Nil
      uid = LibC.getuid.to_s.to_slice.hexstring
      previous = socket.read_timeout
      socket.read_timeout = timeout
      socket << "\0AUTH EXTERNAL #{uid}\r\n"
      socket.flush
      loop do
        line = socket.gets("\r\n", chomp: true)
        raise Error.new("the D-Bus handshake timed out") if line.nil?
        if line.starts_with?("OK")
          socket << "BEGIN\r\n"
          socket.flush
          socket.read_timeout = previous
          return
        end
        if line.starts_with?("REJECTED") || line.starts_with?("ERROR")
          raise Error.new("the bus refused authentication: #{line}")
        end
      end
    rescue error : IO::TimeoutError
      raise Error.new("the D-Bus handshake timed out")
    end

    def self.connect(address : String, timeout : Time::Span = DEFAULT_TIMEOUT) : Connection
      path = parse_address(address)
      socket = begin
        UNIXSocket.new(path)
      rescue error
        raise Error.new("cannot reach the D-Bus at #{path}: #{error.message}")
      end
      socket.sync = false
      begin
        handshake(socket, timeout)
      rescue error
        socket.close rescue nil
        raise error.is_a?(Error) ? error : Error.new("D-Bus handshake failed: #{error.message}")
      end

      connection = Connection.new(socket)
      # Hello is not a greeting, Hello is a registration: until Hello is
      # answered the connection has no name of its own and the bus will not
      # route to the connection.
      name = connection.call(
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        iface: "org.freedesktop.DBus",
        member: "Hello",
        timeout: timeout,
      )[0]?
      connection.name = name.as?(String)
      connection
    end
  end
end
