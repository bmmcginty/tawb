# The buffer-side policy of src/live.js. Page observers and their scripts live
# at the browser boundary; this state and the decision to rebuild belong to the
# core, because they decide when a displayed buffer may move under its reader.

require "json"

module Tawb
  module Live
    MIN_INTERVAL_MS = 400_i64
    DUTY_CYCLE      = 0.2
    TICK_MS         = 250_i64
    INPUT_GRACE_MS  = 2500_i64
    PULSE_MS        = 1000_i64

    class State
      property enabled : Bool
      property dirty : Bool
      property refreshing : Bool
      property mutations : Int32
      property notifies : Int32
      property refreshes : Int32
      property last_refresh_ms : Int64
      property last_input_ms : Int64
      property last_pulse_ms : Int64
      property print : String?
      property href : String?
      property navigated : Bool
      property snapshot_cost_ms : Int64
      property pulse_errors : Int32
      property queue : Array(JSON::Any)

      def initialize
        @enabled = true
        @dirty = false
        @refreshing = false
        @mutations = 0
        @notifies = 0
        @refreshes = 0
        @last_refresh_ms = 0_i64
        @last_input_ms = 0_i64
        @last_pulse_ms = 0_i64
        @print = nil
        @href = nil
        @navigated = false
        @snapshot_cost_ms = 0_i64
        @pulse_errors = 0
        @queue = [] of JSON::Any
      end
    end

    def self.create_state : State
      State.new
    end

    # Whether a buffer refresh is due, judged against what the last snapshot
    # actually cost rather than a fixed interval.
    def self.refresh_due?(live : State, now : Int64 = Time.utc.to_unix_ms) : Bool
      return false unless live.enabled && live.dirty && !live.refreshing
      # Reading freezes the document while keys are arriving. A navigation is
      # different: every old line names a vanished element, so it bypasses the
      # freeze rather than leaving the reader moving around a page that is gone.
      return true if live.navigated
      return false if now - live.last_input_ms < INPUT_GRACE_MS
      cost = live.snapshot_cost_ms.zero? ? MIN_INTERVAL_MS : live.snapshot_cost_ms
      interval = Math.max(MIN_INTERVAL_MS.to_f, cost / DUTY_CYCLE)
      now - live.last_refresh_ms >= interval
    end
  end
end
