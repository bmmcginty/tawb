require "json"
require "./screen"
require "./unicode_escape"
require "./lynx_display"
require "./lynx_session"
require "./layout"
require "./place"

module Tawb
  # The terminal drawing of src/index.js: the three banner rows, the reading
  # list, the status row, and the cursor parking that puts the terminal
  # cursor where the reader is. What may be written and what may not is the
  # whole point — a repainted row is re-read by a screen reader and
  # re-flashed by a braille display whether or not it says anything new, so
  # every row here keeps a record of what it last said and writes only when
  # that changed.
  module Reader
    # No selection marker: the terminal cursor already marks the focused
    # line, and a screen reader / braille display tracks it there. A printed
    # marker would only add a column of noise to every line and shift the
    # text.
    GUTTER      = 0
    HEADER_ROWS = 4 # title line, address line, hint line, blank line
    FOOTER_ROWS = 2 # blank + status line
    TITLE_ROW   = 1
    ADDRESS_ROW = 2
    HINT_ROW    = 3

    SOURCE_LABELS = {
      "ax"      => "AX",
      "render"  => "PAGE",
      "inspect" => "INSPECT",
      "source"  => "SOURCE",
    }
    LINK_ROLES = Set{"link"}

    # One span of a composite display line: a piece of one block, with the
    # columns it occupies and, for a numbered field, the number it keeps.
    class Span
      property start : Int32
      property finish : Int32
      property block_index : Int32
      # The number a numbered field or link keeps, as the layout produced it —
      # a number for Lynx's own markers, a string where the page said so.
      property display_number : JSON::Any?

      def initialize(@start, @finish, @block_index, @display_number = nil)
      end
    end

    class Line
      property text : String
      property block_index : Int32
      property spans : Array(Span)?
      property continuation : Bool
      property display_number : JSON::Any?
      property display_indent : Int32
      property display_prefix : String
      property display_suffix : String

      def initialize(@text, @block_index = 0, @spans = nil, @continuation = false,
                     @display_indent = 0, @display_prefix = "", @display_suffix = "",
                     @display_number = nil)
      end
    end

    class Buffer
      property text : String
      property caret : Int32

      def initialize(@text = "", @caret = 0)
      end
    end

    class Typing
      property item : JSON::Any
      property text : String
      property caret : Int32
      # What the field's line last showed, so a keystroke can patch the row
      # instead of rewriting it.
      property drawn : String?

      def initialize(@item, @text = "", @caret = 0, @drawn = nil)
      end
    end

    class AddressBar
      property text : String
      property caret : Int32
      property scroll : Int32

      def initialize(@text = "", @caret = 0, @scroll = 0)
      end
    end

    class Auth
      property challenge : JSON::Any
      property refused : Bool
      property stage : String
      property user : Buffer
      property password : Buffer

      def initialize(@challenge, @refused = false, @stage = "user")
        @user = Buffer.new
        @password = Buffer.new
      end
    end

    class Find
      property direction : Int32
      property text : String
      property caret : Int32

      def initialize(@direction = 1, @text = "", @caret = 0)
      end
    end

    class LinePrompt
      property label : String
      property buffer : Buffer

      def initialize(@label, @buffer = Buffer.new)
      end
    end

    class Drawn
      property title : String?
      property address : String?
      property address_caret_col : Int32?
      property hint : String?
      property status : String?

      def initialize
        @title = nil
        @address = nil
        @address_caret_col = nil
        @hint = nil
        @status = nil
      end
    end

    # The page, as the key handlers see it. The browser is outside the
    # reader; the loop hands in whatever answers these, and the handlers
    # neither know nor care which driver is behind it.
    module PageEnv
      abstract def url : String
      abstract def title : String
      # One key into the page's own keyboard. Raises when the page or the
      # driver refuses; the caller says so on the status row.
      abstract def keyboard_press(key : String) : Nil
      # Waits for the document to settle after a key that may navigate —
      # Enter submitting a form, chiefly. A page that refuses to say
      # anything is not an error; the refresh that follows reads whatever
      # document is there by then.
      abstract def wait_for_load : Nil
      # Go somewhere. Raises when the navigation is refused; the fault is
      # the caller's to classify and say.
      abstract def goto(url : String) : Nil
      # Asks the engine to stop loading. Best effort: a page already gone
      # is not an error worth reporting.
      abstract def stop_loading : Nil
      # Read the same address again, with or without the cache.
      abstract def reload(ignore_cache : Bool) : Nil
      abstract def history_identity : String
      abstract def history_go(direction : Int32) : Bool
    end

    # Tab ownership sits beside the page interface rather than in the key
    # handler. The browser-backed loop and the scripted harness both provide
    # this small inventory, so switching a tab changes the page subsequent
    # keys act on instead of merely changing one invocation's local value.
    module TabEnv
      abstract def current_page : PageEnv
      abstract def next_tab(direction : Int32) : PageEnv?
      abstract def tab_after(page : PageEnv) : PageEnv?
      abstract def adopt_tab(page : PageEnv) : Nil
      abstract def new_tab : PageEnv
      abstract def close_tab(page : PageEnv) : Nil
      abstract def tab_position(page : PageEnv) : NamedTuple(position: Int32, of: Int32)
      abstract def tab_label(page : PageEnv) : String
    end

    module LibraryEnv
      abstract def read(kind : String) : Array(JSON::Any)
      abstract def save(url : String, title : String) : JSON::Any
      abstract def delete(entry : JSON::Any) : Nil
    end

    module CredentialEnv
      abstract def remember(url : String, username : String, password : String) : Nil
      abstract def reconsider : Nil
    end

    # One control a dialog offers, flattened to what the reader needs of it:
    # the name to show, and for an option whether the option is ticked. The
    # three states travel together because which button the dialog itself has
    # ready is read from them rather than assumed.
    record DialogControl,
      name : String,
      checked : Bool = false,
      focused : Bool = false,
      is_default : Bool = false

    # What a dialog is about where that lives in a control rather than in the
    # dialog's words: the username and the already-masked password a "Save
    # password?" prompt is offering to keep.
    record DialogField, name : String, value : String

    # A question the browser drew for itself, as the key handlers see it.
    #
    # The real one is a `NativePrompt::Request` over the accessibility bus;
    # the conformance harness implements the same interface from its payload,
    # and the handlers cannot tell the difference — which is the point.
    #
    # Controls are addressed by index rather than handed back, because the
    # index is the one thing a scripted dialog and a real one can both mean
    # the same by.
    module DialogEnv
      abstract def role : String
      abstract def title : String
      abstract def lines : Array(String)
      abstract def buttons : Array(DialogControl)
      abstract def toggles : Array(DialogControl)
      abstract def fields : Array(DialogField)

      # Press one of `buttons`, answering with whether the press went in.
      abstract def press(index : Int32) : Bool

      # Tick or untick one of `toggles`, answering with what the option is
      # now according to the browser, or nil when the browser would not say.
      abstract def toggle(index : Int32) : Bool?

      # The same question, read again, or nil when it cannot be read.
      abstract def reread : DialogEnv?

      # Whether the browser is still asking.
      abstract def still_open? : Bool
    end

    # Which button the dialog would press if the dialog were answered without
    # being read. Chrome focuses Cancel on Chrome's install prompt and marks
    # Cancel the default; the save-password prompt focuses Save. So the answer
    # is read rather than invented, and it is reported rather than pressed.
    def self.dialog_default_button(buttons : Array(DialogControl)) : DialogControl?
      buttons.find(&.is_default) || buttons.find(&.focused)
    end

    # A page-touching operation outlived its budget. The core's own timeouts
    # raise this (the browser-side source of it is the same in JavaScript:
    # core.js's ActionTimeout). Activation says how long it gave the page
    # before giving up, because "error" would read as the reader's mistake
    # when it is the page's.
    class ActionTimeout < Exception
    end

    # The core, as the key handlers see it: the buffer, the popup the page
    # has open, the live-update switches, and the operations a keystroke can
    # set in motion. The terminal loop binds this to the real core; the
    # conformance harness binds it to a scripted one, and the handlers
    # cannot tell the difference — which is the point.
    module CoreEnv
      # The element a place was taken on is held by whatever implements this,
      # because the view being entered can only be asked about the element
      # once its own extraction has run. See Place.capture_place.
      include Place::Elements

      abstract def source : String
      # Switching views is the one thing that writes the core's view, and it
      # writes it between the place capture and the rebuild.
      abstract def source=(value : String) : Nil
      abstract def blocks : Array(JSON::Any)
      abstract def at(index : Int32) : Nil
      abstract def mark_input : Nil
      abstract def popup : JSON::Any?
      abstract def popup_at : Int64
      abstract def forget_popup : Nil
      abstract def activate(item : JSON::Any) : JSON::Any
      abstract def rescan : Nil
      abstract def anchor : JSON::Any
      abstract def restore(saved : JSON::Any) : Int32
      abstract def reanchor(saved : JSON::Any) : JSON::Any
      abstract def snapshot_cost_ms : Int64
      abstract def live : JSON::Any?
      abstract def set_live_snapshot_cost(ms : Int64) : Nil

      # -- activation ---------------------------------------------------

      # The fragment an item's href points at, when it is one.
      abstract def fragment_of(item : JSON::Any) : JSON::Any?
      # Whether the browser could give the control the keyboard. A slider is
      # driven by keystrokes, so adjustment needs focus first.
      abstract def focus_control(item : JSON::Any) : Bool
      abstract def attach_files(item : JSON::Any, paths : Array(String)) : Bool
      # A native select's entries, read off the element, or nil when the
      # control is not one.
      abstract def options_for(item : JSON::Any) : JSON::Any?
      # Focus an editable field and read what is already in it, or nil when
      # the control cannot take typed text at all.
      abstract def field_for_typing(item : JSON::Any) : JSON::Any?
      abstract def choose_option(control : JSON::Any, index : Int32) : JSON::Any
      # If this control says it opens something, follow it: the thing it
      # opens is very often rendered at the end of the document.
      abstract def follow_popup(controls : String?) : Nil
      # Which parts of the page an action changed, so a button that rewrote
      # something far from the cursor is not silent.
      abstract def note_changes(previous_texts : Array(String)) : Array(JSON::Any)
      abstract def block_at_fragment(hash : String) : Int32

      # -- the open dropdown --------------------------------------------

      # The open dropdown: where its entries start, how many are shown, the
      # filter they were shown under.
      abstract def chooser : JSON::Any?
      abstract def open_chooser(at : Int32, listing : JSON::Any) : Nil
      abstract def close_chooser : Nil
      # Re-draws the entries honouring a new filter, and says how many
      # survive it.
      abstract def show_chooser(filter : String) : Int32

      # -- focus observation around one activation -----------------------
      #
      # A page can implement a skip link by focusing its destination instead
      # of navigating to it. The URL then says nothing happened, while a
      # graphical browser follows the new focus. The watch is armed against
      # the element Enter is about to activate; the poll after the activation
      # answers where focus went, and the resolution turns that into a block
      # of this view.

      abstract def watch_activation_focus(item : JSON::Any) : JSON::Any?
      # The activation raised before anything was pressed: disarm, don't
      # follow.
      abstract def cancel_activation_focus(watch : JSON::Any) : Nil
      abstract def activation_focus(watch : JSON::Any) : JSON::Any?
      abstract def focus_destination_block(focused : JSON::Any) : Int32
      # A navigation leaves the watched destination pointing at the old
      # document; only the disposal is still owed.
      abstract def drop_focus_destination(focused : JSON::Any) : Nil

      # -- the field being typed into ------------------------------------

      # The field's live text and caret, read straight from the DOM after a
      # keystroke. The handle is the core's; the reader only reads through
      # it. Nil when there is no field being typed into.
      abstract def read_typing_field : JSON::Any?
      # Leaving the field: its handle is disposed of and forgotten.
      abstract def release_typing_field : Nil
      # One keyboard command to an already-focused adjustable control. The
      # answer says whether the page changed, and whether the adjustment had
      # to be made through the control's visual geometry because it ignored
      # the standard key.
      abstract def adjust_control(item : JSON::Any, key : String) : JSON::Any

      # -- the browse map -----------------------------------------------

      # Whether asking a lazy feed for more has already been tried and
      # answered no.
      abstract def no_more_to_load : Bool
      # Ask a lazy feed for more once, restoring its scroll if nothing
      # arrives. The answer says whether the page grew.
      abstract def ask_for_more : JSON::Any
      # Putting the reader back after a rebuild the reader asked for: the
      # anchor first, then the text the buffer used to hold.
      abstract def reanchor_with_texts(saved : JSON::Any, previous_texts : Array(String)) : JSON::Any
      # A click the browser treats as a person's, above content, where the
      # events are trusted and carry user activation.
      abstract def can_real_click : Bool
      abstract def real_click(item : JSON::Any) : JSON::Any
      # The pointer put somewhere, pressing nothing.
      abstract def can_hover : Bool
      abstract def hover(item : JSON::Any) : JSON::Any
      # A link handed to the browser's own download manager.
      abstract def download_link(item : JSON::Any) : JSON::Any
      # Which parts of the page have changed, in document order, for the
      # change-to-change walking.
      abstract def change_targets : Array(JSON::Any)
      abstract def change_index : Int32
      abstract def change_index=(value : Int32) : Nil

      # Which browser engine the core drives, said when a driver cannot do
      # something the reader asked for.
      abstract def driver_name : String
    end

    # The pieces of the core the drawing needs: which view the blocks came
    # from, the blocks themselves, and where the reader is told to be. The
    # `at` calls are recorded, not delivered: across the conformance boundary
    # they are the answer to "where did the reader's cursor land". The
    # scripted answers — what a rescan finds, what an anchor restores — are
    # fields the harness fills, so the same class plays the core in tests.
    class CoreState
      include CoreEnv

      # The open dropdown, kept live: open_chooser splices its entries into
      # the block list, show_chooser re-splices under a filter. It mirrors
      # src/core.js's own chooser (and the real Core's) exactly, because the
      # choose-mode keys read the entries back out of the block list.
      class ScriptedChooser
        property block_index : Int32
        property at : Int32
        property count : Int32
        property filter : String
        property shown : Array(Int32)
        property options : Array(JSON::Any)
        property multiple : Bool

        def initialize(@block_index, @options, @multiple)
          @at = @block_index + 1
          @count = 0
          @filter = ""
          @shown = [] of Int32
        end
      end

      getter source : String
      property blocks : Array(JSON::Any)
      property popup : JSON::Any?
      property popup_at : Int64
      property at_calls : Array(Int64)
      property input_marks : Int32
      property activated : Array(JSON::Any)
      property attached_calls : Array(JSON::Any)
      property followed_popups : Array(String?)
      # Scripted answers, for the conformance harness.
      property rescan_blocks : Array(JSON::Any)?
      # A view whose extractor refuses: the switch must leave the reader the
      # view they already had rather than an empty buffer.
      property rescan_failure : JSON::Any?
      property rescan_cost : Int64
      property anchor_json : JSON::Any?
      property restore_block : Int32
      property activated_status : JSON::Any?
      property activation_failure : JSON::Any?
      property live : JSON::Any?
      property snapshot_cost : Int64
      property reanchored : JSON::Any?
      property fragment : JSON::Any?
      property focus_control_ok : Bool
      property listing : JSON::Any?
      property field_info : JSON::Any?
      property choose_outcome : JSON::Any?
      property choose_failure : JSON::Any?
      property changes : Array(JSON::Any)
      property fragment_block : Int32
      property watch_focus : Bool
      property focus_found : Bool
      property focus_block : Int32
      property scripted_chooser : ScriptedChooser?
      property typed_fields : Array(JSON::Any)
      property typed_field_reads : Int32
      property typing_released : Bool
      property adjust_outcome : JSON::Any?
      property adjust_failure : JSON::Any?
      property no_more_to_load : Bool
      property ask_more_outcome : JSON::Any?
      property ask_more_failure : JSON::Any?
      property can_real_click : Bool
      property real_click_outcome : JSON::Any?
      property can_hover : Bool
      property hover_outcome : JSON::Any?
      property download_outcome : JSON::Any?
      property change_targets : Array(JSON::Any)
      property change_index : Int32
      property driver_name : String
      # The place keeper's page side, scripted: what a capture is told about
      # the element, what a restore is told about where the element now is,
      # and whether resolving the element fails outright. The items described
      # and the arrays asked about are recorded, and so are the releases, so
      # a test can say the held element was let go of exactly once.
      property place_element : JSON::Any?
      property place_location : JSON::Any?
      property place_refuses : Bool
      property place_described : Array(JSON::Any)
      property place_arrays : Array(String)
      property place_releases : Int32
      # The blocks a rescan answers for each view, so a view switch under the
      # harness rebuilds the buffer the way a different extractor would.
      property source_blocks : Hash(String, Array(JSON::Any))

      def initialize(@source = "ax", @blocks = [] of JSON::Any,
                     @popup = nil, @popup_at = -1_i64)
        @at_calls = [] of Int64
        @input_marks = 0
        @activated = [] of JSON::Any
        @attached_calls = [] of JSON::Any
        @followed_popups = [] of String?
        @rescan_blocks = nil
        @rescan_failure = nil
        @rescan_cost = 0
        @anchor_json = nil
        @restore_block = -1
        @activated_status = nil
        @live = nil
        @snapshot_cost = 0
        @fragment = nil
        @focus_control_ok = true
        @listing = nil
        @field_info = nil
        @choose_outcome = nil
        @changes = [] of JSON::Any
        @fragment_block = -1
        @watch_focus = false
        @focus_found = false
        @focus_block = -1
        @typed_fields = [] of JSON::Any
        @typed_field_reads = 0
        @typing_released = false
        @adjust_outcome = nil
        @adjust_failure = nil
        @no_more_to_load = false
        @ask_more_outcome = nil
        @ask_more_failure = nil
        @can_real_click = true
        @real_click_outcome = nil
        @can_hover = true
        @hover_outcome = nil
        @download_outcome = nil
        @change_targets = [] of JSON::Any
        @change_index = -1
        @driver_name = "scripted"
        @place_element = nil
        @place_location = nil
        @place_refuses = false
        @place_described = [] of JSON::Any
        @place_arrays = [] of String
        @place_releases = 0
        @source_blocks = {} of String => Array(JSON::Any)
      end

      # The real core resolves the element, holds it, and disposes of the
      # handle it could not describe. The scripted one answers the same
      # shapes and counts that disposal as a release, so the release count
      # means the same thing on both sides of the differential.
      def describe_place_element(item : JSON::Any) : JSON::Any?
        @place_described << item
        raise IO::Error.new("this line carries no element reference") if @place_refuses
        described = @place_element
        unless described && !described.raw.nil?
          @place_releases += 1
          return nil
        end
        described
      end

      def locate_place_element(array_name : String) : JSON::Any?
        @place_arrays << array_name
        found = @place_location
        found && !found.raw.nil? ? found : nil
      end

      def release_place_element : Nil
        @place_releases += 1
      end

      def source=(value : String) : Nil
        @source = value
      end

      def at(index : Int32) : Nil
        @at_calls << index.to_i64
      end

      # The reader just did something; live refreshes hold off while this is
      # recent. Recorded, not timestamped: the conformance boundary compares
      # counts, and the real loop owns the clock.
      def mark_input : Nil
        @input_marks += 1
      end

      def forget_popup : Nil
        @popup = nil
      end

      def activate(item : JSON::Any) : JSON::Any
        @activated << item
        if failure = @activation_failure
          if failure.as_h["timeout"]?.try(&.as_bool?)
            raise ActionTimeout.new("Activating timed out after 6000ms")
          end
          raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) || "the activation failed")
        end
        @activated_status || JSON::Any.new(nil)
      end

      def fragment_of(item : JSON::Any) : JSON::Any?
        @fragment
      end

      def focus_control(item : JSON::Any) : Bool
        @focus_control_ok
      end

      def attach_files(item : JSON::Any, paths : Array(String)) : Bool
        @attached_calls << JSON::Any.new({
          "item"  => item,
          "paths" => JSON::Any.new(paths.map { |path| JSON::Any.new(path) }),
        })
        true
      end

      def options_for(item : JSON::Any) : JSON::Any?
        @listing
      end

      def field_for_typing(item : JSON::Any) : JSON::Any?
        @field_info
      end

      def choose_option(control : JSON::Any, index : Int32) : JSON::Any
        if failure = @choose_failure
          if failure.as_h["timeout"]?.try(&.as_bool?)
            raise ActionTimeout.new("Choosing timed out after 6000ms")
          end
          raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) || "the choice failed")
        end
        @choose_outcome || JSON::Any.new({"changed" => JSON::Any.new(true)})
      end

      def follow_popup(controls : String?) : Nil
        @followed_popups << controls
        @popup = controls && !controls.empty? ? JSON::Any.new({"controls" => JSON::Any.new(controls)}) : nil
      end

      def note_changes(previous_texts : Array(String)) : Array(JSON::Any)
        @changes
      end

      def block_at_fragment(hash : String) : Int32
        @fragment_block
      end

      def open_chooser(at : Int32, listing : JSON::Any) : Nil
        close_chooser
        object = listing.as_h? || {} of String => JSON::Any
        @scripted_chooser = ScriptedChooser.new(
          at,
          object["options"]?.try(&.as_a?) || [] of JSON::Any,
          object["multiple"]?.try(&.as_bool?) || false)
        show_chooser
      end

      def show_chooser(filter : String = "") : Int32
        chooser = @scripted_chooser || return 0
        chooser.filter = filter
        @blocks.delete_at(chooser.at, chooser.count) if chooser.count > 0

        needle = chooser.filter.strip.downcase
        shown = [] of Int32
        blocks = [] of JSON::Any
        chooser.options.each_with_index do |option, index|
          object = option.as_h? || {} of String => JSON::Any
          option_text = object["text"]?.try(&.as_s?) || ""
          next if !needle.empty? && !option_text.downcase.includes?(needle)
          selected = object["selected"]?.try(&.as_bool?) || false
          disabled = object["disabled"]?.try(&.as_bool?) || false
          shown << index
          blocks << JSON::Any.new({
            "text" => JSON::Any.new("    #{selected ? "(*)" : "( )"} #{option_text}" +
              (disabled ? " — unavailable" : "")),
            "item" => JSON::Any.new({
              "role"         => JSON::Any.new("option"),
              "name"         => JSON::Any.new(option_text),
              "chooserIndex" => JSON::Any.new(index.to_i64),
              "disabled"     => JSON::Any.new(disabled),
            }),
          })
        end
        blocks.each_with_index { |block, offset| @blocks.insert(chooser.at + offset, block) }
        chooser.count = blocks.size
        chooser.shown = shown
        blocks.size
      end

      def close_chooser : Nil
        if chooser = @scripted_chooser
          @blocks.delete_at(chooser.at, chooser.count) if chooser.count > 0
        end
        @scripted_chooser = nil
      end

      def chooser : JSON::Any?
        chooser = @scripted_chooser || return nil
        JSON::Any.new({
          "blockIndex" => JSON::Any.new(chooser.block_index.to_i64),
          "at"          => JSON::Any.new(chooser.at.to_i64),
          "count"       => JSON::Any.new(chooser.count.to_i64),
          "filter"      => JSON::Any.new(chooser.filter),
          "shown"       => JSON::Any.new(chooser.shown.map { |index| JSON::Any.new(index.to_i64) }),
          "options"     => JSON::Any.new(chooser.options),
          "multiple"    => JSON::Any.new(chooser.multiple),
        })
      end

      def watch_activation_focus(item : JSON::Any) : JSON::Any?
        @watch_focus ? JSON::Any.new({"token" => JSON::Any.new("watch")}) : nil
      end

      def cancel_activation_focus(watch : JSON::Any) : Nil
      end

      def activation_focus(watch : JSON::Any) : JSON::Any?
        @focus_found ? JSON::Any.new({"found" => JSON::Any.new(true)}) : nil
      end

      def focus_destination_block(focused : JSON::Any) : Int32
        @focus_block
      end

      def drop_focus_destination(focused : JSON::Any) : Nil
      end

      def read_typing_field : JSON::Any?
        @typed_field_reads += 1
        fields = @typed_fields
        return nil if fields.empty?
        index = Math.min(@typed_field_reads - 1, fields.size - 1)
        fields[index]
      end

      def release_typing_field : Nil
        @typing_released = true
      end

      def adjust_control(item : JSON::Any, key : String) : JSON::Any
        if failure = @adjust_failure
          if failure.as_h["timeout"]?.try(&.as_bool?)
            raise ActionTimeout.new("Adjusting timed out after 6000ms")
          end
          raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) || "the adjustment failed")
        end
        @adjust_outcome || JSON::Any.new({
          "changed"  => JSON::Any.new(true),
          "fallback" => JSON::Any.new(false),
        })
      end

      def no_more_to_load : Bool
        @no_more_to_load
      end

      def ask_for_more : JSON::Any
        if failure = @ask_more_failure
          raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) || "the page would not say")
        end
        @ask_more_outcome || JSON::Any.new({
          "grew"       => JSON::Any.new(false),
          "scrollable" => JSON::Any.new(false),
          "moved"      => JSON::Any.new(false),
          "target"     => JSON::Any.new("nothing"),
        })
      end

      def reanchor_with_texts(saved : JSON::Any, previous_texts : Array(String)) : JSON::Any
        @reanchored || JSON::Any.new({"block" => JSON::Any.new(-1_i64),
                                      "exact" => JSON::Any.new(false)})
      end

      def can_real_click : Bool
        @can_real_click
      end

      def real_click(item : JSON::Any) : JSON::Any
        @real_click_outcome || JSON::Any.new({"ok" => JSON::Any.new(true)})
      end

      def can_hover : Bool
        @can_hover
      end

      def hover(item : JSON::Any) : JSON::Any
        @hover_outcome || JSON::Any.new({"ok" => JSON::Any.new(true)})
      end

      def download_link(item : JSON::Any) : JSON::Any
        @download_outcome || JSON::Any.new({"ok" => JSON::Any.new(true)})
      end

      def change_targets : Array(JSON::Any)
        @change_targets
      end

      def change_index : Int32
        @change_index
      end

      def change_index=(value : Int32) : Nil
        @change_index = value
      end

      def driver_name : String
        @driver_name
      end

      def rescan : Nil
        if failure = @rescan_failure
          if views = failure.as_h["sources"]?.try(&.as_a?)
            if views.any? { |view| view.as_s == @source }
              raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) ||
                                  "native interactive extraction for #{@source} is not ported")
            end
          else
            raise IO::Error.new(failure.as_h["message"]?.try(&.as_s?) || "the rescan failed")
          end
        end
        if incoming = @source_blocks[@source]?
          @blocks = incoming
        elsif incoming = @rescan_blocks
          @blocks = incoming
        end
        @snapshot_cost = @rescan_cost
      end

      def anchor : JSON::Any
        @anchor_json || JSON::Any.new(nil)
      end

      def restore(saved : JSON::Any) : Int32
        @restore_block
      end

      def reanchor(saved : JSON::Any) : JSON::Any
        @reanchored || JSON::Any.new({"block" => JSON::Any.new(-1_i64),
                                      "exact" => JSON::Any.new(false)})
      end

      def snapshot_cost_ms : Int64
        @snapshot_cost
      end

      def set_live_snapshot_cost(ms : Int64) : Nil
        @snapshot_cost = ms
        return unless live_object = @live
        return unless hash = live_object.as_h?
        hash["snapshotCostMs"] = JSON::Any.new(ms)
      end
    end

    class State
      property rows : Int32
      property cols : Int32
      property interface : String
      property mode : String
      property title : String
      property escape_unicode : Bool
      property short_links : Bool
      property link_address : Bool
      property status_msg : String
      property cursor : Int32
      property col : Int32
      property scroll : Int32
      property lines : Array(Line)
      property drawn : Drawn
      property core : CoreEnv
      property tabs : TabEnv?
      property credentials : CredentialEnv?
      property browser_library : LibraryEnv?
      property history_places : Hash(String, JSON::Any)
      property keys : Keys::Keymap?
      property typing : Typing?
      property address : AddressBar?
      property auth : Auth?
      property find : Find?
      property line_prompt : LinePrompt?
      property files : JSON::Any?
      property library : JSON::Any?
      property dialog : JSON::Any?
      # The question on screen, and the question the reader walked away from
      # without answering. `dialog` holds what is drawn; these two hold what
      # can still be done about it, which is not a thing JSON can carry.
      property dialog_request : DialogEnv?
      property pending_dialog : DialogEnv?
      property options : JSON::Any?
      # The slider the control mode is adjusting, and the dropdown whose
      # entries are on screen: each mode's own record of what it is acting on.
      property controlling : JSON::Any?
      property chooser : JSON::Any?
      property last_find : Find?
      property page_keyboard_exit_until : Int64
      property visited_links : Array(JSON::Any)
      property page_log : Array(JSON::Any)
      # Lynx's number prompt: the text typed so far, where the reader was
      # when it opened, and the numbers on screen with the blocks they name.
      property link_number : JSON::Any?
      # The search engine an address that is not an address is given to;
      # nil is the default one.
      property search : String?
      # The views the reader can cycle through, in order. The cycle is what
      # the core can actually extract: a view whose extractor is not
      # available is not offered rather than answering another view's blocks
      # under its label. See Core::EXTRACTABLE_SOURCES.
      property sources : Array(String)
      # The view the SOURCE toggle comes back to, remembered when that
      # toggle leaves a presentation view for SOURCE.
      property presentation_source : String?
      # A load-more is already asking the page for more; a second request
      # would fight the first one's rebuild.
      property loading_more : Bool
      # The search engine an address that is not an address is given to;
      # nil is the default one.
      property search : String?

      def initialize
        @rows = 24
        @cols = 80
        @interface = "tawb"
        @mode = "browse"
        @title = ""
        @escape_unicode = false
        @short_links = false
        @link_address = true
        @status_msg = ""
        @cursor = 0
        @col = 0
        @scroll = 0
        @lines = [] of Line
        @drawn = Drawn.new
        @core = CoreState.new
        @tabs = nil
        @credentials = nil
        @browser_library = nil
        @history_places = {} of String => JSON::Any
        @keys = nil
        @typing = nil
        @address = nil
        @auth = nil
        @find = nil
        @line_prompt = nil
        @files = nil
        @library = nil
        @dialog = nil
        @dialog_request = nil
        @pending_dialog = nil
        @options = nil
        @controlling = nil
        @chooser = nil
        @last_find = nil
        @page_keyboard_exit_until = 0
        @visited_links = [] of JSON::Any
        @page_log = [] of JSON::Any
        @link_number = nil
        @search = nil
        @sources = ["ax"]
        @presentation_source = nil
        @loading_more = false
      end
    end

    def self.lynx_active?(state : State) : Bool
      state.interface == "lynx"
    end

    # A display number is whatever the layout put there: usually a number,
    # sometimes a page-provided string. Both are said the same way.
    private def self.json_display(value : JSON::Any?) : String
      return "" unless value
      raw = value.raw
      raw.is_a?(String) ? raw : raw.to_s
    end

    # What the screen shows, as display blocks: the core blocks passed through
    # the Lynx vocabulary when the Lynx profile is reading the page, escaped
    # when the terminal cannot show the page's own characters. Core's original
    # text is kept intact either way — it is what live patches, place
    # matching and activation resolve against — so the transform lands on
    # copies, and on the whole list at once while one of the browser's own
    # lists is open the answer is that list, untransformed.
    def self.display_blocks(state : State) : Array(JSON::Any)
      # Whether the page's own blocks are being shown, rather than one of the
      # browser's own lists, is what `active_blocks` decides: it falls through
      # to the core only when none of options, library and dialog is open.
      # That is asked directly rather than by comparing the list it returned
      # with `state.core.blocks`, because the interactive binding builds a
      # fresh JSON list from the core on every call and the identity never
      # held — so the Lynx vocabulary, numbering included, was never applied
      # to a real page.
      page_blocks = state.options.nil? && state.library.nil? && state.dialog.nil?
      blocks = active_blocks(state)
      if lynx_active?(state) && page_blocks
        preferences = state.keys.try(&.preferences) || {} of String => JSON::Any
        return LynxDisplay.blocks(blocks, preferences, state.escape_unicode)
      end
      return blocks unless state.escape_unicode && page_blocks
      blocks.map do |block|
        object = block.as_h
        copy = object.dup
        copy["text"] = JSON::Any.new(UnicodeEscape.escape(object["text"]?.try(&.as_s?)))
        JSON::Any.new(copy)
      end
    end

    private def self.line_from_layout(json : JSON::Any) : Line
      object = json.as_h
      spans = object["spans"]?.try(&.as_a?).try do |list|
        list.map do |span_json|
          span = span_json.as_h
          Reader::Span.new(
            (span["start"]?.try(&.as_i64?) || 0).to_i32,
            (span["end"]?.try(&.as_i64?) || 0).to_i32,
            (span["blockIndex"]?.try(&.as_i64?) || 0).to_i32,
            span["displayNumber"]?)
        end
      end
      Line.new(
        object["text"]?.try(&.as_s?) || "",
        (object["blockIndex"]?.try(&.as_i64?) || 0).to_i32,
        spans,
        object["continuation"]?.try(&.as_bool?) || false,
        (object["displayIndent"]?.try(&.as_i64?) || 0).to_i32,
        object["displayPrefix"]?.try(&.as_s?) || "",
        object["displaySuffix"]?.try(&.as_s?) || "",
        object["displayNumber"]?)
    end

    # Wrap the display blocks to the terminal's width and settle the cursor.
    def self.relayout(state : State) : Nil
      state.lines = Layout.lines(display_blocks(state), content_width(state)).map do |json|
        line_from_layout(json)
      end
      state.cursor = Math.max(state.lines.size - 1, 0) if state.cursor >= state.lines.size
      clamp_col(state)
      clamp_scroll(state)
    end

    # A view switch can turn one item near the top of a short semantic view
    # into an element hundreds of markup lines down in SOURCE. Merely clamping
    # the old scroll position puts that item on the terminal's last row. Keep
    # its screen row instead, just as screen-wise movement does, so changing
    # representation does not also make the reader's cursor jump around the
    # window.
    def self.preserve_viewport_row(state : State, row : Int32,
                                   height : Int32 = viewport_height(state)) : Nil
      wanted = Math.min(Math.max(row, 0), Math.max(height - 1, 0))
      max_scroll = Math.max(0, state.lines.size - height)
      state.scroll = Math.min(Math.max(0, state.cursor - wanted), max_scroll)
      sync_cursor(state)
    end

    # Page scrolling: a screen at a time, and the status row still names the
    # link the cursor lands on.
    def self.move_screen(output : Screen::Output, state : State, direction : Int32,
                         page_url : String, height : Int32 = viewport_height(state),
                         lines : Int32 = height - 1) : Nil
      step = Math.max(1, lines)
      last_line = Math.max(state.lines.size - 1, 0)
      max_scroll = Math.max(0, state.lines.size - height)
      target_cursor = Math.min(Math.max(state.cursor + direction * step, 0), last_line)
      target_scroll = Math.min(Math.max(state.scroll + direction * step, 0), max_scroll)
      return if target_cursor == state.cursor && target_scroll == state.scroll

      state.cursor = target_cursor
      state.scroll = target_scroll
      state.col = 0
      clamp_col(state)
      sync_cursor(state)
      draw_status(output, state, page_url)
      draw_list(output, state)
      park_cursor(output, state, page_url)
    end

    # A resize during reading: relayout to the new width, clear, and paint
    # everything again — the caches cannot say what a different width showed.
    def self.redraw_after_resize(output : Screen::Output, state : State,
                                 page_url : String) : Nil
      relayout(state)
      output.write("\e[2J")
      render(output, state, page_url, force: true)
    end

    # The text a line shows, as search and movement see it. Past the end of
    # the list there is no line and no text.
    def self.line_text(state : State, line_index : Int32) : String
      line = state.lines[line_index]?
      line ? line.text : ""
    end

    # The line a block starts on. Every block has one; a block index that is
    # not in this buffer at all answers -1.
    def self.line_for_block(state : State, block_index : Int32) : Int32
      return -1 if block_index < 0
      position = position_for_block(state, block_index)
      position ? position[:line] : -1
    end

    # Whether an optional value the wire may carry as JSON null is really
    # here. JSON::Any wrapping nil is not nil, and every "absent" check has
    # to see through the wrapper.
    def self.present?(value : JSON::Any?) : Bool
      value ? !value.raw.is_a?(Nil) : false
    end

    # One display line as JSON: the shape the layout handed over, which is
    # also the shape Place reads lines in and the shape the conformance
    # boundary compares them in.
    def self.line_json(line : Line) : JSON::Any
      entry = {
        "text"          => JSON::Any.new(line.text),
        "blockIndex"    => JSON::Any.new(line.block_index.to_i64),
        "continuation"  => JSON::Any.new(line.continuation),
        "displayNumber" => line.display_number || JSON::Any.new(nil),
        "displayIndent" => JSON::Any.new(line.display_indent.to_i64),
        "displayPrefix" => JSON::Any.new(line.display_prefix),
        "displaySuffix" => JSON::Any.new(line.display_suffix),
      } of String => JSON::Any
      if spans = line.spans
        entry["spans"] = JSON::Any.new(spans.map do |span|
          JSON::Any.new({
            "start"         => JSON::Any.new(span.start.to_i64),
            "end"           => JSON::Any.new(span.finish.to_i64),
            "blockIndex"    => JSON::Any.new(span.block_index.to_i64),
            "displayNumber" => span.display_number || JSON::Any.new(nil),
          })
        end)
      end
      JSON::Any.new(entry)
    end

    # What Place needs to describe or to find a place: the line list together
    # with the blocks and the view those lines were numbered against. The
    # core's view changes during a switch, so each end of the switch takes
    # its own snapshot rather than reading through the core afterwards.
    def self.view_of(state : State) : Place::View
      blocks = state.core.blocks.map do |block|
        object = block.as_h? || {} of String => JSON::Any
        Core::Block.new(object["text"]?.try(&.as_s?) || "",
          object["item"]? || JSON::Any.new(nil))
      end
      Place::View.new(state.lines.map { |line| line_json(line) }, blocks,
        state.cursor, state.col, state.core.source)
    end

    def self.restore_anchor(state : State, saved : JSON::Any?) : Nil
      return unless present?(saved)
      line = line_for_block(state, state.core.restore(saved.not_nil!))
      state.cursor = line if line >= 0
      state.col = 0
      clamp_scroll(state)
    end

    # The page's own words for itself, flattened the way a title row wants
    # them: any run of whitespace becomes one space, and the edges are gone.
    def self.read_title(page : PageEnv) : String
      page.title.gsub(/\s+/, " ").strip
    rescue
      "" # closed, navigating, or an engine that will not say
    end

    # A snapshot, a title, and the reader back on their place. This is what
    # every page-touching keystroke ends in; the anchor argument is the
    # place to keep, and asking for a reset throws the cursor to the top
    # when the document itself has changed.
    def self.refresh(state : State, page : PageEnv, reset_cursor : Bool = false,
                     anchor : JSON::Any? = nil) : Nil
      state.core.rescan
      state.title = read_title(page)
      LynxSession.note_page_visit(state, page.url, state.title)
      state.core.set_live_snapshot_cost(state.core.snapshot_cost_ms) if state.core.live
      if reset_cursor
        state.cursor = 0
        state.scroll = 0
        state.col = 0
      end
      relayout(state)
      restore_anchor(state, anchor) if present?(anchor)
    end

    # Re-anchoring for an update the reader did not ask for. Unlike
    # restore_anchor, it never falls back to a proportional guess: if the
    # line the reader was on has gone, staying put is far less disorienting
    # than being silently teleported somewhere proportional. Identity
    # first, then the nearest text match searched outward from the previous
    # position, then stay put — a live update must never relocate the
    # reader across the page.
    def self.reanchor_quietly(state : State, saved : JSON::Any?) : Nil
      return unless present?(saved)
      settled = state.core.reanchor(saved.not_nil!)
      line = line_for_block(state,
        (settled.as_h["block"]?.try(&.as_i64?) || -1).to_i32)
      state.cursor = line if line >= 0
      state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(state.lines.size - 1, 0))
      clamp_col(state)
      clamp_scroll(state)
    end

    # Where a block starts on screen: the line it begins on and the column
    # its text starts at, which for a reflowed paragraph or table row is the
    # column of its own span rather than the row's first column. A block that
    # is not in this buffer at all answers nil.
    def self.position_for_block(state : State,
                                block_index : Int32) : NamedTuple(line: Int32, col: Int32)?
      return nil if block_index < 0
      state.lines.each_with_index do |line, i|
        if spans = line.spans
          spans.each do |span|
            return {line: i, col: span.start} if span.block_index == block_index
          end
          next
        end
        next if line.continuation
        return {line: i, col: 0} if line.block_index == block_index
      end
      nil
    end

    # The first or last line/column an interactive item occupies, for the
    # jump-to-first/last-control commands. Wrapped rows are walked by span so
    # an item that starts on a continuation row is still found.
    def self.focusable_edge(state : State,
                            direction : Int32) : NamedTuple(line: Int32, col: Int32)?
      indexes = (0...state.lines.size).to_a
      indexes.reverse! if direction < 0
      indexes.each do |line_index|
        line = state.lines[line_index]
        if spans = line.spans
          ordered = direction > 0 ? spans : spans.reverse
          ordered.each do |span|
            item = state.core.blocks[span.block_index]?.try(&.as_h?).try(&.["item"]?)
            next unless item && focusable_item?(item)
            return {line: line_index, col: span.start}
          end
          next
        end
        next if line.continuation
        item = state.core.blocks[line.block_index]?.try(&.as_h?).try(&.["item"]?)
        next unless item && focusable_item?(item)
        return {line: line_index, col: 0}
      end
      nil
    end

    private def self.focusable_item?(item : JSON::Any) : Bool
      role = item.as_h["role"]?.try(&.as_s?)
      role ? Aria::FOCUSABLE_ROLES.includes?(role) : false
    end

    # Move the selection to a line and column, repainting only what changed.
    # This is the one movement everything goes through: a screen at a time
    # lands here too, and a one-line scroll is repaired with the terminal's
    # own scroll rather than a repaint, because one new line is cheaper than
    # a viewport and quieter than a screen reader re-reading all of it.
    def self.move_selection(output : Screen::Output, state : State, page_url : String,
                            new_cursor : Int32, new_col : Int32 = 0) : Nil
      target = Math.min(Math.max(new_cursor, 0), Math.max(state.lines.size - 1, 0))
      return if target == state.cursor && new_col == state.col

      old_cursor = state.cursor
      old_col = state.col
      old_scroll = state.scroll
      state.cursor = target
      state.col = new_col
      clamp_col(state)
      clamp_scroll(state)

      scrolled_by = state.scroll - old_scroll

      # Where the new line goes, if it goes anywhere. This is the one thing
      # outside the list area a move touches — the banner is left alone — and
      # it costs nothing on the keystrokes that do not change it. Drawn before
      # the cursor is placed, since reaching the status row means moving the
      # cursor there and back.
      draw_status(output, state, page_url)

      if scrolled_by == 0
        repaint_lynx_selection(output, state, old_cursor, old_col)
        Screen.move_cursor(output, line_row(state, target), cursor_col(state))
      elsif lynx_active?(state)
        # Scrolling moves the old highlight to another terminal row. Redrawing
        # is cheaper and less error-prone than trying to repair a multi-line
        # link on both sides of the scroll boundary.
        draw_list(output, state)
        park_cursor(output, state, page_url)
      elsif scrolled_by.abs == 1
        new_row = Screen.scroll_region(output, scrolled_by,
          HEADER_ROWS + 1, HEADER_ROWS + viewport_height(state))
        Screen.write_line(output, new_row, render_row(state, target))
        Screen.move_cursor(output, new_row, cursor_col(state))
      else
        draw_list(output, state)
        park_cursor(output, state, page_url)
      end
    end

    # Left and right move the caret within the line, and only then between
    # lines — the last column of one row joins the first of the next, the way
    # a text editor walks wrapped text.
    def self.move_caret_left(output : Screen::Output, state : State,
                             page_url : String) : Nil
      if state.col > 0
        return move_selection(output, state, page_url, state.cursor, state.col - 1)
      end
      return if state.cursor == 0
      previous = state.cursor - 1
      move_selection(output, state, page_url, previous,
        Math.max(line_text(state, previous).size - 1, 0))
    end

    def self.move_caret_right(output : Screen::Output, state : State,
                              page_url : String) : Nil
      line = current_line(state)
      last_col = line ? Math.max(line.text.size - 1, 0) : 0
      if state.col < last_col
        return move_selection(output, state, page_url, state.cursor, state.col + 1)
      end
      return if state.cursor >= state.lines.size - 1
      move_selection(output, state, page_url, state.cursor + 1, 0)
    end

    # The JavaScript original reads process.stdout; the state carries the
    # answer instead, so the conformance runner can be any size of window.
    def self.viewport_height(state : State) : Int32
      Math.max(1, state.rows - HEADER_ROWS - FOOTER_ROWS)
    end

    def self.content_width(state : State) : Int32
      Math.max(20, state.cols - GUTTER - 1)
    end

    def self.line_row(state : State, line_index : Int32) : Int32
      HEADER_ROWS + 1 + (line_index - state.scroll)
    end

    def self.is_visible(state : State, line_index : Int32) : Bool
      line_index >= state.scroll && line_index < state.scroll + viewport_height(state)
    end

    def self.current_line(state : State) : Line?
      state.lines[state.cursor]? || nil
    end

    # The blocks the screen is showing. Ordinarily the page's, but while one
    # of the browser's own lists is open it is that list: the buffer on
    # screen is no longer the tab, and everything that reads lines has to
    # agree about which.
    def self.active_blocks(state : State) : Array(JSON::Any)
      return [] of JSON::Any if state.options
      return blocks_of(state.library) if state.library
      return blocks_of(state.dialog) if state.dialog
      state.core.blocks
    end

    private def self.blocks_of(container : JSON::Any?) : Array(JSON::Any)
      found = container.try(&.as_h?).try(&.["blocks"]?)
      found.try(&.as_a?) || [] of JSON::Any
    end

    # The span of a composite display line the caret is standing in. A line
    # that came from only one core block has no spans and no answer here.
    def self.span_for_column(line : Line?, col : Int32) : Span?
      spans = line.try(&.spans)
      return nil unless spans && !spans.empty?
      chosen = spans.first
      spans.each do |span|
        chosen = span if span.start <= col
      end
      chosen
    end

    # The block under a caret on one line, whether that line is one block or
    # a reflowed paragraph/table row holding several.
    def self.block_under(state : State, line : Line?, col : Int32) : JSON::Any?
      index = block_under_index(state, line, col)
      index >= 0 ? active_blocks(state)[index]? : nil
    end

    # The same answer, as the position in the blocks the screen is showing.
    # Identity is what the JavaScript original compares; across the
    # conformance boundary an index is the same identity.
    def self.block_under_index(state : State, line : Line?, col : Int32) : Int32
      return -1 unless line
      span = span_for_column(line, col)
      if span
        return span.block_index < active_blocks(state).size ? span.block_index : -1
      end
      blocks = active_blocks(state)
      line.block_index < blocks.size ? line.block_index : -1
    end

    # The interactive item on a line. With one item per line there is no span
    # lookup to do — the whole line is the item — but text blocks are not
    # activatable.
    def self.item_at_offset(block : JSON::Any?) : JSON::Any?
      item = block.try(&.as_h?).try(&.["item"]?)
      return nil unless item
      return nil if item.as_h["role"]?.try(&.as_s?) == "text"
      item
    end

    def self.current_block(state : State) : JSON::Any?
      line = current_line(state)
      block_under(state, line, state.col)
    end

    def self.item_under_cursor(state : State) : JSON::Any?
      item_at_offset(current_block(state))
    end

    def self.cursor_col(state : State) : Int32
      GUTTER + state.col + 1
    end

    def self.clamp_col(state : State) : Nil
      line = current_line(state)
      max = line ? Math.max(line.text.size - 1, 0) : 0
      state.col = Math.min(Math.max(state.col, 0), max)
    end

    # Tell the core where the reader is, in the only currency it understands:
    # a block index. Every cursor movement settles through clamp_scroll,
    # which makes this the one place that has to say so. It is deliberately
    # one-way and unacknowledged; the worst a stale answer can cost is one
    # refused text patch.
    def self.sync_cursor(state : State) : Nil
      # A block index only means something to the core while the buffer is
      # the page. With a list of bookmarks on screen, line 12 is the twelfth
      # bookmark, and telling the core the reader is standing on the page's
      # twelfth block would let a text patch land where they are not.
      return if state.options || state.library || state.dialog
      line = state.lines[state.cursor]?
      # The index itself, not a block handed back to Array#index: JavaScript
      # compares blocks by identity, and JSON::Any compares by value, so two
      # blocks that read the same would answer the first one's position.
      state.core.at(block_under_index(state, line, state.col))
    end

    def self.clamp_scroll(state : State) : Nil
      height = viewport_height(state)
      max_scroll = Math.max(0, state.lines.size - height)
      if state.cursor < state.scroll
        state.scroll = state.cursor
      elsif state.cursor >= state.scroll + height
        state.scroll = state.cursor - height + 1
      end
      state.scroll = Math.min(Math.max(state.scroll, 0), max_scroll)
      sync_cursor(state)
    end

    def self.page_text(state : State, text : String?) : String
      return UnicodeEscape.escape(text) if state.escape_unicode
      text || ""
    end

    # ------------------------------------------------------------------
    # Drawing
    # ------------------------------------------------------------------

    # The page's title, on the first row of the window. Read when the buffer
    # is rebuilt rather than on every keystroke: the banner is meant to stay
    # untouched while reading.
    def self.draw_title(output : Screen::Output, state : State, force = false) : Nil
      rendered = page_text(state, state.title)[0, state.cols]
      return if !force && rendered == state.drawn.title
      state.drawn.title = rendered
      Screen.write_line(output, TITLE_ROW, rendered)
    end

    # The address row is the tab's own address and nothing else. Where the
    # link under the cursor goes is a different question and belongs on the
    # status line.
    def self.address_text(state : State, page_url : String) : String
      return state.address.try(&.text) || "" if state.mode == "address"
      page_url
    end

    # The address is one line and URLs are routinely longer than the terminal
    # is wide, so it scrolls horizontally around the caret instead of
    # wrapping.
    def self.draw_address(output : Screen::Output, state : State, page_url : String,
                          force = false, edit = false) : Nil
      label = "[#{SOURCE_LABELS[state.core.source]? || state.core.source}] "
      width = Math.max(10, state.cols - label.size)
      full = address_text(state, page_url)

      view = full
      caret_offset = 0

      if state.mode == "address" && (bar = state.address)
        caret = bar.caret
        if caret < bar.scroll
          bar.scroll = caret
        elsif caret >= bar.scroll + width
          bar.scroll = caret - width + 1
        end
        bar.scroll = Math.max(0, Math.min(bar.scroll, Math.max(0, full.size - width + 1)))
        view = full[bar.scroll, Math.min(width, full.size - bar.scroll)]
        caret_offset = caret - bar.scroll
      elsif full.size > width
        view = full[0, width - 1] + ">"
      end

      rendered = label + view
      previous = state.drawn.address
      caret_col = label.size + caret_offset + 1
      previous_caret_col = state.drawn.address_caret_col
      cursor_placed = false
      # force means the row is written however it reads: a full repaint
      # cannot assume the row still says what was last drawn on it, since
      # another screen (the keyboard wizard now shares this one) may have
      # written over it.
      rewrite = rendered != previous || (force && !(state.mode == "address" && edit))
      if rewrite
        state.drawn.address = rendered
        if !force && state.mode == "address" && !previous.nil?
          cursor_placed = Screen.patch_edited_line(output, ADDRESS_ROW, previous, rendered,
            current_col: edit ? previous_caret_col : nil,
            final_col: caret_col)
        else
          Screen.write_line(output, ADDRESS_ROW, rendered)
        end
      elsif state.mode == "address" && edit
        cursor_placed = Screen.patch_edited_line(output, ADDRESS_ROW, rendered, rendered,
          current_col: previous_caret_col,
          final_col: caret_col)
      end

      if state.mode == "address"
        state.drawn.address_caret_col = caret_col
        Screen.move_cursor(output, ADDRESS_ROW, caret_col) unless cursor_placed
      else
        state.drawn.address_caret_col = nil
      end
    end

    def self.popup_is_open(state : State) : Bool
      !state.core.popup.nil? && state.core.popup_at >= 0
    end

    def self.action_key_label(state : State, id : String, fallback = "") : String
      keys = state.keys
      return fallback unless keys
      action = keys.by_id[id]?
      binding = action.try(&.bindings).try(&.first?)
      binding ? keys.display(binding) : fallback
    end

    def self.hint_text(state : State) : String
      mode = state.mode
      if mode == "address"
        return "Address — Enter: go  Esc: cancel"
      elsif mode == "type"
        if lynx_active?(state)
          return "Enter text. Use arrows or Tab to move off of field."
        end
        return "Typing — Tab: next control  Esc: stop  Enter: submit"
      elsif mode == "field-command"
        return "Command: press one Lynx browse key  Esc: cancel"
      elsif mode == "forms"
        return "Forms — Tab: next control  Enter: activate  Esc: browse"
      elsif mode == "control"
        return "Control — arrows adjust  Home/End  Esc: stop"
      elsif mode == "page"
        return "Webpage keyboard — every other key goes to the page  " +
          action_key_label(state, "page-keyboard", "Alt+K") + ": stop"
      elsif mode == "find"
        return "Find — Enter: search  Esc: cancel"
      elsif mode == "number"
        return "Follow link number — Enter: follow  g: move  Esc: cancel"
      elsif mode == "choose"
        return "Choosing — j/k: move  type: filter  Enter: choose  Esc: cancel"
      elsif mode == "library"
        label = state.library.try(&.as_h).try(&.["label"]?.try(&.as_s?)) || ""
        return "#{label} — type: filter  Enter: open  Esc: close"
      elsif mode == "line"
        return "#{state.line_prompt.try(&.label)} — Enter: save  Esc: cancel"
      elsif mode == "files"
        done = ""
        if files = state.files
          multiple = files.as_h["multiple"]?.try(&.as_bool?) || false
          chosen = files.as_h["chosen"]?.try(&.as_a?)
          if multiple && chosen && !chosen.empty?
            done = "  Enter on an empty line: done"
          end
        end
        return "Attach a file — Tab: complete  Enter: attach#{done}  Esc: cancel"
      elsif mode == "dialog"
        return "The browser is asking — Enter: press  Esc: leave it unanswered"
      elsif mode == "auth"
        auth = state.auth
        refused = auth && auth.refused ? "Password refused. " : ""
        origin = auth ? describe_challenge(auth.challenge) : ""
        return "#{refused}Sign in to #{origin} — Enter: next  Esc: cancel"
      elsif lynx_active?(state)
        if popup_is_open(state)
          return "Popup open — q or Left closes it; Enter chooses."
        end
        return "Commands: Use arrow keys to move, '?' for help, 'q' to quit, '<-' to go back."
      elsif popup_is_open(state)
        return "Popup open — q or Esc closes it; Enter chooses."
      else
        return "j/k line  h/l/f/b/n/p nav  / find  m click  \\ view  ^L address  c changes  q quit"
      end
    end

    # Deliberately carries no line counter. A position indicator here would
    # change on every keystroke and force the banner to be repainted along
    # with it, which is the churn the split exists to avoid. Press '=' when
    # the position is actually wanted.
    def self.draw_hint(output : Screen::Output, state : State, force = false) : Nil
      # The options screen owns the whole terminal and has no hint row of its
      # own; writing one would land on a row of Lynx's screen.
      return if state.mode == "options"
      rendered = hint_text(state)[0, state.cols]
      return if !force && rendered == state.drawn.hint
      state.drawn.hint = rendered
      Screen.write_line(output, HINT_ROW, rendered)
    end

    def self.status_row(state : State) : Int32
      state.rows
    end

    # The one place the status row is written, so that what is on it is
    # always known — draw_status below will not repaint a row that already
    # says what it is about to say.
    def self.write_status_row(output : Screen::Output, state : State, text : String) : Nil
      # Status messages can repeat page-provided control names and carry ARIA
      # live announcements, so they belong to the escaped page presentation
      # too.
      rendered = page_text(state, text)[0, state.cols]
      state.drawn.status = rendered
      Screen.write_line(output, status_row(state), rendered)
    end

    def self.set_status(output : Screen::Output, state : State, page_url : String,
                        msg : String) : Nil
      state.status_msg = msg
      write_status_row(output, state, msg)
      park_cursor(output, state, page_url)
    end

    # The link the reader is standing on, and where it goes, said as the
    # reader arrives on it. Nothing at all when the reader has switched it
    # off. Only ever the page's own buffer: with one of the browser's own
    # lists open the lines on screen are bookmarks or history entries rather
    # than links on the page.
    def self.link_target(state : State, page_url : String) : String?
      return nil unless state.link_address
      return nil if state.library || state.dialog
      item = item_under_cursor(state)
      return nil unless item
      role = item.as_h["role"]?.try(&.as_s?) || ""
      return nil unless LINK_ROLES.includes?(role)
      href = item.as_h["href"]?.try(&.as_s?)
      return nil unless href
      state.short_links ? short_target(href, page_url) : href
    end

    # The same address, said the way a person would say it to someone already
    # standing on the page: a link from /a/b/c to /b is "/b", because the
    # host is the one they are on and repeating it says nothing. A link that
    # leaves the site is said in full — that it leaves is the most important
    # thing about it, and it is the host that carries that news. Same page,
    # different fragment, is shorter still: "#notes". Anything that will not
    # parse is handed back untouched rather than guessed at.
    def self.short_target(href : String, here : String) : String
      link = parse_uri(href) || return href
      page = parse_uri(here) || return href
      link_origin = origin_of(link)
      return href if link_origin == "null" || link_origin != origin_of(page)

      link_search = link.query ? "?#{link.query}" : ""
      page_search = page.query ? "?#{page.query}" : ""
      if link_path_of(link) == link_path_of(page) && link_search == page_search
        if link.fragment
          return "##{link.fragment}"
        end
        tail = "#{link_path_of(link)}#{link_search}"
        return tail.empty? ? "/" : tail
      end
      tail = "#{link_path_of(link)}#{link_search}#{link.fragment ? "##{link.fragment}" : ""}"
      tail.empty? ? "/" : tail
    end

    private def self.parse_uri(text : String) : URI?
      URI.parse(text)
    rescue
      nil
    end

    # A URL's pathname: JavaScript's URL always gives the root a "/", so the
    # answers say "/" where a bare host was meant.
    private def self.link_path_of(uri : URI) : String
      path = uri.path || ""
      return "/" if path.empty? && (uri.scheme == "http" || uri.scheme == "https")
      path
    end

    private def self.origin_of(uri : URI) : String
      scheme = uri.scheme.try(&.downcase) || ""
      host = uri.host || ""
      return "null" if host.empty? || (scheme != "http" && scheme != "https")
      port = uri.port
      default = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
      "#{scheme}://#{host}#{default || port.nil? ? "" : ":#{port}"}"
    end

    # Browse mode only: the find prompt, the sign-in prompt, the path prompt
    # and the one-line prompt are all drawn on this row and own it while they
    # are up. A message wins while it is news — set_status writes it whatever
    # the cursor is standing on — and the next move brings the link target
    # back. Nothing is written when the row already says it, which is most
    # keystrokes and is what keeps a screen reader from re-reading and a
    # braille display from re-flashing a row that did not change.
    def self.draw_status(output : Screen::Output, state : State, page_url : String) : Nil
      return unless state.mode == "browse"
      wanted = link_target(state, page_url) || state.status_msg
      rendered = page_text(state, wanted)[0, state.cols]
      return if rendered == state.drawn.status
      write_status_row(output, state, rendered)
    end

    def self.typing_text(state : State) : NamedTuple(text: String, caret_col: Int32)
      typing = state.typing.not_nil!
      value = page_text(state, typing.text)
      if lynx_active?(state)
        line = current_line(state)
        # On a merged table row the marker lives in the span, not on the
        # line, so the field being edited keeps the number it had in the row.
        span = nil
        if line && (spans = line.spans)
          span = spans.find do |one|
            block = active_blocks(state)[one.block_index]?
            block && block.as_h["item"]? == typing.item
          end
        end
        marker = span && span.display_number ? "[#{json_display(span.display_number)}]" : ""
        number = line ? " " * line.display_indent + marker + line.display_prefix : ""
        suffix = line ? line.display_suffix : ""
        name = typing.item.as_h["name"]?.try(&.as_s?) || ""
        label = number + (name.empty? ? "" : page_text(state, name) + " ")
        width = Math.max(20, value.size)
        shown = value[0, Math.min(width, value.size)]
        offset = state.escape_unicode ? UnicodeEscape.escaped_offset(typing.text, typing.caret) : typing.caret
        return {
          text:      label + shown + ("_" * Math.max(0, width - value.size)) + suffix,
          caret_col: GUTTER + label.size + offset + 1,
        }
      end
      name = typing.item.as_h["name"]?.try(&.as_s?) || ""
      label = "[#{page_text(state, name)}: "
      offset = state.escape_unicode ? UnicodeEscape.escaped_offset(typing.text, typing.caret) : typing.caret
      {
        text:      label + value + "]",
        caret_col: GUTTER + label.size + offset + 1,
      }
    end

    def self.render_row(state : State, line_index : Int32) : String
      if state.mode == "type" && line_index == state.cursor
        return typing_text(state)[:text]
      end
      line = state.lines[line_index]?
      text = line ? line.text : ""
      return text unless lynx_active?(state)

      selected = state.lines[state.cursor]?
      current = nil
      if line && (spans = line.spans) && !spans.empty? && selected
        current = current_block(state)
      end
      render_lynx_row(state, line, text, selected, current)
    end

    # One display row as Lynx's terminal would write it. Reverse video marks
    # the current control and bold marks a heading; the number marker is
    # outside the span and so outside the highlight, which is what keeps a
    # marker from being read as part of the thing it numbers.
    def self.render_lynx_row(state : State, line : Line?, text : String,
                             selected : Line?, current : JSON::Any?) : String
      indent = line ? " " * line.display_indent : ""
      prefix = indent + (line ? line.display_prefix : "")
      suffix = line ? line.display_suffix : ""

      spans = line.try(&.spans)
      if spans && !spans.empty?
        return lynx_row_text(line, text) unless current && lynx_focusable?(current)
        current_index = active_blocks(state).index(current) || -1
        pieces = [] of String
        at = 0
        spans.each do |span|
          next if span.block_index != current_index
          pieces << text[at...span.start] if span.start > at
          pieces << LynxDisplay::ANSI_REVERSE +
                    text[span.start...span.finish] + LynxDisplay::ANSI_RESET
          at = span.finish
        end
        return lynx_row_text(line, text) if pieces.empty?
        return prefix + pieces.join + text[at..] + suffix
      end

      block = line ? active_blocks(state)[line.block_index]? : nil
      # Lynx highlights every visible part of a wrapped current link.
      if line && selected && line.block_index == selected.block_index && lynx_focusable?(block)
        return "#{prefix}#{LynxDisplay::ANSI_REVERSE}#{text}#{LynxDisplay::ANSI_RESET}#{suffix}"
      end
      if block && block.as_h["item"]?.try(&.as_h["role"]?.try(&.as_s?)) == "heading"
        return "#{prefix}#{LynxDisplay::ANSI_BOLD}#{text}#{LynxDisplay::ANSI_RESET}#{suffix}"
      end
      lynx_row_text(line, text)
    end

    # One display row as plain text: the document margin, the number marker
    # and any suffix put back around the row's own text.
    def self.lynx_row_text(line : Line?, text : String) : String
      indent = line ? " " * line.display_indent : ""
      indent + (line ? line.display_prefix : "") + text + (line ? line.display_suffix : "")
    end

    def self.lynx_focusable?(block : JSON::Any?) : Bool
      item = block.try(&.as_h?).try(&.["item"]?)
      return false unless item
      role = item.as_h["role"]?.try(&.as_s?)
      return false unless role
      Aria::FOCUSABLE_ROLES.includes?(role)
    end

    # Repaints only the list region. No clear-screen: the header rows and the
    # status row are left exactly as they are. The scroll region is reset and
    # re-armed around the repaint so the header stays put and a single-line
    # step past an edge costs one new line instead of a repaint.
    def self.draw_list(output : Screen::Output, state : State) : Nil
      height = viewport_height(state)
      output.write("\e[r")
      (0...height).each do |i|
        line_index = state.scroll + i
        Screen.write_line(output, HEADER_ROWS + 1 + i,
          line_index < state.lines.size ? render_row(state, line_index) : "")
      end
      output.write("\e[#{HEADER_ROWS + 1};#{HEADER_ROWS + height}r")
    end

    # Who is asking, in the words the reader needs. The origin, not the page:
    # a challenge can come from an image or a frame belonging to somewhere
    # else entirely, and telling someone they must sign in to the site they
    # can see when the password is going somewhere else is the shape of every
    # credential-phishing trick there is.
    def self.describe_challenge(challenge : JSON::Any) : String
      object = challenge.as_h
      source = object["source"]?.try(&.as_s?) || ""
      origin = object["origin"]?.try(&.as_s?) || ""
      where = source == "proxy" ? "the proxy at #{origin}" : origin
      realm = object["realm"]?.try(&.as_s?) || ""
      scheme = object["scheme"]?.try(&.as_s?) || ""
      "#{where}#{realm.empty? ? "" : " — \"#{realm}\""}#{scheme.empty? ? "" : " (#{scheme})"}"
    end

    def self.auth_prompt_text(state : State) : NamedTuple(text: String, caret_col: Int32)
      auth = state.auth.not_nil!
      label = auth.stage == "user" ? "user: " : "password: "
      buffer = auth.stage == "user" ? auth.user : auth.password
      # A password is not echoed. The reader may be on a shared terminal, and
      # a terminal keeps scrollback.
      shown = auth.stage == "user" ? buffer.text : "*" * buffer.text.size
      {text: label + shown, caret_col: label.size + buffer.caret + 1}
    end

    def self.draw_auth_prompt(output : Screen::Output, state : State) : Nil
      prompt = auth_prompt_text(state)
      write_status_row(output, state, prompt[:text])
      Screen.move_cursor(output, status_row(state), Math.min(prompt[:caret_col], state.cols))
    end

    def self.find_prompt(state : State) : String
      find = state.find.not_nil!
      (find.direction > 0 ? "/" : "?") + find.text
    end

    def self.draw_find(output : Screen::Output, state : State) : Nil
      write_status_row(output, state, find_prompt(state))
      Screen.move_cursor(output, status_row(state),
        Math.min(state.find.not_nil!.caret + 2, state.cols))
    end

    def self.draw_line_prompt(output : Screen::Output, state : State) : Nil
      prompt = state.line_prompt.not_nil!
      text = "#{prompt.label}: #{prompt.buffer.text}"
      write_status_row(output, state, text)
      Screen.move_cursor(output, status_row(state),
        Math.min(prompt.label.size + 2 + prompt.buffer.caret + 1, state.cols))
    end

    # Whether the Lynx profile asks for the cursor to be hidden rather than
    # parked on the current item. Lynx's SHOW_CURSOR is documented for speech
    # and braille interfaces; with it off, Lynx leaves the cursor at the
    # bottom-right and marks the current link with reverse video instead.
    # Absent means Lynx's own default, which is to hide it.
    def self.lynx_hides_cursor(state : State) : Bool
      return false if state.interface != "lynx"
      preferences = state.keys.try(&.preferences)
      value = preferences.try(&.["showCursor"]?)
      !(preferences && value && value.as_bool?)
    end

    # Puts the terminal cursor back where the reader is.
    def self.park_cursor(output : Screen::Output, state : State, page_url : String) : Nil
      if state.mode == "auth"
        draw_auth_prompt(output, state)
        return
      end
      if state.mode == "address"
        draw_address(output, state, page_url)
        return
      end
      if state.mode == "find"
        draw_find(output, state)
        return
      end
      if state.mode == "field-command"
        Screen.move_cursor(output, status_row(state),
          Math.min(state.status_msg.size + 1, state.cols))
        return
      end
      if state.mode == "type"
        typing = typing_text(state)
        Screen.move_cursor(output, line_row(state, state.cursor), typing[:caret_col])
        return
      end
      # Browsing, with SHOW_CURSOR off: hide the cursor at the bottom-right
      # the way Lynx does. The current item is still marked by reverse video,
      # and the status row still names the link under it. Prompts, choosers,
      # lists and dialogs are drawn by their own code and keep the cursor
      # where it is.
      if state.mode == "browse" && lynx_hides_cursor(state)
        Screen.move_cursor(output, state.rows, state.cols)
        return
      end
      Screen.move_cursor(output, line_row(state, state.cursor), cursor_col(state))
    end

    def self.render(output : Screen::Output, state : State, page_url : String,
                    force = false) : Nil
      clamp_scroll(state)
      draw_title(output, state, force)
      draw_address(output, state, page_url, force)
      draw_hint(output, state, force)
      draw_list(output, state)
      write_status_row(output, state, state.status_msg) unless state.status_msg.empty?
      park_cursor(output, state, page_url)
    end

    # ------------------------------------------------------------------
    # Repainting after something the reader did
    # ------------------------------------------------------------------

    # The rows currently on screen, which is all a splice can have changed:
    # it kept the line count, so nothing scrolled. Rendering the whole buffer
    # for the comparison would cost more than the patch it is there to make
    # cheap. Sparse and indexed by line number, and only as wide as the
    # viewport — the buffer behind it can be 17,000 lines.
    def self.visible_rows_now(state : State) : Array(JSON::Any)
      height = viewport_height(state)
      rows = Array(JSON::Any).new(state.scroll + height, JSON::Any.new(nil))
      (0...height).each do |i|
        line_index = state.scroll + i
        rows[line_index] = JSON::Any.new(
          line_index < state.lines.size ? render_row(state, line_index) : "")
      end
      rows
    end

    # What is on screen now, so it can be compared with what is on screen
    # after.
    def self.screen_before(state : State) : JSON::Any
      JSON::Any.new({
        "rows"   => JSON::Any.new(visible_rows_now(state)),
        "scroll" => JSON::Any.new(state.scroll.to_i64),
        "height" => JSON::Any.new(viewport_height(state).to_i64),
      })
    end

    # The list area is redrawn the way a live update redraws it: only the
    # rows whose text actually changed. A repainted row is re-read by a
    # screen reader and re-flashed by a braille display whether or not it
    # says anything new, which is why live updates have always been careful
    # about it — and pressing Enter was not.
    def self.patch_visible_rows(output : Screen::Output, state : State,
                                page_url : String, previous : Array(JSON::Any)) : Int32
      height = viewport_height(state)
      repainted = 0
      (0...height).each do |i|
        line_index = state.scroll + i
        now = line_index < state.lines.size ? render_row(state, line_index) : ""
        # Past the end of the list both sides are empty; comparing against
        # nil here would repaint every blank row on every tick.
        before_value = previous[line_index]?
        before = before_value && !before_value.nil? ? before_value.as_s? || "" : ""
        next if now == before
        Screen.write_line(output, HEADER_ROWS + 1 + i, now)
        repainted += 1
      end
      park_cursor(output, state, page_url)
      repainted
    end

    # Repainting after something the reader did. It falls back to a full
    # repaint whenever a row-by-row comparison cannot mean anything: the view
    # scrolled, so every row moved; the terminal was resized under us; or
    # there is no record of what was on screen before. The answer is how many
    # rows were patched, or nil for a full repaint.
    def self.repaint_list(output : Screen::Output, state : State, page_url : String,
                          before : JSON::Any?) : Int32?
      draw_title(output, state)
      draw_address(output, state, page_url)
      draw_hint(output, state)

      if object = before.try(&.as_h?)
        scroll = object["scroll"]?.try(&.as_i64?).try(&.to_i32)
        height = object["height"]?.try(&.as_i64?).try(&.to_i32)
        if scroll == state.scroll && height == viewport_height(state)
          previous = object["rows"]?.try(&.as_a?) || [] of JSON::Any
          return patch_visible_rows(output, state, page_url, previous)
        end
      end

      draw_list(output, state)
      park_cursor(output, state, page_url)
      nil
    end

    # The Lynx selection is reverse video, and a move takes it off one row
    # and puts it on another. A composite paragraph or table row carries
    # several blocks, so a line index is not a block identity: repaint every
    # visible fragment of the old and new blocks, since an inline link can
    # wrap over several composite rows.
    def self.repaint_lynx_selection(output : Screen::Output, state : State,
                                    old_cursor : Int32, old_col : Int32) : Nil
      return unless lynx_active?(state)
      old_line = state.lines[old_cursor]?
      new_line = state.lines[state.cursor]?
      return unless old_line && new_line

      old_index = block_under_index(state, old_line, old_col)
      new_index = block_under_index(state, new_line, state.col)
      return if old_cursor == state.cursor && old_index == new_index

      if old_line.spans || new_line.spans
        changed = Set{old_index, new_index}
        end_line = Math.min(state.lines.size, state.scroll + viewport_height(state))
        (state.scroll...end_line).each do |line_index|
          line = state.lines[line_index]
          next unless (line.spans.try(&.any? { |span| changed.includes?(span.block_index) }))
          Screen.write_line(output, line_row(state, line_index), render_row(state, line_index))
        end
        return
      end

      return if old_line.block_index == new_line.block_index
      changed = Set(Int32).new
      changed << old_index if old_index >= 0 && lynx_focusable?(active_blocks(state)[old_index]?)
      changed << new_index if new_index >= 0 && lynx_focusable?(active_blocks(state)[new_index]?)
      return if changed.empty?

      end_line = Math.min(state.lines.size, state.scroll + viewport_height(state))
      (state.scroll...end_line).each do |line_index|
        block_index = state.lines[line_index].block_index
        next unless block_index < active_blocks(state).size && changed.includes?(block_index)
        Screen.write_line(output, line_row(state, line_index), render_row(state, line_index))
      end
    end
  end
end
