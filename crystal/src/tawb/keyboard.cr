require "json"
require "./bidi"

module Tawb
  module FirefoxDriver
    # Typing, through the browser's own input pipeline (src/driver_firefox.js
    # FirefoxKeyboard). This is the piece that cannot be faked from inside
    # the page: a script-dispatched KeyboardEvent is untrusted and does not
    # insert text. input.performActions produces real key events, so
    # autocomplete, IME and a field's own handlers all behave as they would
    # under a human's fingers.
    class Keyboard
      # Keys as WebDriver names them: printable characters are themselves,
      # and everything else is a code point in a private-use block. This is
      # the mapping Playwright's key names go through to reach the same
      # place.
      WEBDRIVER_KEYS = {
        "Enter"      => "\u{E007}",
        "Backspace"  => "\u{E003}",
        "Tab"        => "\u{E004}",
        "Escape"     => "\u{E00C}",
        "Delete"     => "\u{E017}",
        "Shift"      => "\u{E008}",
        "Control"    => "\u{E009}",
        "Alt"        => "\u{E00A}",
        "Meta"       => "\u{E03D}",
        "Home"       => "\u{E011}",
        "End"        => "\u{E010}",
        "PageUp"     => "\u{E00E}",
        "PageDown"   => "\u{E00F}",
        "ArrowLeft"  => "\u{E012}",
        "ArrowUp"    => "\u{E013}",
        "ArrowRight" => "\u{E014}",
        "ArrowDown"  => "\u{E015}",
      }

      def initialize(@session : Bidi::Session, @context_id : String)
      end

      # The slider fallback presses through the same pipeline's pointer half.
      getter session : Bidi::Session

      # Spread rather than split: a character outside the basic plane is two
      # code units and one keystroke.
      def type(text : String) : Nil
        values = text.chars.map(&.to_s)
        actions = [] of JSON::Any
        values.each do |value|
          actions.push(key_action("keyDown", value))
          actions.push(key_action("keyUp", value))
        end
        perform(actions)
      end

      def press(key : String) : Nil
        parts = key.split('+')
        values = parts.map { |part| WEBDRIVER_KEYS[part]? || part }
        values.each_with_index do |value, index|
          next if WEBDRIVER_KEYS[parts[index]]? || value.size == 1
          raise IO::Error.new("the Firefox driver has no key named \"#{key}\"")
        end
        if values.size == 1
          actions = [] of JSON::Any
          values.each do |value|
            actions.push(key_action("keyDown", value))
            actions.push(key_action("keyUp", value))
          end
          perform(actions)
          return
        end

        actions = values.map { |value| key_action("keyDown", value) }
        actions.push(key_action("keyUp", values.last))
        (values.size - 2).downto(0) do |index|
          actions.push(key_action("keyUp", values[index]))
        end
        perform(actions)
      end

      private def key_action(type : String, value : String) : JSON::Any
        JSON::Any.new({
          "type"  => JSON::Any.new(type),
          "value" => JSON::Any.new(value),
        })
      end

      private def perform(actions : Array(JSON::Any)) : Nil
        @session.command("input.performActions", {
          "context" => JSON::Any.new(@context_id),
          "actions" => JSON::Any.new([JSON::Any.new({
            "type"    => JSON::Any.new("key"),
            "id"      => JSON::Any.new("tweb-keyboard"),
            "actions" => JSON::Any.new(actions),
          })]),
        })
      end
    end
  end
end
