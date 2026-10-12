require "json"
require "uri"

module Tawb
  # Shared presentation policy for the browser's bookmark, history and
  # download stores. Drivers return one entry shape; this module orders,
  # filters and describes it without knowing which engine supplied it.
  module Library
    KINDS = ["bookmarks", "history", "downloads"]
    KIND_LABELS = {
      "bookmarks" => "Bookmarks", "history" => "History", "downloads" => "Downloads",
    }
    MAX_ENTRIES = 5000
    MAX_ADDRESS = 100
    MINUTE = 60_000_i64
    HOUR = 60_i64 * MINUTE
    DAY = 24_i64 * HOUR

    def self.relative_age(when_ms : Int64?, now : Int64 = Time.utc.to_unix_ms) : String
      return "" unless when_ms && when_ms != 0
      ago = now - when_ms
      return "just now" if ago < MINUTE
      return "#{js_round(ago.to_f / MINUTE)} min ago" if ago < HOUR
      if ago < DAY
        hours = js_round(ago.to_f / HOUR)
        return "#{hours} hour#{hours == 1 ? "" : "s"} ago"
      end
      days = js_round(ago.to_f / DAY)
      return "#{days} day#{days == 1 ? "" : "s"} ago" if days < 30
      Time.unix_ms(when_ms).to_utc.to_s("%Y-%m-%d")
    end

    def self.size_text(bytes : Int64?, total : Int64?) : String
      return "" if (total.nil? || total == 0) && (bytes.nil? || bytes == 0)
      value = (total && total != 0 ? total : bytes).not_nil!
      [{"GB", 1_i64 << 30}, {"MB", 1_i64 << 20}, {"KB", 1_i64 << 10}].each do |name, scale|
        next if value < scale
        number = value.to_f / scale
        return value >= 10 * scale ? "#{number.round.to_i}#{name}" : "#{sprintf("%.1f", number)}#{name}"
      end
      "#{value}B"
    end

    def self.short_address(url : String, max : Int32 = MAX_ADDRESS) : String
      return url if url.size <= max
      begin
        parsed = URI.parse(url)
        if (host = parsed.host) && (scheme = parsed.scheme)
          port = parsed.port
          default = scheme == "https" ? 443 : 80
          origin = port && port != default ? "#{scheme}://#{host}:#{port}" : "#{scheme}://#{host}"
          base = "#{origin}#{parsed.path}"
          return "#{base}…" if base.size <= max
        end
      rescue
      end
      "#{url[0, max - 1]}…"
    end

    def self.entry_line(kind : String, entry : JSON::Any,
                        now : Int64 = Time.utc.to_unix_ms) : String
      object = entry.as_h
      full = text(object["url"]?)
      address = short_address(full)
      named = text(object["title"]?).gsub(/\s+/, " ").strip
      title = named.matches?(/^[a-z][\w+.-]*:\/\//i) ? short_address(named) : named
      if kind == "downloads"
        parts = [title.empty? ? address : title, text(object["state"]?),
                 size_text(integer(object["bytes"]?), integer(object["totalBytes"]?)),
                 relative_age(integer(object["when"]?), now)].reject(&.empty?)
        described = parts.join(" — ")
        return address.empty? ? described : "#{described} — from #{address}"
      end
      parts = [] of String
      parts << title if !title.empty? && title != address && title != full
      parts << address unless address.empty?
      folder = text(object["folder"]?)
      parts << "in #{folder}" if kind == "bookmarks" && !folder.empty?
      age = relative_age(integer(object["when"]?), now)
      parts << age if kind == "history" && !age.empty?
      parts.join(" — ")
    end

    def self.matches?(line : String, filter : String) : Bool
      words = filter.downcase.split(/\s+/).reject(&.empty?)
      haystack = line.downcase
      words.all? { |word| haystack.includes?(word) }
    end

    def self.order_entries(kind : String, entries : Array(JSON::Any),
                           max : Int32 = MAX_ENTRIES) : Array(JSON::Any)
      clean = entries.select do |entry|
        object = entry.as_h?
        object && (!text(object["url"]?).empty? || !text(object["file"]?).empty?)
      end
      unless kind == "bookmarks"
        clean.sort_by! { |entry| -(integer(entry.as_h["when"]?) || 0_i64) }
      end
      clean.first(max)
    end

    private def self.text(value : JSON::Any?) : String
      raw = value.try(&.raw)
      raw.nil? ? "" : raw.to_s
    end

    private def self.integer(value : JSON::Any?) : Int64?
      value.try(&.as_i64?) || value.try(&.as_f?).try(&.to_i64)
    end

    private def self.js_round(value : Float64) : Int64
      (value + 0.5).floor.to_i64
    end
  end
end
