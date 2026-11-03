require "digest/sha256"
require "http/client"
require "json"
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

    class Error < Exception
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

    def self.latest : Release
      headers = HTTP::Headers{
        "User-Agent"           => "tawb/#{Revision.version}",
        "Accept"               => "application/vnd.github+json",
        "X-GitHub-Api-Version" => "2022-11-28",
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
        client = HTTP::Client.new(current)
        begin
          configure(client)
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
      }
      current = URI.parse(url)
      (MAX_REDIRECTS + 1).times do
        redirected : URI? = nil
        finished = false
        client = HTTP::Client.new(current)
        begin
          configure(client)
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

    private def self.configure(client : HTTP::Client) : Nil
      client.connect_timeout = 5.seconds
      client.read_timeout = 20.seconds
      client.write_timeout = 20.seconds
    end

    private def self.redirect_uri(response : HTTP::Client::Response,
                                  current : URI) : URI?
      return nil unless response.status_code.in?(301, 302, 303, 307, 308)
      location = response.headers["Location"]?
      location ? current.resolve(location) : nil
    end
  end
end
