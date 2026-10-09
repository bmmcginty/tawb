require "json"
require "socket"

module Tawb
  module Marionette
    CLEAR_SCRIPT          = {{ read_file("#{__DIR__}/../../assets/firefox_clear.js") }}
    PIERCE_PARENT_SCRIPT  = {{ read_file("#{__DIR__}/../../assets/firefox_pierce.js") }}
    LIBRARY_PARENT_SCRIPT = {{ read_file("#{__DIR__}/../../assets/firefox_library.js") }}
    TIMEOUT               = 60.seconds

    class Client
      def initialize(port : Int32)
        @socket = TCPSocket.new("127.0.0.1", port)
        @socket.read_timeout = TIMEOUT
        @next_id = 0_i64
      end

      def command(name : String, params = {} of String => JSON::Any) : JSON::Any
        @next_id += 1
        wanted = @next_id
        payload = JSON::Any.new([
          JSON::Any.new(0_i64),
          JSON::Any.new(wanted),
          JSON::Any.new(name),
          JSON::Any.new(params),
        ]).to_json
        @socket << payload.bytesize << ':' << payload
        @socket.flush

        loop do
          message = read_message
          values = message.as_a?
          next unless values
          next unless values[1]?.try(&.as_i64?) == wanted
          if error = values[2]?
            unless error.raw.nil?
              raise IO::Error.new(error.to_json[0, {error.to_json.size, 200}.min])
            end
          end
          return values[3]? || JSON::Any.new(nil)
        end
      end

      def close : Nil
        @socket.close
      rescue
      end

      private def read_message : JSON::Any
        length_text = String.build do |io|
          loop do
            byte = @socket.read_byte || raise IO::EOFError.new("Marionette connection closed")
            break if byte == ':'.ord
            raise IO::Error.new("unreadable Marionette framing") unless byte.chr.ascii_number?
            io.write_byte(byte)
            raise IO::Error.new("oversized Marionette length") if io.bytesize > 12
          end
        end
        length = length_text.to_i?
        raise IO::Error.new("unreadable Marionette framing") unless length
        bytes = Bytes.new(length)
        @socket.read_fully(bytes)
        JSON.parse(String.new(bytes))
      rescue JSON::ParseException
        raise IO::Error.new("unreadable Marionette message")
      end
    end

    def self.release_stranded_session(port : Int32) : Bool
      socket = TCPSocket.new("127.0.0.1", port)
      socket.read_timeout = TIMEOUT
      !!socket.read_byte
    rescue
      false
    ensure
      socket.try(&.close) rescue nil
    end

    def self.clear_automation(port : Int32) : JSON::Any
      client = Client.new(port)
      begin
        client.command("WebDriver:NewSession")
        client.command("Marionette:SetContext", {
          "value" => JSON::Any.new("chrome"),
        })
        cleared = client.command("WebDriver:ExecuteScript", {
          "script" => JSON::Any.new(CLEAR_SCRIPT),
          "args"   => JSON::Any.new([] of JSON::Any),
        }).as_h["value"]?.try(&.as_h?) || {} of String => JSON::Any

        begin
          client.command("WebDriver:ExecuteScript", {
            "script" => JSON::Any.new(PIERCE_PARENT_SCRIPT),
            "args"   => JSON::Any.new([] of JSON::Any),
          })
        rescue
          # Older Firefox releases may not expose the process-script service.
        end

        library_port = nil
        library_fault = nil
        begin
          installed = client.command("WebDriver:ExecuteScript", {
            "script" => JSON::Any.new(LIBRARY_PARENT_SCRIPT),
            "args"   => JSON::Any.new([] of JSON::Any),
          }).as_h["value"]?
          port_value = installed.try(&.as_i64?)
          library_port = port_value if port_value && port_value > 0
        rescue error
          library_fault = (error.message || error.class.name)[0, {(error.message || error.class.name).size, 300}.min]
        end

        result = cleared.dup
        result["libraryPort"] = library_port ? JSON::Any.new(library_port) : JSON::Any.new(nil)
        result["libraryFault"] = JSON::Any.new(library_fault) if library_fault
        JSON::Any.new(result)
      ensure
        client.close
      end
    end
  end
end
