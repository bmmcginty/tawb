require "json"
require "./reader"

module Tawb
  # The two lists Lynx keeps about the reader rather than about the page:
  # the links followed in this session (VLINKS) and the documents it has
  # been through (HISTORY). The browser owns the real history; these are
  # the session's own record of what has been read. They live here rather
  # than in the terminal loop so no part of the ordinary interface has to
  # know Lynx keeps them at all.
  module LynxSession
    # How many links and pages a session remembers. A session is not a
    # browser profile: what matters is the recent past, and a list nobody
    # can reach the bottom of is not more useful for being longer.
    VISITED_LIMIT = 200

    # VLINKS: the links followed in this session, newest first, each one
    # once. What identifies it is where it goes, so following the same link
    # twice moves it to the top rather than listing it twice.
    def self.note_visited_link(state : Reader::State, item : JSON::Any) : Nil
      href = item.as_h["href"]?
      list = state.visited_links
      at = list.index { |entry| entry.as_h["href"]? == href }
      list.delete_at(at) if at
      name = item.as_h["name"]?.try(&.as_s?)
      href_text = href.try(&.as_s?) || ""
      list.unshift(JSON::Any.new({
        "name" => JSON::Any.new(name && !name.empty? ? name : href_text),
        "href" => href || JSON::Any.new(""),
      }))
      state.visited_links = list.first(VISITED_LIMIT)
    end

    # HISTORY is the stack of documents Lynx is holding. Reading the same
    # page again is not a new place to go back to, so its entry keeps its
    # position and takes the fresh title; a blank tab is not a document
    # anybody wants listed.
    def self.note_page_visit(state : Reader::State, url : String, title : String) : Nil
      return if url.empty? || url.downcase == "about:blank"
      log = state.page_log
      if !log.empty? && log[0].as_h["url"]?.try(&.as_s?) == url
        log[0].as_h["title"] = JSON::Any.new(title) unless title.empty?
      else
        log.unshift(JSON::Any.new({
          "url"   => JSON::Any.new(url),
          "title" => JSON::Any.new(title.empty? ? url : title),
        }))
      end
      state.page_log = log.first(VISITED_LIMIT)
    end
  end
end
