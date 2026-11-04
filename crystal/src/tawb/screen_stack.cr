module Tawb
  # The order screens are raised in. The page is the base and is never
  # popped; a screen above it owns the keyboard until it leaves. What it
  # draws and how it restores the page stay the screen's own business.
  class ScreenStack
    record Screen, mode : String, kind : String

    getter base : String
    getter screens : Array(Screen)

    def initialize(@base : String = "page")
      @screens = [Screen.new(@base, @base)]
    end

    def depth : Int32
      @screens.size - 1
    end

    def top : Screen
      @screens.last
    end

    def below : Screen?
      @screens.size > 1 ? @screens[@screens.size - 2] : nil
    end

    def has?(mode : String) : Bool
      @screens.any? { |screen| screen.mode == mode }
    end

    def push(mode : String, kind : String? = nil) : Screen
      raise ArgumentError.new("the #{@base} screen is the base") if mode == @base
      screen = Screen.new(mode, kind || mode)
      @screens << screen
      screen
    end

    def pop(mode : String? = nil) : Screen?
      return nil if @screens.size <= 1
      current = top
      return nil if mode && current.mode != mode
      @screens.pop
    end
  end
end
