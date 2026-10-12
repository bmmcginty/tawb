require "json"
require "uri"
require "./core"
require "./fields"
require "./input"
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
      getter raw : FirefoxDriver::Page

      def initialize(@raw); end
      def url : String; @raw.url; end
      def title : String; @raw.title; end
      def keyboard_press(key : String) : Nil
        FirefoxDriver::Keyboard.new(@raw.protocol, @raw.context_id).press(key)
      end
      def wait_for_load : Nil; @raw.wait_for_load_state; end
      def goto(url : String) : Nil; @raw.goto(url); end
      def stop_loading : Nil; @raw.stop_loading; end
      def reload(ignore_cache : Bool) : Nil; @raw.reload(ignore_cache: ignore_cache); end
      def goto_blank : Nil; @raw.goto("about:blank", "domcontentloaded"); end
      def close : Nil; @raw.close; end
    end

    class CoreBinding
      include Reader::CoreEnv
      getter core : Core
      @live : Hash(String, JSON::Any)

      def initialize(@core)
        @live = live_json
        @activation_watch = nil.as(JSON::Any?)
      end

      def source : String; @core.source; end
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

      # Focus-following is best effort until the browser-side tracker is
      # promoted into the native handle layer. Returning nil preserves the
      # activated document without guessing at a destination.
      def watch_activation_focus(item : JSON::Any) : JSON::Any?; nil; end
      def cancel_activation_focus(watch : JSON::Any) : Nil; end
      def activation_focus(watch : JSON::Any) : JSON::Any?; nil; end
      def focus_destination_block(focused : JSON::Any) : Int32; -1; end
      def drop_focus_destination(focused : JSON::Any) : Nil; end

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

      def initialize(@core : Core, @driver : FirefoxDriver::BrowserSession, initial : FirefoxDriver::Page)
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

      private def wrap(page : FirefoxDriver::Page) : Page
        @pages[page.context_id]? || begin
          made = Page.new(page); @pages[page.context_id] = made; made
        end
      end
      private def unwrap(page : Reader::PageEnv) : FirefoxDriver::Page; page.as(Page).raw; end
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
