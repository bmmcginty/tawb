require "base64"
require "json"
require "socket"

module Tawb
  module Transport
    record Endpoint, host : String, port : Int32, path : String

    def self.parse_url(url : String, expected_scheme : String) : Endpoint
      prefix = "#{expected_scheme}://"
      raise ArgumentError.new("expected #{expected_scheme} URL, not #{url}") unless url.starts_with?(prefix)
      rest = url[prefix.size..]
      authority, slash, tail = rest.partition('/')
      host, colon, port_text = authority.rpartition(':')
      if colon.empty?
        host = authority
        port = expected_scheme == "http" ? 80 : 80
      else
        port = port_text.to_i
      end
      Endpoint.new(host, port, slash.empty? ? "/" : "/#{tail}")
    end

    def self.http(endpoint : String, method : String, path : String) : String
      target = parse_url(endpoint, "http")
      socket = TCPSocket.new(target.host, target.port)
      socket.read_timeout = 20.seconds
      socket << "#{method} #{path} HTTP/1.1\r\nHost: #{target.host}:#{target.port}\r\n"
      socket << "Connection: close\r\nContent-Length: 0\r\n\r\n"
      head = read_http_header(socket)
      status = head.lines.first?.try(&.split[1]?.try(&.to_i?)) || 0
      raise IO::Error.new("browser HTTP request failed with #{status}") unless status.in?(200..299)
      body = if head.downcase.includes?("transfer-encoding: chunked")
               read_chunked(socket)
             elsif match = /content-length:\s*(\d+)/i.match(head)
               String.new(read_exact(socket, match[1].to_i))
             else
               ""
             end
      socket.close
      body
    end

    private def self.read_http_header(socket : TCPSocket) : String
      buffer = IO::Memory.new
      loop do
        byte = socket.read_byte || raise IO::EOFError.new
        buffer.write_byte(byte)
        data = buffer.to_slice
        return String.new(data) if data.size >= 4 && data[data.size - 4] == 13 &&
                                   data[data.size - 3] == 10 && data[data.size - 2] == 13 && data[data.size - 1] == 10
        raise IO::Error.new("oversized HTTP header") if data.size > 65536
      end
    end

    private def self.read_chunked(socket : TCPSocket) : String
      String.build do |output|
        loop do
          line = socket.gets("\r\n", chomp: true) || break
          size = line.split(';', 2)[0].to_i(16)
          break if size == 0
          output.write(read_exact(socket, size))
          read_exact(socket, 2)
        end
      end
    end

    private def self.read_exact(io : IO, size : Int32) : Bytes
      bytes = Bytes.new(size)
      io.read_fully(bytes)
      bytes
    end

    class WebSocket
      def initialize(url : String)
        target = Transport.parse_url(url, "ws")
        @socket = TCPSocket.new(target.host, target.port)
        @socket.read_timeout = 30.seconds
        key = Base64.strict_encode(Random::Secure.random_bytes(16))
        @socket << "GET #{target.path} HTTP/1.1\r\nHost: #{target.host}:#{target.port}\r\n"
        @socket << "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        @socket << "Sec-WebSocket-Key: #{key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        header = read_header
        raise IO::Error.new("WebSocket upgrade failed") unless header.starts_with?("HTTP/1.1 101")
      end

      def send(text : String) : Nil
        write_frame(0x01_u8, text.to_slice)
      end

      def receive : String
        fragments = IO::Memory.new
        loop do
          first = read_byte
          second = read_byte
          final = first.bit(7) == 1
          opcode = first & 0x0f
          masked = second.bit(7) == 1
          length = (second & 0x7f).to_u64
          length = read_u16.to_u64 if length == 126
          length = read_u64 if length == 127
          mask = masked ? read_exact(4) : nil
          payload = read_exact(length.to_i)
          if mask
            payload.each_index { |index| payload[index] ^= mask[index % 4] }
          end
          case opcode
          when 0x8
            raise IO::EOFError.new("WebSocket closed")
          when 0x9
            send_control(0x0a_u8, payload)
          when 0x0, 0x1
            fragments.write(payload)
            return String.new(fragments.to_slice) if final
          end
        end
      end

      def close : Nil
        send_control(0x08_u8, Bytes.empty)
      rescue
      ensure
        @socket.close
      end

      private def read_header : String
        bytes = IO::Memory.new
        loop do
          bytes.write_byte(read_byte)
          raise IO::Error.new("oversized WebSocket header") if bytes.size > 65536
          data = bytes.to_slice
          break if data.size >= 4 && data[data.size - 4] == 13 && data[data.size - 3] == 10 &&
                   data[data.size - 2] == 13 && data[data.size - 1] == 10
        end
        String.new(bytes.to_slice)
      end

      private def send_control(opcode : UInt8, payload : Bytes) : Nil
        raise ArgumentError.new("oversized WebSocket control frame") if payload.size > 125
        write_frame(opcode, payload)
      end

      private def write_frame(opcode : UInt8, payload : Bytes) : Nil
        header = IO::Memory.new
        header.write_byte(0x80_u8 | opcode)
        if payload.size < 126
          header.write_byte((0x80 | payload.size).to_u8)
        elsif payload.size < 65536
          header.write_byte(0xfe_u8)
          header.write_bytes(payload.size.to_u16, IO::ByteFormat::NetworkEndian)
        else
          header.write_byte(0xff_u8)
          header.write_bytes(payload.size.to_u64, IO::ByteFormat::NetworkEndian)
        end
        mask = Random::Secure.random_bytes(4)
        header.write(mask)
        masked = Bytes.new(payload.size) { |index| payload[index] ^ mask[index % 4] }
        @socket.write(header.to_slice)
        @socket.write(masked)
        @socket.flush
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
  end
end
