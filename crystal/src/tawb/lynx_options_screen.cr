require "./keys"
require "./lynx_display"
require "./lynx_options"

module Tawb
  # Lynx's single-screen Options menu, drawn and driven.
  #
  # `LynxOptions` owns the screen's model: which options exist, what they say,
  # and where each value sits. This module owns the interaction: the
  # reverse-video highlight, the Command prompt, where the terminal cursor is
  # left, the second keyboard layer while a value is being chosen, and saving.
  # It reaches the terminal only through the small host passed in, so the
  # terminal loop keeps its byte-level writes and this module keeps Lynx's
  # rules.
  module LynxOptionsScreen
    # Where the reader was standing when the screen opened, so leaving it is
    # not a second navigation.
    record Place, cursor : Int32, col : Int32, scroll : Int32, title : String

    # An option that has been chosen and not yet decided: its value is
    # provisional until RETURN keeps it, and its own copy of the preferences
    # is what a cancellation puts back. A class, because walking the choices
    # moves the index in place.
    class Choosing
      property index : Int32
      getter letter : String
      getter option : LynxOptions::Option
      getter original_preferences : Hash(String, JSON::Any)

      def initialize(@letter : String, @option : LynxOptions::Option, @index : Int32,
                     @original_preferences : Hash(String, JSON::Any)); end
    end

    class Options
      property choosing : Choosing?
      getter original_preferences : Hash(String, JSON::Any)
      property place : Place?

      def initialize(@original_preferences : Hash(String, JSON::Any), @place : Place?); end
    end

    # The reader state the screen touches. The interactive front end keeps the
    # rest — buffers, pages, the terminal — to itself and its host.
    class State
      property mode : String
      property keys : Keys::Keymap?
      property options : Options?
      property cursor : Int32
      property col : Int32
      property scroll : Int32
      property title : String
      property lines : Array(JSON::Any)
      property refreshing : Bool
      property settings_file : String?

      def initialize
        @mode = "browse"
        @keys = nil
        @options = nil
        @cursor = 0
        @col = 0
        @scroll = 0
        @title = ""
        @lines = [] of JSON::Any
        @refreshing = false
        @settings_file = nil
      end
    end

    # The terminal operations the screen asks for, exactly what the JavaScript
    # original reached through its host object.
    module Host
      abstract def reset_scroll_region : Nil
      abstract def write_line(row : Int32, text : String) : Nil
      abstract def move_cursor(row : Int32, col : Int32) : Nil
      abstract def clear_screen : Nil
      abstract def set_status(state : State, message : String) : Nil
      abstract def relayout(state : State) : Nil
      abstract def render(state : State, page, force : Bool) : Nil
      abstract def clamp_col(state : State) : Nil
      abstract def clamp_scroll(state : State) : Nil
      abstract def save_settings(state : State, settings : Hash(String, JSON::Any)) : Nil
      abstract def key_is(chunk : String, name : String, state : State) : Bool
    end

    def self.draw_options_screen(host : Host, state : State) : Nil
      choosing = state.options.try(&.choosing)
      lines = LynxOptions.screen_lines(preferences(state))
      host.reset_scroll_region
      lines.each_with_index do |line, row|
        host.write_line(row + 1, render_options_row(line, choosing))
      end
      host.write_line(lines.size + 1, LynxOptions::COMMAND_PROMPT)
      place_options_cursor(host, state, lines)
    end

    def self.render_options_row(line : LynxOptions::Line, choosing : Choosing?) : String
      field = choosing.try do |choice|
        line.fields.find { |candidate| candidate.letter == choice.letter }
      end
      return line.text unless field
      "#{line.text[0, field.start]}#{LynxDisplay::ANSI_REVERSE}" \
        "#{line.text[field.start, field.stop - field.start]}#{LynxDisplay::ANSI_RESET}" \
        "#{line.text[field.stop..]}"
    end

    # Where Lynx leaves the terminal cursor. With nothing being chosen it is
    # on the Command prompt. With a value being chosen it is one column left
    # of that value when SHOW_CURSOR is on, as Lynx does for speech and
    # braille — and after the value when it is off, because Lynx writes the
    # value and leaves the cursor where the write finished.
    def self.place_options_cursor(host : Host, state : State,
                                  lines : Array(LynxOptions::Line)? = nil) : Nil
      lines ||= LynxOptions.screen_lines(preferences(state))
      choosing = state.options.try(&.choosing)
      unless choosing
        host.move_cursor(lines.size + 1, LynxOptions::COMMAND_PROMPT.size + 1)
        return
      end
      at = LynxOptions.option_position(lines, choosing.letter)
      return unless at
      show = preferences(state)["showCursor"]?.try(&.as_bool?) || false
      host.move_cursor(at.row + 1, show ? Math.max(1, at.column) : at.field.stop + 1)
    end

    def self.open_options(host : Host, state : State, page) : Nil
      state.refreshing = true
      state.mode = "options"
      state.options = Options.new(
        preferences(state).dup,
        Place.new(state.cursor, state.col, state.scroll, state.title),
      )
      host.clear_screen
      draw_options_screen(host, state)
      host.set_status(state, "")
      place_options_cursor(host, state)
    end

    def self.close_options(host : Host, state : State, page, note : String?) : Nil
      place = state.options.not_nil!.place.not_nil!
      state.options = nil
      state.mode = "browse"
      state.refreshing = false
      state.title = place.title
      host.relayout(state)
      state.cursor = Math.min(place.cursor, Math.max(state.lines.size - 1, 0))
      state.col = place.col
      state.scroll = place.scroll
      host.clamp_col(state)
      host.clamp_scroll(state)
      host.clear_screen
      host.render(state, page, true)
      host.set_status(state, note) if note
    end

    def self.restore_option_preferences(state : State) : Nil
      set_preferences(state, state.options.not_nil!.original_preferences.dup)
    end

    # An option has been chosen and not yet decided: the value is provisional
    # until RETURN keeps it. This is the second keyboard layer of the Options
    # screen, and it belongs to the option rather than to the screen, which is
    # why it takes the keys that would otherwise be commands.
    #
    # A key the choice has no use for changes nothing: a reader who presses a
    # reading key here has not answered the question, and answering it for
    # them is how a preference changes by accident.
    def self.handle_option_choosing(host : Host, chunk : String, state : State, page) : Nil
      options = state.options.not_nil!
      choosing = options.choosing.not_nil!
      option = choosing.option
      count = option.choices.not_nil!.size

      if chunk == "\r" || chunk == "\n"
        options.choosing = nil
        draw_options_screen(host, state)
        host.set_status(state, LynxOptions::VALUE_ACCEPTED)
        place_options_cursor(host, state)
        return
      end
      if chunk == "q" || chunk == "Q" || chunk == "\u{3}" || chunk == "\u{7}" ||
         host.key_is(chunk, "Escape", state)
        set_preferences(state, choosing.original_preferences.dup)
        options.choosing = nil
        draw_options_screen(host, state)
        host.set_status(state, LynxOptions::CANCELLED)
        place_options_cursor(host, state)
        return
      end

      if option.boolean
        # Any key moves a boolean on to its other value. The arrow keys keep
        # their direction rather than only going forward, which is what Lynx
        # does.
        if host.key_is(chunk, "ArrowUp", state)
          choosing.index = (choosing.index + count - 1) % count
        else
          choosing.index = (choosing.index + 1) % count
        end
      elsif host.key_is(chunk, "ArrowDown", state) || chunk == " "
        choosing.index = (choosing.index + 1) % count
      elsif host.key_is(chunk, "ArrowUp", state)
        choosing.index = (choosing.index + count - 1) % count
      elsif host.key_is(chunk, "Home", state)
        choosing.index = 0
      elsif host.key_is(chunk, "End", state)
        choosing.index = count - 1
      else
        return
      end

      LynxOptions.apply_choice(option, preferences(state), choosing.index)
      draw_options_screen(host, state)
      host.set_status(state, option.boolean ? LynxOptions::ANY_KEY_CHANGE : LynxOptions::CHOICE_LIST)
      place_options_cursor(host, state)
    end

    def self.handle_options_key(host : Host, chunk : String, state : State, page) : Nil
      options = state.options.not_nil!
      return handle_option_choosing(host, chunk, state, page) if options.choosing

      if host.key_is(chunk, "ArrowLeft", state) || host.key_is(chunk, "Escape", state)
        restore_option_preferences(state)
        close_options(host, state, page, "Options unchanged.")
        return
      end
      if chunk == "r" || chunk == "R"
        close_options(host, state, page, "Options accepted for this session.")
        return
      end
      if chunk == ">"
        begin
          host.save_settings(state, LynxOptions.persistable_options(preferences(state)))
        rescue error
          host.set_status(state, "Could not save options: #{error.message.to_s.split('\n')[0]}")
          place_options_cursor(host, state)
          return
        end
        close_options(host, state, page, "Options saved.")
        return
      end

      option = LynxOptions.option_for_letter(chunk)
      return unless option
      unless option.choices
        # An option TAWB cannot honor still names itself, so the screen
        # behaves the same way and only the outcome differs.
        host.set_status(state, LynxOptions::NOT_CHANGEABLE)
        place_options_cursor(host, state)
        return
      end
      # Choosing an option is not changing it: the value shown becomes
      # provisional and the reader decides, which is the whole of what the
      # second layer is for.
      options.choosing = Choosing.new(
        option.letter, option,
        LynxOptions.choice_index(option, preferences(state)),
        preferences(state).dup,
      )
      draw_options_screen(host, state)
      host.set_status(state, option.boolean ? LynxOptions::ANY_KEY_CHANGE : LynxOptions::CHOICE_LIST)
      place_options_cursor(host, state)
    end

    private def self.preferences(state : State) : Hash(String, JSON::Any)
      state.keys.try(&.preferences) || {} of String => JSON::Any
    end

    private def self.set_preferences(state : State, values : Hash(String, JSON::Any)) : Nil
      state.keys.try { |keys| keys.preferences = values }
    end
  end
end
