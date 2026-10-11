require "json"
require "./input"
require "./screen"

module Tawb
  # Process and terminal ownership shared by normal exit, EOF, startup errors,
  # and signals. Cleanup is idempotent because a second Ctrl-C must not start
  # another browser shutdown while the first is still bounded.
  module Runtime
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
