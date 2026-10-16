# The buffer-side policy of src/live.js. Page observers and their scripts live
# at the browser boundary; this state and the decision to rebuild belong to the
# core, because they decide when a displayed buffer may move under its reader.

require "json"
require "set"
require "./firefox_driver"

module Tawb
  module Live
    OBSERVER_SCRIPT = {{ read_file("#{__DIR__}/../../assets/live_observer.js") }}
    DRAIN_SCRIPT    = {{ read_file("#{__DIR__}/../../assets/live_drain.js") }}
    PULSE_SCRIPT    = {{ read_file("#{__DIR__}/../../assets/live_pulse.js") }}
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

    record InstallResult, bound_now : Bool, armed : Int32, frames : Int32
    record PulseResult, changed : Bool, navigated : Bool, rearmed : Bool, ms : Int64

    # The browser-facing half of live updates. Observers leave batches in each
    # document and this object drains only documents the reader deliberately
    # armed: the top document and rendered child frames.
    class Watcher
      def initialize
        @preloaded = Set(String).new
        @armed = Set(String).new
      end

      def install(page : Engine::Page) : InstallResult
        bound_now = @preloaded.add?(page.connection_id) != nil
        page.add_preload_script(OBSERVER_SCRIPT) if bound_now
        armed = arm_frame(page) ? 1 : 0
        InstallResult.new(bound_now, armed, frame_count(page))
      end

      def arm_frame(frame : Engine::Scope,
                    force = false, again = false) : Bool
        return false if @armed.includes?(frame.document_id) && !again
        frame.evaluate(OBSERVER_SCRIPT, JSON::Any.new(force))
        @armed.add(frame.document_id)
        true
      rescue
        false
      end

      # Cross-origin frames are armed only after they contributed rendered
      # content. Context ids are stable over a document replacement; `again`
      # is reserved for pulse detecting that replacement.
      def arm_rendered_frames(frames : Array(Engine::Frame), limit = 8) : Int32
        armed = 0
        frames.first(limit).each { |frame| armed += 1 if arm_frame(frame, force: true) }
        armed
      end

      def collect(page : Engine::Page) : Array(JSON::Any)
        documents = [page.document_id]
        page.all_frames.each do |frame|
          documents << frame.document_id if @armed.includes?(frame.document_id)
        end
        out = [] of JSON::Any
        documents.uniq.each do |document_id|
          begin
            frame = page.frame_for(document_id)
            payloads = frame.evaluate(DRAIN_SCRIPT).as_a?
            out.concat(payloads) if payloads
          rescue
            # A detached or navigating document took its queue with it.
          end
        end
        out
      end

      def pulse(page : Engine::Page, live : State,
                now : Int64 = Time.utc.to_unix_ms) : PulseResult?
        return nil unless live.enabled
        return nil if now - live.last_pulse_ms < PULSE_MS
        live.last_pulse_ms = now

        started = Time.instant
        reading = page.evaluate(PULSE_SCRIPT).as_h
        elapsed = (Time.instant - started).total_milliseconds.to_i64
        observing = reading["observing"]?.try(&.as_bool?) || false
        rearmed = !observing && arm_frame(page, force: true, again: true)
        print = reading["print"]?.try(&.as_s?) || ""
        href = reading["href"]?.try(&.as_s?) || ""
        changed = !live.print.nil? && print != live.print
        navigated = !live.href.nil? && href != live.href
        live.print = print
        live.href = href
        live.dirty = true if changed
        live.navigated = true if navigated
        PulseResult.new(changed, navigated, rearmed, elapsed)
      rescue
        live.pulse_errors += 1
        nil
      end

      private def frame_count(page : Engine::Page) : Int32
        page.all_frames.size
      rescue
        1
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
