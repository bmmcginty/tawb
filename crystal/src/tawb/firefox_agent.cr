require "json"
require "socket"

module Tawb
  module FirefoxAgent
    MAX_REPLY_BYTES = 32 * 1024 * 1024

    def self.ask(port : Int32?, request : JSON::Any) : JSON::Any
      unless port && port.in?(1..65535)
        raise IO::Error.new("this Firefox has no library agent endpoint")
      end

      socket = TCPSocket.new("127.0.0.1", port)
      socket.read_timeout = 10.seconds
      begin
        body = request.to_json
        socket << body.bytesize << ':' << body
        socket.flush

        length_text = String.build do |io|
          loop do
            byte = socket.read_byte || raise IO::Error.new(
              "Firefox library agent closed without answering"
            )
            break if byte == ':'.ord
            unless byte.chr.ascii_number?
              raise IO::Error.new("Firefox library agent sent invalid framing")
            end
            io.write_byte(byte)
            if io.bytesize > 12
              raise IO::Error.new("Firefox library agent sent invalid framing")
            end
          end
        end
        length = length_text.to_i64?
        unless length && length.in?(0..MAX_REPLY_BYTES)
          raise IO::Error.new("Firefox library agent sent an oversized reply")
        end
        bytes = Bytes.new(length.to_i)
        socket.read_fully(bytes)
        reply = JSON.parse(String.new(bytes)).as_h
        if error = reply["error"]?.try(&.as_s?)
          raise IO::Error.new(error)
        end
        reply["result"]? || JSON::Any.new(nil)
      rescue JSON::ParseException
        raise IO::Error.new("Firefox library agent sent unreadable JSON")
      rescue error : Socket::ConnectError
        raise IO::Error.new("could not reach Firefox library agent: #{error.message}")
      ensure
        socket.close rescue nil
      end
    rescue error : Socket::ConnectError
      raise IO::Error.new("could not reach Firefox library agent: #{error.message}")
    end
  end
end
