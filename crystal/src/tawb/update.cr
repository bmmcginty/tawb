require "digest/sha256"
require "http/client"
require "json"
require "socket"
require "uri"

module Tawb
  # Checking for, downloading, and replacing the running native executable.
  #
  # GitHub Releases has no updater of its own; it has a public API that names
  # the latest release and its assets. The release is compared by semantic
  # version, the asset for this machine is verified against the digest GitHub
  # publishes, and only the canonical executable path is replaced. A symlink
  # that named the executable is therefore left in place, pointing at the new
  # file, rather than being replaced by a regular file.
  module Update
    API = "https://api.github.com/repos/bmmcginty/tawb/releases/latest"
    MAX_REDIRECTS = 5
    DNS_CLASS_IN = 1
    DNS_TYPE_A = 1
    DNS_TYPE_AAAA = 28

    class Error < Exception
    end

    # The static executable cannot use getaddrinfo for hostnames: glibc's NSS
    # modules are dlopen'ed at runtime, and a module with a general-dynamic TLS
    # variable (libnss_resolve is one) cannot find its TLS block in a static
    # process. The libc resolver below reads resolv.conf and queries DNS
    # directly, without loading an NSS module.
    lib LibC
      fun res_search(name : UInt8*, klass : Int32, type : Int32, answer : UInt8*, length : Int32) : Int32
    end

    record Asset, name : String, url : String, digest : String?
    record Release, tag : String, version : String, page_url : String, asset : Asset?

    def self.api_url : String
      ENV["TAWB_UPDATE_API"]? || API
    end

    def self.machine : String
      output = IO::Memory.new
      status = Process.run("uname", ["-m"], output: output,
        error: Process::Redirect::Close)
      name = output.to_s.strip
      status.success? && !name.empty? ? name : "unknown"
    rescue
      "unknown"
    end

    def self.version_parts(text : String) : Array(Int32)?
      match = /\A[vV]?(\d+)\.(\d+)\.(\d+)\z/.match(text.strip)
      return nil unless match
      [match[1].to_i, match[2].to_i, match[3].to_i]
    end

    def self.compare(left : String, right : String) : Int32
      left_parts = version_parts(left) || raise Error.new("cannot compare version #{left.inspect}")
      right_parts = version_parts(right) || raise Error.new("cannot compare version #{right.inspect}")
      left_parts.zip(right_parts).each do |a, b|
        comparison = a <=> b
        return comparison unless comparison == 0
      end
      0
    end

    def self.version_from_tag(tag : String) : String
      parts = version_parts(tag) || raise Error.new("latest release tag #{tag.inspect} is not a version")
      parts.join('.')
    end

    def self.parse_release(body : String, machine : String = machine) : Release
      object = JSON.parse(body).as_h
      if message = object["message"]?.try(&.as_s?)
        raise Error.new("GitHub API: #{message}")
      end
      tag = object["tag_name"]?.try(&.as_s?) ||
            raise Error.new("latest release has no tag_name")
      version = version_from_tag(tag)
      page = object["html_url"]?.try(&.as_s?) ||
             "https://github.com/bmmcginty/tawb/releases/tag/#{tag}"
      wanted = "tawb-#{tag}-linux-#{machine}"
      raw_asset = object["assets"]?.try(&.as_a?).try do |assets|
        assets.find { |entry| entry.as_h["name"]?.try(&.as_s?) == wanted }
      end
      asset = if raw_asset
                raw = raw_asset.as_h
                name = raw["name"].as_s
                url = raw["browser_download_url"]?.try(&.as_s?)
                digest = raw["digest"]?.try(&.as_s?)
                url ? Asset.new(name, url, digest) : nil
              end
      Release.new(tag, version, page, asset)
    rescue JSON::ParseException | TypeCastError | KeyError
      raise Error.new("latest release response was not understood")
    end

    def self.resolve(host : String) : Array(String)
      return [host] if Socket::IPAddress.valid?(host)
      name = URI::Punycode.to_ascii(host)
      addresses = query_dns(name, DNS_TYPE_A)
      addresses.concat(query_dns(name, DNS_TYPE_AAAA))
      raise Error.new("could not resolve #{host}") if addresses.empty?
      addresses
    end

    private def self.query_dns(host : String, record_type : Int32) : Array(String)
      answer = Bytes.new(4096)
      length = LibC.res_search(host.to_unsafe, DNS_CLASS_IN, record_type,
        answer.to_unsafe, answer.size)
      return [] of String if length <= 0
      parse_dns(answer[0, length], record_type)
    end

    private def self.parse_dns(packet : Bytes, record_type : Int32) : Array(String)
      return [] of String if packet.size < 12
      questions = u16(packet, 4)
      answers = u16(packet, 6)
      offset = 12
      questions.times do
        offset = skip_dns_name(packet, offset)
        offset += 4
      end

      found = [] of String
      answers.times do
        offset = skip_dns_name(packet, offset)
        raise Error.new("malformed DNS response") if offset + 10 > packet.size
        type = u16(packet, offset)
        klass = u16(packet, offset + 2)
        size = u16(packet, offset + 8)
        data = offset + 10
        raise Error.new("malformed DNS response") if data + size > packet.size
        if klass == DNS_CLASS_IN && type == record_type
          if type == DNS_TYPE_A && size == 4
            found << "#{packet[data]}.#{packet[data + 1]}.#{packet[data + 2]}.#{packet[data + 3]}"
          elsif type == DNS_TYPE_AAAA && size == 16
            found << dns_ipv6(packet, data)
          end
        end
        offset = data + size
      end
      found
    end

    private def self.skip_dns_name(packet : Bytes, offset : Int32) : Int32
      loop do
        raise Error.new("malformed DNS response") if offset >= packet.size
        length = packet[offset].to_i
        return offset + 1 if length == 0
        return offset + 2 if length & 0xc0 == 0xc0
        offset += length + 1
      end
    end

    private def self.u16(packet : Bytes, offset : Int32) : Int32
      raise Error.new("malformed DNS response") if offset + 2 > packet.size
      (packet[offset].to_i << 8) | packet[offset + 1].to_i
    end

    private def self.dns_ipv6(packet : Bytes, offset : Int32) : String
      (0..14).step(2).map do |index|
        ((packet[offset + index].to_i << 8) | packet[offset + index + 1].to_i).to_s(16)
      end.join(':')
    end

    def self.latest : Release
      headers = HTTP::Headers{
        "User-Agent"           => "tawb/#{Revision.version}",
        "Accept"               => "application/vnd.github+json",
        "X-GitHub-Api-Version" => "2022-11-28",
        "Connection"           => "close",
      }
      parse_release(fetch_text(api_url, headers), machine)
    end

    def self.run(io : IO = STDOUT) : Nil
      current_summary = Revision.summary
      current_version = Revision.version
      release = begin
        latest
      rescue error : Error
        raise error
      rescue error
        raise Error.new("could not check for updates: #{error.message || error.class.name}")
      end

      target = Process.executable_path
      writable = target ? replaceable?(target) : false

      io.puts "tawb #{current_summary}"
      io.puts "Latest release: #{release.tag}"
      io.puts "Running binary: #{target || "unknown"} " \
              "(#{target ? (writable ? "writable" : "not writable") : "unknown"})"

      comparison = compare(current_version, release.version)
      if comparison < 0
        io.puts "Update available: #{release.version}"
        asset = release.asset || raise Error.new(
          "latest release has no tawb binary for this machine")
        unless target
          raise Error.new("cannot update: could not determine the running executable path")
        end
        unless writable
          raise Error.new(
            "cannot update #{target}: the binary or its directory is not writable")
        end
        digest = asset.digest || raise Error.new(
          "latest release has no checksum for #{asset.name}")
        io.puts "Downloading #{asset.name}…"
        begin
          install(target, asset, digest)
        rescue error : Error
          raise error
        rescue error
          raise Error.new("could not install update: #{error.message || error.class.name}")
        end
        io.puts "Updated #{target} to #{release.version}."
      elsif comparison == 0
        if current_summary.includes?("+")
          io.puts "No update available; this is a development build of #{release.version}."
        else
          io.puts "No update available."
        end
      else
        io.puts "No update available; this build is newer than #{release.version}."
      end
    end

    private def self.replaceable?(target : String) : Bool
      File::Info.writable?(target) && File::Info.writable?(File.dirname(target))
    rescue File::Error
      false
    end

    private def self.install(target : String, asset : Asset, digest : String) : Nil
      expected = digest.starts_with?("sha256:") ? digest[7..].downcase : ""
      if expected.empty?
        raise Error.new("#{asset.name} has no usable SHA-256 checksum")
      end

      info = File.info(target)
      directory = File.dirname(target)
      temporary = File.tempfile(prefix: ".#{File.basename(target)}.",
        suffix: ".tmp", dir: directory)
      temporary_path = temporary.path
      installed = false
      begin
        download(asset.url, temporary)
        temporary.flush
        temporary.fsync
        temporary.close
        actual = sha256(temporary_path)
        unless actual == expected
          raise Error.new(
            "#{asset.name} failed its SHA-256 check: expected #{expected}, got #{actual}")
        end
        File.chmod(temporary_path, info.permissions)
        File.rename(temporary_path, target)
        installed = true
      ensure
        temporary.close unless temporary.closed?
        File.delete?(temporary_path) unless installed
      end
    end

    private def self.sha256(path : String) : String
      digest = Digest::SHA256.new
      File.open(path, "rb") do |file|
        buffer = Bytes.new(64 * 1024)
        while (read = file.read(buffer)) > 0
          digest.update(buffer[0, read])
        end
      end
      digest.hexfinal
    end

    private def self.fetch_text(url : String, headers : HTTP::Headers) : String
      current = URI.parse(url)
      (MAX_REDIRECTS + 1).times do
        client = client_for(current)
        begin
          response = client.get(current.request_target, headers)
          if redirected = redirect_uri(response, current)
            current = redirected
            next
          end
          unless response.status_code.in?(200..299)
            raise Error.new("GitHub returned HTTP #{response.status_code} for #{current}")
          end
          return response.body
        ensure
          client.close
        end
      end
      raise Error.new("too many redirects while checking for updates")
    end

    private def self.download(url : String, destination : File) : Nil
      headers = HTTP::Headers{
        "User-Agent" => "tawb/#{Revision.version}",
        "Accept"     => "application/octet-stream",
        "Connection" => "close",
      }
      current = URI.parse(url)
      (MAX_REDIRECTS + 1).times do
        redirected : URI? = nil
        finished = false
        client = client_for(current)
        begin
          client.get(current.request_target, headers) do |response|
            if next_uri = redirect_uri(response, current)
              redirected = next_uri
            else
              unless response.status_code.in?(200..299)
                raise Error.new("download returned HTTP #{response.status_code} for #{current}")
              end
              buffer = Bytes.new(64 * 1024)
              while (read = response.body_io.read(buffer)) > 0
                destination.write(buffer[0, read])
              end
              finished = true
            end
          end
        ensure
          client.close
        end
        return if finished
        current = redirected || raise Error.new("update download redirected without a location")
      end
      raise Error.new("too many redirects while downloading the update")
    end

    private def self.client_for(uri : URI) : HTTP::Client
      host = uri.host || raise Error.new("no host in #{uri}")
      port = uri.port || (uri.scheme == "https" ? 443 : 80)
      last_error : Exception? = nil
      resolve(host).each do |ip|
        socket = TCPSocket.new(Socket::IPAddress.new(ip, port).family)
        begin
          socket.read_timeout = 20.seconds
          socket.write_timeout = 20.seconds
          socket.connect(Socket::IPAddress.new(ip, port), timeout: 5.seconds)
          io = if uri.scheme == "https"
                 OpenSSL::SSL::Socket::Client.new(socket,
                   OpenSSL::SSL::Context::Client.new, sync_close: true, hostname: host)
               else
                 socket
               end
          return HTTP::Client.new(io, host, port)
        rescue error
          socket.close rescue nil
          last_error = error
        end
      end
      detail = last_error.try(&.message) || "no address"
      raise Error.new("could not connect to #{host}: #{detail}")
    end

    private def self.redirect_uri(response : HTTP::Client::Response,
                                  current : URI) : URI?
      return nil unless response.status_code.in?(301, 302, 303, 307, 308)
      location = response.headers["Location"]?
      location ? current.resolve(location) : nil
    end
  end
end
