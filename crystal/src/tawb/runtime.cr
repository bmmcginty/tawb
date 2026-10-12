require "json"
require "./input"
require "./key_wizard"
require "./screen"

module Tawb
  # Process and terminal ownership shared by normal exit, EOF, startup errors,
  # and signals. Cleanup is idempotent because a second Ctrl-C must not start
  # another browser shutdown while the first is still bounded.
  module Runtime
    # The terminal's own size, asked of the terminal.
    #
    # LINES and COLUMNS are not it: a shell knows its window's size but most
    # do not export it, so a reader that trusted those drew eighty columns by
    # twenty-four rows into every window whatever its size — half a screen on
    # an ordinary one. The kernel knows, and this is the call that asks it.
    lib Winsize
      struct WinSize
        row : LibC::UShort
        col : LibC::UShort
        xpixel : LibC::UShort
        ypixel : LibC::UShort
      end

      fun ioctl(fd : LibC::Int, request : LibC::ULong, size : WinSize*) : LibC::Int
    end

    # Linux's TIOCGWINSZ. A terminal that will not answer, or answers zero —
    # a pipe, a terminal mid-resize — leaves the environment and then the
    # conventional default to answer instead.
    TIOCGWINSZ = 0x5413_u64

    def self.terminal_size(fd : Int32 = STDOUT.fd) : NamedTuple(rows: Int32, cols: Int32)
      size = Winsize::WinSize.new
      if Winsize.ioctl(fd, TIOCGWINSZ, pointerof(size)) == 0
        rows = size.row.to_i32
        columns = size.col.to_i32
        return {rows: rows, cols: columns} if rows > 0 && columns > 0
      end
      {
        rows: ENV["LINES"]?.try(&.to_i32?) || 24,
        cols: ENV["COLUMNS"]?.try(&.to_i32?) || 80,
      }
    end
    def self.restore_invocation_directory(path : String?) : Bool
      return false unless path && Path[path].absolute?
      Dir.cd(path)
      true
    rescue
      false
    end

    class Terminal
      include Screen::Output

      getter generation : Int32

      def initialize(@output : IO = STDOUT, @input_fd : Int32 = STDIN.fd,
                     @alt_screen : Bool = true)
        @generation = 0
        @raw = nil.as(LibC::Termios?)
        @owned = false
        @alternate = false
      end

      def write(text : String) : Nil
        @output << text
        @output.flush
        @generation += 1
      end

      def acquire : Nil
        return if @owned
        @owned = true
        @raw = Input.grab_raw(@input_fd)
        if @alt_screen
          write("\e[?1049h\e[r")
          @alternate = true
        end
        write("\e[2J")
      end

      def restore : Nil
        return unless @owned
        @owned = false
        write("\e[r")
        if @alternate
          write("\e[?1049l")
          @alternate = false
        else
          write("\e[999;1H\n")
        end
        if raw = @raw
          Input.restore_raw(@input_fd, raw)
          @raw = nil
        end
      rescue
        @raw = nil
        @alternate = false
      end
    end

    # The keyboard screen's terminal: the one this reader owns, its real size,
    # and a window that changed shape while the screen was being drawn.
    #
    # The wizard draws its own rows and counts them itself, so it is told the
    # size rather than asking, and told again when the window changes — which
    # is what its own redraw is for.
    class WizardScreen
      include KeyWizard::Output

      def initialize(@terminal : Terminal, @fd : Int32 = STDOUT.fd)
        @handlers = [] of Proc(Nil)
        @trapped = false
      end

      def write(text : String) : Nil
        @terminal.write(text)
      end

      def rows : Int32
        Runtime.terminal_size(@fd)[:rows]
      end

      def columns : Int32
        Runtime.terminal_size(@fd)[:cols]
      end

      def on_resize(handler : Proc(Nil)) : Nil
        @handlers << handler
        return if @trapped
        @trapped = true
        Signal::WINCH.trap do
          @handlers.each { |each| each.call rescue nil }
        end
      end

      def off_resize(handler : Proc(Nil)) : Nil
        @handlers.delete(handler)
        return unless @handlers.empty? && @trapped
        @trapped = false
        Signal::WINCH.reset rescue nil
      end
    end

    # The reader's own keyboard, as the wizard reads it: one key at a time,
    # and nothing more once the input has ended.
    class WizardKeys
      include KeyWizard::KeySource

      def initialize(@reader : Input::KeyReader)
      end

      def next_key : String?
        key = @reader.next
        key.is_a?(Input::Eof) ? nil : key.as(String)
      end

      def close : Nil
        @reader.close
      end
    end

    module InitialPage
      abstract def goto_blank : Nil
      abstract def close : Nil
    end

    # The session-created tab is optional (adopted tabs are never ours). Keep
    # the last tab alive by blanking it when the browser itself is kept.
    def self.close_initial_tab(page : InitialPage?, page_count : Int32,
                               keep_browser : Bool = false,
                               log : Proc(String, Hash(String, JSON::Any), Nil)? = nil) : String
      return "none" unless page
      if page_count <= 1 && keep_browser
        begin
          page.goto_blank
          log.try(&.call("tab.blanked", {} of String => JSON::Any))
          return "blanked"
        rescue error
          log.try(&.call("tab.blank.failed", {
            "error" => JSON::Any.new(short_error(error)),
          }))
          return "kept"
        end
      end
      begin
        page.close
        log.try(&.call("tab.closed", {} of String => JSON::Any))
        "closed"
      rescue error
        log.try(&.call("tab.close.failed", {
          "error" => JSON::Any.new(short_error(error)),
        }))
        "kept"
      end
    end

    private def self.short_error(error : Exception) : String
      message = error.message || error.to_s
      message[0, Math.min(message.size, 120)]
    end

    class Shutdown
      def initialize(@terminal : Terminal, @cleanup : Proc(Nil),
                     @timeout : Time::Span = 1500.milliseconds)
        @started = false
        @mutex = Mutex.new
      end

      # Returns true when cleanup answered in time, false when the bound won.
      # The terminal is restored first and in every path.
      def run : Bool
        first = @mutex.synchronize do
          next false if @started
          @started = true
          true
        end
        return false unless first
        @terminal.restore
        done = Channel(Nil).new(1)
        spawn do
          @cleanup.call
        ensure
          done.send(nil)
        end
        select
        when done.receive
          true
        when timeout(@timeout)
          false
        end
      end
    end
  end
end
