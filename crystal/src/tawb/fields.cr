require "json"
require "./firefox_driver"

module Tawb
  # A field's live text and caret, read straight from the DOM (src/core.js
  # readFieldState). The walk itself is the JavaScript original's own page-side
  # function, embedded as an asset so both runtimes put the same bytes in
  # front of the page; the native side holds the element and carries the
  # answer back. The result is whatever the page said — {text, caret, native}
  # — and the differential against a real browser is what pins its shape.
  module Fields
    READ_FIELD_STATE = {{ read_file("#{__DIR__}/../../assets/read_field_state.js") }}

    def self.read_field_state(handle : FirefoxDriver::Handle) : JSON::Any
      handle.evaluate(READ_FIELD_STATE)
    end
  end
end
