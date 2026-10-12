require "json"
require "set"
require "uri"

module Tawb
  # Browser authentication shared by the drivers and reader: challenges are
  # normalised to one shape, credentials live only for this process, retries
  # are bounded, and prompts are serialized so protected subresources cannot
  # fight over the terminal's status row.
  module Auth
    MAX_ATTEMPTS = 3
    ROUND_MS     = 30_000_i64

    def self.origin_of(url : String) : String
      uri = URI.parse(url)
      return url unless uri.scheme && uri.host
      port = uri.port
      standard = (uri.scheme == "http" && port == 80) || (uri.scheme == "https" && port == 443)
      "#{uri.scheme}://#{uri.host}#{port && !standard ? ":#{port}" : ""}"
    rescue
      url
    end

    def self.normalise_challenge(raw : JSON::Any) : JSON::Any
      object = raw.as_h? || {} of String => JSON::Any
      source = object["source"]?.try(&.as_s?).try(&.downcase) == "proxy" ? "proxy" : "server"
      url = object["url"]?.try(&.as_s?) || ""
      JSON::Any.new({
        "source" => JSON::Any.new(source),
        "origin" => JSON::Any.new(object["origin"]?.try(&.as_s?) || origin_of(url)),
        "realm"  => JSON::Any.new(object["realm"]?.try(&.as_s?) || ""),
        "scheme" => JSON::Any.new((object["scheme"]?.try(&.as_s?) || "").downcase),
        "url"    => JSON::Any.new(url),
      })
    end

    def self.challenge_key(challenge : JSON::Any) : String
      object = normalise_challenge(challenge).as_h
      "#{object["source"].as_s}|#{object["origin"].as_s}|#{object["realm"].as_s}"
    end

    def self.origin_key(challenge : JSON::Any) : String
      object = normalise_challenge(challenge).as_h
      "#{object["source"].as_s}|#{object["origin"].as_s}|"
    end

    class Credentials
      record Try, count : Int32, at : Int64

      def initialize(@ask : Proc(JSON::Any, Bool, Int32, JSON::Any?)? = nil,
                     @log : Proc(String, Hash(String, JSON::Any), Nil)? = nil)
        @known = {} of String => JSON::Any
        @denied = Set(String).new
        @tries = {} of String => Try
        @prompt = Mutex.new
      end

      def remember(raw : JSON::Any, credentials : JSON::Any) : String
        challenge = Auth.normalise_challenge(raw)
        key = Auth.challenge_key(challenge)
        @known[key] = credentials
        @denied.delete(key)
        key
      end

      def forget(raw : JSON::Any) : Nil
        @known.delete(Auth.challenge_key(raw))
      end

      def reconsider : Nil
        @denied.clear
      end

      def answer(raw : JSON::Any, id : String? = nil,
                 now : Int64 = Time.utc.to_unix_ms) : JSON::Any?
        challenge = Auth.normalise_challenge(raw)
        key = Auth.challenge_key(challenge)
        attempt = id ? count_try(id, now) : 1
        prune(now)
        refused = attempt > 1
        if refused
          @known.delete(key)
          @known.delete(Auth.origin_key(challenge))
          if attempt > MAX_ATTEMPTS
            emit("auth.giveup", {"key" => JSON::Any.new(key),
                                  "attempts" => JSON::Any.new((attempt - 1).to_i64)})
            @denied.add(key)
            return nil
          end
        elsif known = @known[key]? || @known[Auth.origin_key(challenge)]?
          return known
        elsif @denied.includes?(key)
          return nil
        end
        asker = @ask || return nil
        @prompt.synchronize do
          if !refused && (known = @known[key]?)
            return known
          end
          given = asker.call(challenge, refused, attempt)
          object = given.try(&.as_h?)
          username = object.try(&.["username"]?).try(&.as_s?)
          unless username && !username.empty?
            @denied.add(key)
            emit("auth.declined", {"key" => JSON::Any.new(key)})
            return nil
          end
          kept = JSON::Any.new({
            "username" => JSON::Any.new(username),
            "password" => JSON::Any.new(object.try(&.["password"]?).try(&.as_s?) || ""),
          })
          @known[key] = kept
          emit("auth.answered", {"key" => JSON::Any.new(key),
                                  "scheme" => challenge.as_h["scheme"],
                                  "attempt" => JSON::Any.new(attempt.to_i64)})
          kept
        end
      end

      private def count_try(id : String, now : Int64) : Int32
        previous = @tries[id]?
        entry = if previous.nil? || now - previous.not_nil!.at > ROUND_MS
                  Try.new(1, now)
                else
                  Try.new(previous.not_nil!.count + 1, now)
                end
        @tries[id] = entry
        entry.count
      end

      private def prune(now : Int64) : Nil
        return if @tries.size < 64
        cutoff = now - ROUND_MS
        @tries.reject! { |_id, entry| entry.at < cutoff }
      end

      private def emit(event : String, fields : Hash(String, JSON::Any)) : Nil
        @log.try(&.call(event, fields))
      end
    end

    # https://user:password@host is deprecated for subresources in Chrome and
    # interrupted by a confirmation of its own in Firefox, so the pair is
    # taken out of the address and used to answer the challenge instead. It
    # also keeps the password out of the address this session then holds.
    def self.split_credentials(text : String) : Hash(String, JSON::Any)
      raw = text
      url = URI.parse(raw)
      # decodeURIComponent leaves a plus alone; the form decoder would read it
      # as a space, so a literal plus is escaped before decoding.
      decode = ->(part : String) { URI.decode_www_form(part.gsub("+", "%2B")) }
      username = url.user ? decode.call(url.user.not_nil!) : nil
      password = url.password ? decode.call(url.password.not_nil!) : nil
      if (username.nil? || username.empty?) && (password.nil? || password.empty?)
        return {"url" => JSON::Any.new(raw), "username" => JSON::Any.new(nil),
                "password" => JSON::Any.new(nil)}
      end
      url.user = nil
      url.password = nil
      {
        "url"      => JSON::Any.new(url.to_s),
        "username" => JSON::Any.new(username || ""),
        "password" => JSON::Any.new(password || ""),
      }
    rescue
      {"url" => JSON::Any.new(raw), "username" => JSON::Any.new(nil),
       "password" => JSON::Any.new(nil)}
    end
  end
end
