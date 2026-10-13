require "json"
require "./actions"
require "./engine"

module Tawb
  # Browser focus caused by one activation.
  #
  # A page can implement a skip link without a real fragment target: the
  # page's click handler calls focus() on the destination instead. The URL
  # then says nothing happened, while a graphical browser follows the new
  # focus. Focus is recorded immediately before the click so that stale
  # browser focus cannot be mistaken for the result of the reader's Enter key.
  # A focusin listener catches normal focused documents; polling activeElement
  # also covers a browser on Xvfb whose document is visible but whose native
  # window does not hold desktop focus.
  module Focus
    ARM        = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/focus_arm.js") }})
    HAS_TARGET = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/focus_has_target.js") }})
    TAKE       = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/focus_take_target.js") }})
    CLEAR      = Actions.asset_source({{ read_file("#{__DIR__}/../../assets/focus_clear.js") }})

    # Focus handlers are normally synchronous; CIBC's skip-to-banking link has
    # already focused its destination when the click returns. A short bounded
    # watch also covers handlers that defer focus through a microtask, an
    # animation frame, or a transition. The key loop is one key at a time and
    # everything it calls is awaited, so an event in this window belongs to
    # this activation.
    WAIT = 250.milliseconds
    POLL =  10.milliseconds

    # One armed observation: the document it was armed in, and the token that
    # says it is this activation's rather than an older one's.
    record Tracker, scope : Engine::Scope, token : String

    # What focus the activation moved, held by reference until the reader
    # decides to follow it or to let it go.
    record Focused, handle : Engine::Handle, scope : Engine::Scope

    @@sequence = 0

    # Armed against the element Enter is about to activate. The
    # before-and-after observation window, rather than document.activeElement
    # at some unrelated time, ties a destination to this particular action.
    def self.arm(scope : Engine::Scope, source : Engine::Handle) : Tracker
      @@sequence += 1
      token = "#{Process.pid}:#{Time.utc.to_unix_ms}:#{@@sequence}"
      source.evaluate(ARM, JSON::Any.new(token))
      Tracker.new(scope, token)
    end

    # An activation raised before anything was pressed: the observation is
    # cancelled, not followed.
    def self.cancel(tracker : Tracker?) : Bool
      return false unless tracker
      tracker.scope.evaluate(CLEAR, JSON::Any.new(tracker.token)).as_bool? || false
    rescue
      false
    end

    def self.focused_by(tracker : Tracker?, wait : Time::Span = WAIT,
                        poll : Time::Span = POLL) : Focused?
      return nil unless tracker
      deadline = Time.instant + wait
      begin
        loop do
          found = tracker.scope.evaluate(HAS_TARGET, JSON::Any.new(tracker.token)).as_bool? || false
          if found
            handle = tracker.scope.evaluate_handle(TAKE, JSON::Any.new(tracker.token))
            return Focused.new(handle, tracker.scope)
          end
          return nil if Time.instant >= deadline
          sleep poll
        end
      ensure
        tracker.scope.evaluate(CLEAR, JSON::Any.new(tracker.token)) rescue nil
      end
    end
  end
end
