require "json"
require "uri"
require "./core"
require "./fields"
require "./input"
require "./library"
require "./library_chromium"
require "./native_prompt"
require "./reader"
require "./reader_keys"
require "./runtime"
require "./firefox_driver"

module Tawb
  # Browser-backed bindings for the portable reader state machines. Keeping
  # these conversions here leaves Reader concerned only with JSON-shaped page
  # state and leaves Core concerned only with browser handles.
  module Interactive
    class Page
      include Reader::PageEnv
      include Runtime::InitialPage
      getter raw : Engine::Page

      def initialize(@raw); end
      def url : String; @raw.url; end
      def title : String; @raw.title; end
      def keyboard_press(key : String) : Nil
        @raw.keyboard.press(key)
      end
      def wait_for_load : Nil; @raw.wait_for_load_state; end
      def goto(url : String) : Nil; @raw.goto(url); end
      def stop_loading : Nil; @raw.stop_loading; end
      def reload(ignore_cache : Bool) : Nil; @raw.reload(ignore_cache: ignore_cache); end
      def history_identity : String
        key = @raw.evaluate("() => globalThis.navigation?.currentEntry?.key || null").as_s?
        key ? "entry:#{key}" : "url:#{url}"
      rescue
        "url:#{url}"
      end
      def history_go(direction : Int32) : Bool
        raw = @raw
        # Firefox moves through BiDi's own history command, which is
        # answered when the move commits and does not depend on the page's
        # load events — a BFCache restore emits neither load nor
        # domContentLoaded. Chromium keeps the page-side move and entry
        # poll (src/index.js traversePageHistory); src/cdp_page.js's
        # goBack is a different command the reader does not use.
        return raw.traverse_history(direction) if raw.is_a?(FirefoxDriver::Page)
        before = history_identity
        raw.evaluate("(delta) => window.history.go(delta)", JSON::Any.new(direction.to_i64))
        deadline = Time.instant + 1500.milliseconds
        while Time.instant < deadline
          sleep 50.milliseconds
          current = raw.evaluate("() => location.href").as_s? || raw.url
          raw.set_url(current)
          return true if history_identity != before
        end
        false
      end
      def goto_blank : Nil; @raw.goto("about:blank", "domcontentloaded"); end
      def close : Nil; @raw.close; end
    end

    class CoreBinding
      include Reader::CoreEnv
      getter core : Core
      @live : Hash(String, JSON::Any)
      @focus_tracker : Focus::Tracker?

      def initialize(@core)
        @live = live_json
        @focus_tracker = nil
        @activation_watch = nil.as(JSON::Any?)
      end

      def source : String; @core.source; end
      def source=(value : String) : Nil; @core.source = value; end
      def describe_place_element(item : JSON::Any) : JSON::Any?
        @core.describe_place_element(item)
      end
      def locate_place_element(array_name : String) : JSON::Any?
        @core.locate_place_element(array_name)
      end
      def release_place_element : Nil; @core.release_place_element; end
      def blocks : Array(JSON::Any)
        @core.blocks.map { |block| JSON::Any.new({"text" => JSON::Any.new(block.text), "item" => block.item}) }
      end
      def at(index : Int32) : Nil; @core.at(index); end
      def mark_input : Nil; @core.mark_input; end
      def popup : JSON::Any?
        @core.popup_controls.try do |controls|
          JSON::Any.new({"controls" => JSON::Any.new(controls)})
        end
      end
      def popup_at : Int64; @core.popup_at.to_i64; end
      def forget_popup : Nil; @core.forget_popup; end
      def activate(item : JSON::Any) : JSON::Any; @core.activate(item); end
      def rescan : Nil; sync_live_to_core; @core.rescan; sync_live_from_core; end
      def snapshot_cost_ms : Int64; @core.snapshot_cost_ms; end
      def live : JSON::Any?; JSON::Any.new(@live); end
      def set_live_snapshot_cost(ms : Int64) : Nil
        @core.live.snapshot_cost_ms = ms
        @live["snapshotCostMs"] = JSON::Any.new(ms)
      end

      def anchor : JSON::Any; anchor_json(@core.anchor); end
      def restore(saved : JSON::Any) : Int32; @core.restore(parse_anchor(saved)); end
      def reanchor(saved : JSON::Any) : JSON::Any
        settled_json(@core.reanchor(parse_anchor(saved)))
      end
      def reanchor_with_texts(saved : JSON::Any, previous_texts : Array(String)) : JSON::Any
        settled_json(@core.reanchor(parse_anchor(saved), previous_texts))
      end

      def fragment_of(item : JSON::Any) : JSON::Any?
        @core.fragment_of(item).try { |value| JSON::Any.new(value) }
      end
      def focus_control(item : JSON::Any) : Bool; @core.focus_control(item); end
      def attach_files(item : JSON::Any, paths : Array(String)) : Bool; @core.attach_files(item, paths); end
      def options_for(item : JSON::Any) : JSON::Any?; @core.options_for(item); end
      def field_for_typing(item : JSON::Any) : JSON::Any?; @core.field_for_typing(item); end
      def choose_option(control : JSON::Any, index : Int32) : JSON::Any; @core.choose_option(control, index); end
      def follow_popup(controls : String?) : Nil; @core.follow_popup(controls); end
      def note_changes(previous_texts : Array(String)) : Array(JSON::Any)
        @core.note_changes(previous_texts).map do |change|
          JSON::Any.new({"start" => JSON::Any.new(change.start.to_i64),
                         "stop" => JSON::Any.new(change.stop.to_i64),
                         "text" => JSON::Any.new(change.text),
                         "at" => JSON::Any.new(change.at)})
        end
      end
      def block_at_fragment(hash : String) : Int32; @core.block_at_fragment(hash); end

      def chooser : JSON::Any?
        value = @core.chooser || return nil
        JSON::Any.new({
          "blockIndex" => JSON::Any.new(value.block_index.to_i64),
          "at" => JSON::Any.new(value.at.to_i64), "count" => JSON::Any.new(value.count.to_i64),
          "filter" => JSON::Any.new(value.filter),
          "shown" => JSON::Any.new(value.shown.map { |index| JSON::Any.new(index.to_i64) }),
          "options" => JSON::Any.new(value.options), "multiple" => JSON::Any.new(value.multiple),
        })
      end
      def open_chooser(at : Int32, listing : JSON::Any) : Nil; @core.open_chooser(at, listing); end
      def close_chooser : Nil; @core.close_chooser; end
      def show_chooser(filter : String) : Int32; @core.show_chooser(filter); end

      # The focus an activation moved. The tracker and the handle it answers
      # with are the core's, and neither is a thing JSON can carry, so what
      # crosses this seam is only whether there is one — which is all the
      # reader's own half needs to know. See `focus.cr`.
      def watch_activation_focus(item : JSON::Any) : JSON::Any?
        tracker = @core.watch_activation_focus(item) || return nil
        @focus_tracker = tracker
        JSON::Any.new({"token" => JSON::Any.new(tracker.token)})
      end

      def cancel_activation_focus(watch : JSON::Any) : Nil
        @core.cancel_activation_focus(@focus_tracker)
        @focus_tracker = nil
      end

      def activation_focus(watch : JSON::Any) : JSON::Any?
        found = @core.activation_focus(@focus_tracker)
        @focus_tracker = nil
        found ? JSON::Any.new({"found" => JSON::Any.new(true)}) : nil
      end

      def focus_destination_block(focused : JSON::Any) : Int32
        @core.focus_destination_block
      end

      def drop_focus_destination(focused : JSON::Any) : Nil
        @core.drop_focus_destination
      end

      def read_typing_field : JSON::Any?; @core.read_typing_field; end
      def release_typing_field : Nil; @core.release_typing_field; end
      def adjust_control(item : JSON::Any, key : String) : JSON::Any; @core.adjust_control(item, key); end
      def no_more_to_load : Bool; @core.no_more_to_load?; end
      def ask_for_more : JSON::Any; @core.ask_for_more; end
      def can_real_click : Bool; true; end
      def real_click(item : JSON::Any) : JSON::Any; @core.real_click(item); end
      def can_hover : Bool; true; end
      def hover(item : JSON::Any) : JSON::Any; @core.hover(item); end
      def download_link(item : JSON::Any) : JSON::Any; @core.download_link(item); end
      def change_targets : Array(JSON::Any)
        @core.change_targets.map do |target|
          JSON::Any.new({"block" => JSON::Any.new(target.block.to_i64),
                         "size" => JSON::Any.new(target.size.to_i64),
                         "at" => JSON::Any.new(target.at)})
        end
      end
      def change_index : Int32; @core.change_index; end
      def change_index=(value : Int32) : Nil; @core.change_index = value; end
      def driver_name : String; "firefox"; end

      private def anchor_json(value : Core::Anchor) : JSON::Any
        JSON::Any.new({
          "text" => JSON::Any.new(value.text),
          "name" => value.name.try { |v| JSON::Any.new(v) } || JSON::Any.new(nil),
          "identity" => value.identity.try { |v| JSON::Any.new(v) } || JSON::Any.new(nil),
          "block" => JSON::Any.new(value.block.to_i64),
          "context" => JSON::Any.new(value.context.map { |v| JSON::Any.new(v) }),
          "ratio" => JSON::Any.new(value.ratio),
        })
      end

      private def parse_anchor(value : JSON::Any) : Core::Anchor
        object = value.as_h
        Core::Anchor.new(object["text"].as_s, object["name"]?.try(&.as_s?),
          object["identity"]?.try(&.as_s?), object["block"].as_i.to_i32,
          object["context"].as_a.map(&.as_s), object["ratio"].as_f)
      end

      private def settled_json(value : Core::Settled) : JSON::Any
        JSON::Any.new({"block" => JSON::Any.new(value.block.to_i64),
                       "exact" => JSON::Any.new(value.exact)})
      end

      private def live_json : Hash(String, JSON::Any)
        value = @core.live
        {
          "enabled" => JSON::Any.new(value.enabled), "dirty" => JSON::Any.new(value.dirty),
          "refreshing" => JSON::Any.new(value.refreshing),
          "snapshotCostMs" => JSON::Any.new(value.snapshot_cost_ms),
          "lastPulseMs" => JSON::Any.new(value.last_pulse_ms),
        }
      end

      private def sync_live_to_core : Nil
        @core.live.enabled = @live["enabled"]?.try(&.as_bool?) != false
        @core.live.dirty = @live["dirty"]?.try(&.as_bool?) || false
        @core.live.refreshing = @live["refreshing"]?.try(&.as_bool?) || false
      end

      private def sync_live_from_core : Nil
        @live = live_json
      end
    end

    class Tabs
      include Reader::TabEnv
      getter current_page : Reader::PageEnv

      def initialize(@core : Core, @driver : Engine::Session, initial : Engine::Page)
        @pages = {} of String => Page
        @current_page = wrap(initial)
      end

      def next_tab(direction : Int32) : Reader::PageEnv?
        @core.next_tab(direction).try { |page| wrap(page) }
      end
      def tab_after(page : Reader::PageEnv) : Reader::PageEnv?
        @core.tab_after(unwrap(page)).try { |found| wrap(found) }
      end
      def adopt_tab(page : Reader::PageEnv) : Nil
        raw = unwrap(page); @core.adopt_tab(raw); @current_page = wrap(raw)
      end
      def new_tab : Reader::PageEnv; wrap(@core.new_tab); end
      def close_tab(page : Reader::PageEnv) : Nil; @core.close_tab(unwrap(page)); end
      def tab_position(page : Reader::PageEnv) : NamedTuple(position: Int32, of: Int32)
        found = @core.where(unwrap(page)); {position: found.position, of: found.of}
      end
      def tab_label(page : Reader::PageEnv) : String; @core.tab_label(unwrap(page)); end
      def page_env(page : Engine::Page) : Reader::PageEnv; wrap(page); end

      private def wrap(page : Engine::Page) : Page
        @pages[page.tab_id]? || begin
          made = Page.new(page); @pages[page.tab_id] = made; made
        end
      end
      private def unwrap(page : Reader::PageEnv) : Engine::Page; page.as(Page).raw; end
    end

    # One front-end tick: reconcile tabs and navigation, drain observer
    # batches, pulse the safety-net fingerprint, and repaint only rows whose
    # rendered text changed. Browser work remains serialized with key handling
    # because the CLI calls this from the same loop between keystrokes.
    class LiveTicker
      NEW_TAB_SETTLE_MS = 1200_i64

      def initialize(@output : Screen::Output, @state : Reader::State,
                     @tabs : Tabs, @core : Core, @logger : Log)
        @known_tabs = Set(String).new
        @core.tabs.each { |page| @known_tabs << page.tab_id }
        @new_tabs = {} of String => Tuple(Engine::Page, Int64)
      end

      def tick(now : Int64 = Time.utc.to_unix_ms) : Nil
        return if recover_closed_tab
        discover_tabs(now)
        return if follow_settled_tab(now)

        page = @core.page || return
        wrapper = @tabs.current_page
        case @core.external_navigation(page.url)
        when :navigated
          Reader.refresh(@state, wrapper, true)
          Reader.render(@output, @state, wrapper.url, true)
          Reader.set_status(@output, @state, wrapper.url,
            "Page changed: #{wrapper.url}")
          @core.attach_live(page) rescue nil
        end

        events = @core.collect_live(page)
        pulse = @core.pulse_live(page, now)
        if pulse && (pulse.changed || pulse.navigated || pulse.rearmed || pulse.ms > 50)
          @logger.write("live.pulse", {
            "changed" => JSON::Any.new(pulse.changed),
            "navigated" => JSON::Any.new(pulse.navigated),
            "rearmed" => JSON::Any.new(pulse.rearmed),
            "ms" => JSON::Any.new(pulse.ms),
          })
        end
        events.each { |event| apply(event, page, wrapper) }
        # A previous batch may have been held by the input grace period. A
        # payload-free cycle advances that dirty buffer once it becomes due.
        apply(nil, page, wrapper) if events.empty? || @core.live.dirty
        if @core.live.pulse_errors > 0
          @logger.count("pulseErrors", @core.live.pulse_errors.to_i64)
          @core.live.pulse_errors = 0
        end
      rescue error
        @logger.write("live.tick.error", {
          "error" => JSON::Any.new((error.message || error.to_s)[0, Math.min((error.message || error.to_s).size, 160)]),
        })
      end

      private def recover_closed_tab : Bool
        page = @core.page || return false
        return false unless page.closed?
        remaining = @core.tabs.reject { |other| other.same?(page) }
        if remaining.empty?
          Reader.set_status(@output, @state, @tabs.current_page.url,
            "The last tab closed.")
          return true
        end
        @logger.write("tab.closed", {"remaining" => JSON::Any.new(remaining.size.to_i64)})
        switch_to(remaining.last, "That tab closed")
        true
      end

      private def discover_tabs(now : Int64) : Nil
        live_ids = Set(String).new
        @core.tabs.each do |page|
          id = page.tab_id
          live_ids << id
          unless @known_tabs.includes?(id)
            @known_tabs << id
            @new_tabs[id] = {page, now}
          end
        end
        @known_tabs.select! { |id| live_ids.includes?(id) }
        @new_tabs.reject! { |id, pair| !live_ids.includes?(id) || pair[0].closed? }
      end

      private def follow_settled_tab(now : Int64) : Bool
        ready = @new_tabs.find { |_id, pair| now - pair[1] >= NEW_TAB_SETTLE_MS }
        return false unless ready
        id, pair = ready
        @new_tabs.delete(id)
        page = pair[0]
        return false if page.same?(@core.page) || page.closed?
        foreground = @core.foreground?(page)
        @logger.write("tab.opened", {
          "url" => JSON::Any.new(page.url[0, Math.min(page.url.size, 120)]),
          "foreground" => JSON::Any.new(foreground),
        })
        if foreground
          switch_to(page, "Followed a new tab")
          return true
        end
        Reader.set_status(@output, @state, @tabs.current_page.url,
          "A new tab opened in the background: #{@core.tab_label(page)} — press > to reach it.")
        false
      end

      private def switch_to(page : Engine::Page, note : String) : Nil
        ReaderKeys.switch_to_tab(@output, @state, @tabs, @tabs.page_env(page), note)
        @core.attach_live(page) rescue nil
      end

      private def apply(payload : JSON::Any?, page : Engine::Page,
                        wrapper : Reader::PageEnv) : Nil
        before = Reader.screen_before(@state)
        anchor = @state.core.anchor
        line_count = @state.lines.size
        was_navigation = @core.live.navigated
        wraps = ->(_touched : Array(Int32)) do
          Reader.relayout(@state)
          @state.lines.size == line_count
        end
        result = @core.live_cycle(payload, page, wraps: wraps,
          already_classified: !payload.nil?).as_h
        if result["patched"]?.try(&.raw).nil?
          # A refused patch has already been undone in the core; discard the
          # temporary layout the wrapping check made from it.
          Reader.relayout(@state)
        end
        if result["refreshed"].as_bool
          Reader.relayout(@state)
          if was_navigation
            @state.cursor = 0; @state.col = 0; @state.scroll = 0
          else
            Reader.reanchor_quietly(@state, anchor)
          end
          @logger.count("refreshes")
        end
        Reader.repaint_list(@output, @state, wrapper.url, before)
        (result["announcements"]?.try(&.as_a?) || [] of JSON::Any).each do |announcement|
          text = announcement.as_h["text"]?.try(&.as_s?) || ""
          Reader.set_status(@output, @state, wrapper.url,
            text[0, Math.min(text.size, @state.cols)]) unless text.empty?
        end
        if payload
          mutations = payload.as_h["mutations"]?.try(&.as_i64?) || 0_i64
          @logger.count("notifies")
          @logger.count("mutations", mutations)
        end
      end
    end

    class LibraryBinding
      include Reader::LibraryEnv
      def initialize(@port : Int32); end
      def read(kind : String) : Array(JSON::Any)
        answer = FirefoxAgent.ask(@port, JSON::Any.new({
          "kind" => JSON::Any.new(kind), "max" => JSON::Any.new(Library::MAX_ENTRIES.to_i64),
        }))
        Library.order_entries(kind, answer.as_a)
      end
      def save(url : String, title : String) : JSON::Any
        FirefoxAgent.ask(@port, JSON::Any.new({
          "kind" => JSON::Any.new("save"), "url" => JSON::Any.new(url),
          "title" => JSON::Any.new(title),
        }))
      end
      def delete(entry : JSON::Any) : Nil
        FirefoxAgent.ask(@port, JSON::Any.new({
          "kind" => JSON::Any.new("remove"),
          "bookmarkGuid" => entry.as_h["bookmarkGuid"]? || JSON::Any.new(""),
        }))
      end
    end

    # The same three lists, asked of Chromium's own pages. The reader's
    # screens cannot tell which browser answered; what differs is only where
    # the answer comes from (ChromiumLibrary).
    class ChromiumLibraryBinding
      include Reader::LibraryEnv

      def initialize(@session : Cdp::BrowserSession); end

      def read(kind : String) : Array(JSON::Any)
        ChromiumLibrary.read(@session, kind)
      end

      def save(url : String, title : String) : JSON::Any
        ChromiumLibrary.save(@session, url, title)
      end

      def delete(entry : JSON::Any) : Nil
        ChromiumLibrary.remove(@session, entry)
      end
    end

    class CredentialBinding
      include Reader::CredentialEnv
      def initialize(@credentials : Auth::Credentials); end
      def remember(url : String, username : String, password : String) : Nil
        @credentials.remember(JSON::Any.new({"url" => JSON::Any.new(url)}),
          JSON::Any.new({"username" => JSON::Any.new(username),
                         "password" => JSON::Any.new(password)}))
      end
      def reconsider : Nil; @credentials.reconsider; end
    end

    # The browser's own question, as the key handlers see it: a
    # `NativePrompt::Request` read over the accessibility bus, flattened to
    # the names and the indexes the dialog screen works in.
    class DialogBinding
      include Reader::DialogEnv

      def initialize(@request : NativePrompt::Request); end

      def role : String
        @request.role
      end

      def title : String
        @request.title
      end

      def lines : Array(String)
        @request.lines
      end

      def buttons : Array(Reader::DialogControl)
        @request.buttons.map { |button| DialogBinding.control(button) }
      end

      def toggles : Array(Reader::DialogControl)
        @request.toggles.map { |toggle| DialogBinding.control(toggle) }
      end

      def fields : Array(Reader::DialogField)
        @request.fields.map { |field| Reader::DialogField.new(field.name, field.value) }
      end

      def press(index : Int32) : Bool
        control = @request.buttons[index]? || return false
        @request.press(control)
      end

      def toggle(index : Int32) : Bool?
        control = @request.toggles[index]? || return nil
        @request.toggle(control)
      end

      def reread : Reader::DialogEnv?
        DialogBinding.new(@request.reread)
      rescue
        nil
      end

      def still_open? : Bool
        @request.still_open?
      end

      def self.control(described : Atspi::Described) : Reader::DialogControl
        Reader::DialogControl.new(
          name: described.name,
          checked: described.checked,
          focused: described.focused,
          is_default: described.is_default,
        )
      end
    end

    class Keyboard
      include ReaderKeys::Keyboard
      def initialize(@reader : Input::KeyReader); end
      def claim : Input::Token; @reader.claim; end
      def next_key(token : Input::Token) : Input::Key; @reader.next(token); end
      def release(token : Input::Token) : Nil; @reader.release(token); end
      def next_or(operation : Channel(ReaderKeys::NavigateOutcome), token : Input::Token) : Input::OperationResult(ReaderKeys::NavigateOutcome) | Input::KeyResult
        @reader.next_or(operation, token)
      end
    end
  end
end
