module Tawb
  # One stable startup line after a browser wait becomes noteworthy. There is
  # no spinner: screen readers should hear a phase, not continuous motion.
  class StartupStatus
    def initialize(@write : Proc(String, Nil), @tty : Bool,
                   @delay : Time::Span = 10.seconds)
      @last = nil.as(String?)
      @shown = false
      @generation = 0_i64
      @waiting = false
    end

    def update(message : String?) : Bool
      text = (message || "").strip
      return false if text.empty? || text == @last
      @last = text
      unless @shown
        schedule unless @waiting
        return true
      end
      show_now
      true
    end

    # Public for deterministic lifecycle tests; the delayed fiber uses the
    # same operation when its generation is still current.
    def show_now : Nil
      @waiting = false
      text = @last || return
      @shown = true
      @write.call(@tty ? "\r\e[2K#{text}" : "#{text}\n")
    end

    def finish : Nil
      @generation += 1
      @waiting = false
      @write.call("\n") if @shown && @tty
      @shown = false
    end

    private def schedule : Nil
      @waiting = true
      @generation += 1
      generation = @generation
      spawn do
        sleep @delay
        show_now if @waiting && generation == @generation
      end
    end
  end
end
