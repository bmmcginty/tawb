require "json"
require "socket"

module Tawb
  module Endpoint
    FILE = "tawb-endpoint.json"

    def self.record_path(profile_dir : String) : String
      File.join(profile_dir, FILE)
    end

    def self.read_record(profile_dir : String) : Hash(String, JSON::Any)?
      JSON.parse(File.read(record_path(profile_dir))).as_h
    rescue
      nil
    end

    def self.write_record(profile_dir : String, record : Hash(String, JSON::Any)) : Nil
      File.write(record_path(profile_dir), record.to_json)
    rescue
      # A running browser does not depend on its rejoin hint.
    end

    def self.free_port : Int32
      server = TCPServer.new("127.0.0.1", 0)
      port = server.local_address.port
      server.close
      port
    end

    def self.ready?(port : Int32) : Bool
      socket = TCPSocket.new("127.0.0.1", port, connect_timeout: 1.second)
      socket.close
      true
    rescue
      false
    end

    def self.wait(port : Int32, deadline : Time::Instant) : Bool
      while Time.instant < deadline
        return true if ready?(port)
        sleep 200.milliseconds
      end
      false
    end

    def self.running(profile_dir : String) : Int32?
      port = read_record(profile_dir).try(&.["port"]?.try(&.as_i?)).try(&.to_i32)
      port if port && ready?(port)
    end

    def self.port_of(url : String) : Int32?
      authority = url.split("://", 2)[1]?
      return nil unless authority
      host = authority.split('/', 2)[0]
      text = host.rpartition(':')[2]
      port = text.to_i?
      port if port && port > 0
    rescue
      nil
    end
  end
end
