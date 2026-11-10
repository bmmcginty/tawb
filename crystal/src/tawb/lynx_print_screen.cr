require "json"
require "uri"
require "./keys"
require "./lynx_display"

module Tawb
  # Lynx's Printing Options screen, and the one option TAWB implements.
  #
  # Real Lynx opens this screen from `p` (PRINT) and offers saving, mailing,
  # printing to the screen, and printing to a printer. TAWB keeps the same
  # screen and the same route to a file, but only offers the first of those:
  # saving the page as it is displayed. The screen is drawn directly, like the
  # Options menu, so its rows and cursor are the reader's screen rather than the
  # page list underneath it.
  module LynxPrintScreen
    TITLE = "              Printing Options (TAWB Lynx interface)"
    SAVE_LABEL = "   Save to a local file"
    INSTRUCTION = "Commands: Use arrow keys to move, '?' for help, 'q' to quit, '<-' to go back."
    ONLY_OPTION = "Save to a local file is the only print option TAWB offers."
    CANCELLED = "Printing cancelled."
    FILE_PROMPT_LABEL = "Enter a filename"
    PAGE_LINES = 66

    record Line, text : String, option : String?
    record Place, cursor : Int32, col : Int32, scroll : Int32, title : String

    # What the screen keeps between keystrokes. The terminal loop carries the
    # same scalars to its reader state through the host, as the Options screen
    # does, so this can be driven without a browser or a terminal in tests.
    class State
      property keys : Keys::Keymap?
      property mode : String
      property url : String
      property line_count : Int32
      property rows : Int32
      property cursor : Int32
      property col : Int32
      property scroll : Int32
      property title : String
      property selected : String?
      property place : Place?

      def initialize
        @keys = nil
        @mode = "browse"
        @url = ""
        @line_count = 0
        @rows = 24
        @cursor = 0
        @col = 0
        @scroll = 0
        @title = ""
        @selected = nil
        @place = nil
      end
    end

    module Host
      abstract def write_line(row : Int32, text : String) : Nil
      abstract def move_cursor(row : Int32, col : Int32) : Nil
      abstract def clear_screen : Nil
      abstract def reset_scroll_region : Nil
      abstract def set_status(state : State, message : String) : Nil
      abstract def relayout(state : State) : Nil
      abstract def render(state : State, page, force : Bool) : Nil
      abstract def clamp_col(state : State) : Nil
      abstract def clamp_scroll(state : State) : Nil
      abstract def key_is(chunk : String, name : String, state : State) : Bool
      abstract def rows : Int32
    end

    def self.page_count_for(line_count : Int32) : Int32
      count = Math.max(0, line_count)
      Math.max(1, (count + PAGE_LINES - 1) // PAGE_LINES)
    end

    def self.page_label(line_count : Int32) : String
      pages = page_count_for(line_count)
      "#{pages} page#{"s" unless pages == 1} (approximately)"
    end

    def self.screen_lines(state : State) : Array(Line)
      [
        Line.new(TITLE, nil),
        Line.new("", nil),
        Line.new("   Document: #{state.url}", nil),
        Line.new("   Number of lines: #{Math.max(0, state.line_count)}", nil),
        Line.new("   Number of pages: #{page_label(state.line_count)}", nil),
        Line.new("", nil),
        Line.new("Standard print options:", nil),
        Line.new(SAVE_LABEL, "save"),
        Line.new("", nil),
        Line.new("Local additions:", nil),
      ]
    end

    def self.option_row(lines : Array(Line)) : Int32
      lines.index { |line| line.option == "save" } || -1
    end

    def self.render_print_row(line : Line, selected : String?) : String
      return line.text unless line.option && line.option == selected
      "#{LynxDisplay::ANSI_REVERSE}#{line.text}#{LynxDisplay::ANSI_RESET}"
    end

    def self.draw_print_screen(host : Host, state : State) : Nil
      lines = screen_lines(state)
      host.reset_scroll_region
      lines.each_with_index do |line, row|
        host.write_line(row + 1, render_print_row(line, state.selected))
      end
      instruction_row = Math.max(lines.size + 1, state.rows - 1)
      host.write_line(instruction_row, INSTRUCTION)
      place_print_cursor(host, state, lines)
    end

    def self.place_print_cursor(host : Host, state : State,
                                lines : Array(Line)? = nil) : Nil
      lines ||= screen_lines(state)
      row = option_row(lines)
      return if row < 0
      text = lines[row].text
      first = text.index(/\S/) || 0
      host.move_cursor(row + 1, Math.max(1, first + 1))
    end

    def self.open_print(host : Host, state : State, page) : Nil
      state.mode = "print"
      state.place = Place.new(state.cursor, state.col, state.scroll, state.title)
      state.selected = "save"
      host.clear_screen
      draw_print_screen(host, state)
      host.set_status(state, "")
      place_print_cursor(host, state)
    end

    def self.close_print(host : Host, state : State, page, note : String?) : Nil
      place = state.place
      return unless place
      state.place = nil
      state.mode = "browse"
      state.title = place.title
      host.relayout(state)
      state.cursor = Math.min(place.cursor, Math.max(state.line_count - 1, 0))
      state.col = place.col
      state.scroll = place.scroll
      host.clamp_col(state)
      host.clamp_scroll(state)
      host.clear_screen
      host.render(state, page, true)
      host.set_status(state, note) if note
    end

    # What one key does on the Printing Options screen. Saving is handed back
    # to the caller because it needs a filename prompt, which owns the keyboard
    # and belongs with the reading loop rather than with this fixed screen.
    def self.handle_print_key(host : Host, chunk : String, state : State, page) : String?
      if chunk == "q" || chunk == "Q" ||
         host.key_is(chunk, "ArrowLeft", state) || host.key_is(chunk, "Escape", state)
        close_print(host, state, page, CANCELLED)
        return "close"
      end
      if chunk == "?" || chunk == "h" || chunk == "H"
        host.set_status(state, ONLY_OPTION)
        place_print_cursor(host, state)
        return nil
      end
      if host.key_is(chunk, "Enter", state) || host.key_is(chunk, "ArrowRight", state)
        return "save"
      end
      if host.key_is(chunk, "ArrowUp", state) || host.key_is(chunk, "ArrowDown", state)
        host.set_status(state, ONLY_OPTION)
        place_print_cursor(host, state)
      end
      nil
    end

    # The filename Lynx offers before the reader types: the address's last path
    # component, or the title when the address has none, in lower case with the
    # usual unsafe characters replaced. It always ends in .txt because what is
    # saved is text, not the original page.
    def self.save_filename(title : String, url : String) : String
      leaf = begin
        path = URI.parse(url).path || ""
        URI.decode(path.split('/').reject(&.empty?).last? || "")
      rescue
        ""
      end
      base = leaf.empty? ? title.strip : leaf
      base = base.sub(/\.[A-Za-z0-9]{1,8}\z/, "")
      base = base.downcase
        .gsub(/[^a-z0-9._-]+/, "-")
        .gsub(/-+/, "-")
        .gsub(/\A[-._]+|[-._]+\z/, "")
      base = "page" if base.empty?
      base.ends_with?(".txt") ? base : "#{base}.txt"
    end

    # The page as the reader sees it: the same margin, marker and suffix the
    # Lynx display puts around each row, with no terminal styling.
    def self.page_text(lines : Enumerable(String)) : String
      text = lines.join("\n")
      lines.empty? ? "" : "#{text}\n"
    end
  end
end
