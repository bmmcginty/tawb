require "json"
require "set"
require "./address"
require "./unicode_escape"
require "./unicode_text"

module Tawb
  module Dump
    def self.resolve_target(input : String?, cwd : String = Dir.current, existing : Set(String)? = nil,
                            search : String = Address::DEFAULT_SEARCH) : String
      wanted = (input || "").strip
      raise ArgumentError.new("--dump needs a URL or HTML file") if wanted.empty?

      local = File.expand_path(wanted, cwd)
      exists = existing ? existing.includes?(local) : File.exists?(local)
      return file_url(local) if exists

      resolved = Address.resolve(wanted, search)
      if error = resolved["error"]?
        raise ArgumentError.new(error.as_s)
      end
      resolved["url"].as_s
    end

    def self.format_ax_blocks(blocks : Array(JSON::Any), escape_unicode : Bool = false,
                              unicode : String = "ascii") : String
      return "" if blocks.empty?
      String.build do |io|
        blocks.each do |block|
          text = block.as_h["text"]?.try(&.as_s?) || ""
          io << UnicodeText.present(text, unicode, escape_unicode) << '\n'
        end
      end
    end

    private def self.file_url(path : String) : String
      String.build do |io|
        io << "file://"
        path.to_slice.each do |byte|
          char = byte.chr
          if char.ascii_alphanumeric? || "/-._~!$&'()*+,;=:@".includes?(char)
            io << char
          else
            io << '%' << byte.to_s(16).upcase.rjust(2, '0')
          end
        end
      end
    end
    # The top document's DOMContentLoaded says nothing about the documents
    # embedded in it. A child frame commits after the parent has parsed the
    # <iframe> — an out-of-process one starts a renderer to do it, which on a
    # busy machine can still be pending when the frame walk asks — and a child
    # still on about:blank reads as an empty document. The interactive reader
    # re-renders as pages change, so a frame that missed the first picture
    # arrives with the next; a dump runs once, and there is no later re-render
    # to mend it. So the dump gives the embedded documents a bounded chance to
    # arrive: poll until no child frame is a placeholder, the top document
    # reports itself complete — a document is not complete while anything
    # embedded in it still loads — or two seconds pass. A placeholder that is
    # going nowhere is covered by the document completing, which it does as
    # soon as such a frame's own (empty) document does; the deadline is for a
    # page that hangs.
    def self.settle_embedded_frames(page : Cdp::Page | FirefoxDriver::Page,
                                    deadline_ms : Int64 = 2000,
                                    step_ms : Int64 = 50) : Nil
      deadline = Time.instant + deadline_ms.milliseconds
      loop do
        return unless page.embedded_documents_pending?
        return if page.top_document_complete?
        return if Time.instant >= deadline
        sleep step_ms.milliseconds
      end
    end
  end
end
