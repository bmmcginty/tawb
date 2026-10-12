# Chromium's bookmarks, history and downloads, asked for the way the browser's
# own pages ask (src/library_chromium.js).
#
# Neither CDP nor anything else in the protocol answers for these: the DevTools
# protocol describes documents, and a browser's record of where you have been
# is not a document. What does answer is the browser's own interface —
# chrome://bookmarks, chrome://history, chrome://downloads — and those are
# ordinary tabs that CDP can attach to and run script in. So a tab is opened on
# the page that owns each list, the page's own API is called, and the tab is
# closed again.
#
# The three are not equally well served, and it is worth being precise about
# which is which:
#
#   bookmarks   chrome.bookmarks.getTree(), the real extension API. That
#               interface page is granted it, so this is the same call an
#               extension makes and the same one the page itself uses. Folder
#               titles arrive already in the browser's own words.
#   history     queryHistory() on the handler, reached through the browser
#               proxy the history page's own module exports. It answers with
#               the results and takes the number wanted.
#   downloads   getDownloads() on the same kind of handler. This one answers
#               into the page rather than to the caller, and only with what has
#               changed since it last spoke — so the list is read off the
#               element that has been accumulating it, which by then is every
#               download there is.
#
# In each case the interface is the browser's, implemented in C++ for its own
# interface; the page is how it is reached. The functions that run in that page
# are the JavaScript originals, embedded as assets, so both runtimes put the
# same bytes in front of it.
#
# A tab used for this is the session's own: created in the background, kept out
# of the reader's tab list, and closed when the answer is in hand.

require "json"
require "./actions"
require "./cdp"
require "./library"

module Tawb
  module ChromiumLibrary
    PAGES = {
      "bookmarks" => "chrome://bookmarks/",
      "history"   => "chrome://history/",
      "downloads" => "chrome://downloads/",
    }

    # How long to wait for an interface page to have its answer ready.
    READY_TIMEOUT_MS = 8000
    POLL_MS          =  100

    READERS = {
      "bookmarks" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_bookmarks.js") }}),
      "history" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_history.js") }}),
      "downloads" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_downloads.js") }}),
    }

    # What has to be there before a page can be asked. Only the downloads list
    # waits on an element, since it is the element that accumulates the answer.
    READY = {
      "bookmarks" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_ready_bookmarks.js") }}),
      "history" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_ready_history.js") }}),
      "downloads" => Actions.asset_source(
        {{ read_file("#{__DIR__}/../../assets/chromium_ready_downloads.js") }}),
    }

    SAVE_BOOKMARK = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/chromium_save_bookmark.js") }})
    REMOVE_BOOKMARK = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/chromium_remove_bookmark.js") }})

    # The one thing each reader has to be told, since a function sent into a
    # page is sent with a single argument: how many entries are wanted, or how
    # long to wait for them.
    private def self.reader_argument(kind : String, timeout_ms : Int32,
                                     max : Int32) : JSON::Any?
      case kind
      when "history"   then JSON::Any.new(max.to_i64)
      when "downloads" then JSON::Any.new(Time.utc.to_unix_ms + timeout_ms)
      else                  nil
      end
    end

    # Opens the page that owns `kind`, asks it, and closes it again.
    def self.read(session : Cdp::BrowserSession, kind : String,
                  timeout_ms : Int32 = READY_TIMEOUT_MS,
                  max : Int32 = Library::MAX_ENTRIES) : Array(JSON::Any)
      url = PAGES[kind]? || raise ArgumentError.new(%(Unknown list "#{kind}".))
      entries = on_page(session, url, kind, timeout_ms) do |page|
        answer = page.evaluate(READERS[kind], reader_argument(kind, timeout_ms, max))
        answer.as_a? || [] of JSON::Any
      end
      Library.order_entries(kind, entries, max)
    end

    # Files a bookmark through the same page, and for the same reason: the
    # bookmark tree is the browser's, not a file of ours to write into, and
    # chrome://bookmarks is where the browser publishes the API for it.
    def self.save(session : Cdp::BrowserSession, url : String, title : String,
                  timeout_ms : Int32 = READY_TIMEOUT_MS) : JSON::Any
      on_page(session, PAGES["bookmarks"], "bookmarks", timeout_ms) do |page|
        page.evaluate(SAVE_BOOKMARK, JSON::Any.new({
          "url"   => JSON::Any.new(url),
          "title" => JSON::Any.new(title),
        }))
      end
    end

    def self.remove(session : Cdp::BrowserSession, entry : JSON::Any,
                    timeout_ms : Int32 = READY_TIMEOUT_MS) : JSON::Any
      id = entry.as_h?.try(&.["bookmarkId"]?).try(&.as_s?)
      raise IO::Error.new("bookmark has no browser identity") if id.nil? || id.empty?
      on_page(session, PAGES["bookmarks"], "bookmarks", timeout_ms) do |page|
        page.evaluate(REMOVE_BOOKMARK, JSON::Any.new(id))
      end
    end

    # One tab of the session's own, on the page that owns the list, closed
    # whether the answer arrived or not.
    private def self.on_page(session : Cdp::BrowserSession, url : String,
                             kind : String, timeout_ms : Int32, &)
      page = session.create_internal_page
      begin
        page.goto(url, "domcontentloaded")
        unless page.wait_for_function(READY[kind], timeout_ms, POLL_MS)
          raise IO::Error.new("the browser's #{kind} page did not answer in time")
        end
        yield page
      ensure
        session.close_page(page) rescue nil
      end
    end
  end
end
