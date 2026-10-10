require "uri"

module Tawb
  # What the three lists a browser keeps about itself need once the entries
  # exist. For now that is one thing: an address a reader can hear the whole
  # of. The rest of src/library.js arrives with bookmarks, history, and
  # downloads.
  module Library
    MAX_ADDRESS = 100

    # A tracking link is routinely four hundred characters of percent-encoded
    # query, and a line wraps: one entry of a browser's history filled twelve
    # rows of a twenty-two row screen with a base64 blob, and buried the rest
    # of the list under it. What identifies a page is its host and its path,
    # so a long address is cut back to those and marked as cut. Nothing is
    # lost — Enter goes to the address the browser gave us, not to the one on
    # screen.
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
        # not an address we can take apart
      end
      "#{url[0, max - 1]}…"
    end
  end
end
