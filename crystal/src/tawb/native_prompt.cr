require "json"
require "./a11y_bus"
require "./atspi"
require "./log"

module Tawb
  # A dialog the browser drew itself, brought to the terminal.
  #
  # This is the same move the 401 password prompt makes, for the same reason.
  # The browser asks a question in a window of its own — outside the document,
  # so outside everything a reader of a page can see — and rather than route
  # around the question, the question is taken over: the dialog's own words go
  # on the terminal, the reader answers on the terminal, and the answer presses
  # the dialog's own button. The browser does whatever the browser was going to
  # do.
  #
  # The first thing this is for is adding an extension. The reader goes to the
  # Chrome Web Store, presses "Add to Chrome" like anybody else, and Chrome
  # raises Chrome's consent dialog listing what the extension will be able to
  # do. That dialog is not in CDP and never will be (see `atspi.cr`). That
  # dialog is in the accessibility tree, entire — heading, permissions, both
  # buttons — so the accessibility tree is where the dialog is read from and
  # where the dialog is answered.
  #
  # Nothing here knows what an extension is. What this file knows is that the
  # browser has put a question on the screen, and that a reader who cannot see
  # the question is owed the question and the choice. A file picker or a
  # permission prompt arriving the same way is handled the same way.
  module NativePrompt
    # What counts as a question rather than a window. `alert` is what
    # Chromium's own confirmations answer with; `dialog` and `file chooser` are
    # what the other things a browser raises answer with.
    DIALOG_ROLES = Set{"alert", "dialog", "file chooser"}

    # How often to look. A `GetChildren` on the application and one on each
    # window the application has open, which is a handful of round trips on a
    # unix socket — each reply is compared against the last reply and nothing
    # else is asked unless something new appeared.
    POLL_INTERVAL = 500.milliseconds

    # A chooser delegated to an XDG portal belongs to the portal application,
    # not to the browser. It is watched only around a browser-owned action
    # that can raise one, rather than claiming every chooser on the desktop.
    EXTERNAL_CHOOSER_TIMEOUT = 10.seconds

    # Where the two engines put a dialog, which is not the same place.
    #
    # Chromium's install confirmation is a child of the application, beside the
    # window rather than inside the window. Firefox's doorhanger is a child of
    # the window itself. So both the application and the application's windows
    # are watched, and a dialog is whatever turns up in either — which is one
    # level of looking, not a search of a tree with a whole browser's chrome in
    # it.
    MAX_CONTAINERS =  8
    MAX_CHILDREN   = 80

    # How many times in a row the application can fail to answer before the
    # watch gives up on the application. A browser that has quit is the
    # ordinary reason.
    MAX_FAILURES = 5

    def self.key_of(node : Atspi::Node | Atspi::Described) : String
      "#{node.bus}|#{node.path}"
    end

    # Which button the dialog would press if the dialog were answered without
    # being read. Chrome focuses Cancel on Chrome's install prompt and marks
    # Cancel the default, which is worth knowing: it means "the browser's own
    # safe answer" is a thing that can be pressed rather than guessed at, and
    # that pressing Enter blind would decline rather than install.
    def self.default_button(buttons : Array(Atspi::Described)) : Atspi::Described?
      buttons.find(&.is_default) || buttons.find(&.focused)
    end

    # One question, as the reader is handed it: what the dialog says, what the
    # dialog offers, and the things the reader can do about the dialog.
    #
    # Built from one reading. Coming back to a question the reader stepped away
    # from goes through `reread`, which asks the browser what the browser says
    # *now* rather than replaying what the browser said a minute ago.
    class Request
      getter node : Atspi::Described
      getter reading : Atspi::Reading

      def initialize(@accessibility : Atspi::Accessibility,
                     @application : Atspi::Described,
                     @node : Atspi::Described,
                     @reading : Atspi::Reading)
      end

      def role : String
        @node.role
      end

      def title : String
        return @node.name unless @node.name.empty?
        @reading.lines.first? || ""
      end

      def lines : Array(String)
        @reading.lines
      end

      def buttons : Array(Atspi::Described)
        @reading.buttons
      end

      # Options the dialog offers alongside the dialog's answer, such as
      # Firefox's "Allow extension to run in private windows".
      def toggles : Array(Atspi::Described)
        @reading.toggles
      end

      # What the dialog is about, where that lives in a control rather than in
      # the dialog's words: the username and masked password in a "Save
      # password?" prompt.
      def fields : Array(Atspi::Described)
        @reading.fields
      end

      def default_button : Atspi::Described?
        NativePrompt.default_button(@reading.buttons)
      end

      # Press a button, the way a screen reader's user activates the control
      # the user is on.
      #
      # Worth knowing if this is ever called by something other than a person:
      # a press that lands within about half a second of the dialog appearing
      # is discarded by Chromium's own protection against clickjacking, and
      # discarded silently — the call still answers true and nothing happens. A
      # reader taking the time to read the question is never near that window.
      def press(button : Atspi::Described) : Bool
        @accessibility.press(button.node)
      end

      # Tick or untick an option, and answer with what the option is now. The
      # browser owns the state; the state is read back rather than assuming the
      # press did what the press looks like it did.
      def toggle(control : Atspi::Described) : Bool?
        @accessibility.press(control.node)
        begin
          @accessibility.states_of(control.node).checked
        rescue
          nil
        end
      end

      # The same question, read again. A dialog the reader stepped away from
      # may have changed while the reader was gone, and replaying what the
      # dialog said a minute ago would be putting words in the browser's mouth.
      def reread : Request
        Request.new(@accessibility, @application, @node, @accessibility.read(@node))
      end

      # Whether the browser is still asking. Membership rather than "does the
      # object still answer": a dismissed dialog goes on answering for a moment
      # after the dialog has gone from the window.
      def still_open? : Bool
        wanted = NativePrompt.key_of(@node)
        NativePrompt.containers_of(@accessibility, @application).any? do |each|
          NativePrompt.key_of(each) == wanted
        end
      rescue
        false
      end
    end

    # Everything one level inside the application and one level inside each of
    # the application's windows. Chromium puts a dialog in the first place,
    # Firefox in the second.
    def self.containers_of(accessibility : Atspi::Accessibility,
                           application : Atspi::Described) : Array(Atspi::Node)
      windows = accessibility.children_of(application.node)
      children = windows.dup
      windows.first(MAX_CONTAINERS).each do |window|
        begin
          children.concat(accessibility.children_of(window).first(MAX_CHILDREN))
        rescue
          # A window that closed while the window was being asked about.
        end
      end
      children
    end

    # Watch one application for dialogs the application raises.
    #
    # The handler is given what the dialog says and the buttons the dialog
    # offers, and the handler is run to completion: while a reader is answering
    # one question the watch does not go looking for another, because two
    # prompts fighting over one terminal is not something anybody can answer.
    #
    # JavaScript schedules the next look with a timer and awaits the handler.
    # Crystal runs the whole watch in a fiber of its own and calls the handler
    # straight, which has the same effect for the same reason: the look that
    # would find a second dialog cannot run until the handler has returned.
    class Watch
      def initialize(@accessibility : Atspi::Accessibility,
                     @application : Atspi::Described,
                     @interval : Time::Span = POLL_INTERVAL,
                     @log : Log? = nil,
                     &@handler : Request -> Nil)
        @stopped = false
        @failures = 0
        # Everything already accounted for. A dialog is offered once: a reader
        # who leaves one unanswered has decided to leave the dialog, and being
        # asked again every half second is not an improvement.
        @known = Set(String).new
        spawn { run }
      end

      def stop : Nil
        @stopped = true
      end

      def stopped? : Bool
        @stopped
      end

      private def run : Nil
        until @stopped
          sleep @interval
          break if @stopped
          tick
        end
      end

      private def tick : Nil
        children = begin
          found = NativePrompt.containers_of(@accessibility, @application)
          @failures = 0
          found
        rescue error
          @failures += 1
          if @failures >= MAX_FAILURES
            @log.try(&.write("native.watch.lost", {
              "error" => JSON::Any.new((error.message || "")[0, 120]),
            }))
            @stopped = true
          end
          return
        end

        present = Set(String).new
        children.each { |node| present << NativePrompt.key_of(node) }
        # A dialog that has been answered — by the reader here, or in the
        # browser itself — is forgotten, so that the next dialog of the same
        # kind is new again.
        @known = @known.select { |key| present.includes?(key) }.to_set

        children.each do |node|
          return if @stopped
          key = NativePrompt.key_of(node)
          next if @known.includes?(key)
          @known << key
          described = begin
            @accessibility.describe_node(node)
          rescue
            next
          end
          next unless DIALOG_ROLES.includes?(described.role)
          reading = begin
            @accessibility.read(described)
          rescue
            next
          end
          # A window with nothing to say and nothing to press is not a
          # question.
          next if reading.buttons.empty? && reading.lines.empty?

          @log.try(&.write("native.dialog", {
            "role"    => JSON::Any.new(described.role),
            "name"    => JSON::Any.new(described.name[0, Math.min(described.name.size, 80)]),
            "buttons" => JSON::Any.new(
              reading.buttons.map(&.name).join(" / ")[0, 80]
            ),
          }))

          begin
            @handler.call(Request.new(@accessibility, @application, described, reading))
          rescue error
            @log.try(&.write("native.dialog.error", {
              "error" => JSON::Any.new((error.message || "")[0, 160]),
            }))
          end
        end
      end
    end

    # A one-shot watch for a chooser raised by a browser action but drawn by a
    # different application. It is prepared before the action: the first scan
    # records already-open choosers, then only a chooser appearing afterwards
    # is offered.
    class ExternalChooserWatch
      @known : Set(String)

      def initialize(@accessibility : Atspi::Accessibility,
                     @browser_application : Atspi::Described,
                     @interval : Time::Span = POLL_INTERVAL,
                     @timeout : Time::Span = EXTERNAL_CHOOSER_TIMEOUT,
                     @log : Log? = nil,
                     &@handler : Request -> Nil)
        @stopped = false
        @known = scan.map { |found| NativePrompt.key_of(found[:dialog]) }.to_set
        spawn { run }
      end

      def stop : Nil
        @stopped = true
      end

      private def scan : Array(NamedTuple(application: Atspi::Described,
                                          dialog: Atspi::Described))
        found = [] of NamedTuple(application: Atspi::Described, dialog: Atspi::Described)
        @accessibility.applications.each do |application|
          next if application.bus == @browser_application.bus
          nodes = NativePrompt.containers_of(@accessibility, application) rescue next
          nodes.each do |node|
            described = @accessibility.describe_node(node) rescue next
            if described.role == "file chooser"
              found << {application: application, dialog: described}
            end
          end
        end
        found
      end

      private def run : Nil
        deadline = Time.instant + @timeout
        until @stopped
          sleep @interval
          break if @stopped
          found = scan rescue [] of NamedTuple(application: Atspi::Described,
                                                dialog: Atspi::Described)
          found.each do |entry|
            key = NativePrompt.key_of(entry[:dialog])
            next if @known.includes?(key)
            @known << key
            reading = @accessibility.read(entry[:dialog]) rescue next
            next if reading.buttons.empty? && reading.lines.empty?
            @stopped = true
            @log.try(&.write("native.external-dialog", {
              "application" => JSON::Any.new(entry[:application].name[0,
                Math.min(entry[:application].name.size, 80)]),
              "name" => JSON::Any.new(entry[:dialog].name[0,
                Math.min(entry[:dialog].name.size, 80)]),
            }))
            @handler.call(Request.new(@accessibility, entry[:application],
              entry[:dialog], reading))
            return
          end
          if Time.instant >= deadline
            @stopped = true
            @log.try(&.write("native.external-expired", {} of String => JSON::Any))
          end
        end
      rescue error
        @log.try(&.write("native.external-unavailable", {
          "error" => JSON::Any.new((error.message || "")[0, 160]),
        }))
      end
    end

    # A watch, and the application the watch is on.
    class Armed
      getter application : Atspi::Described

      def initialize(@accessibility : Atspi::Accessibility, @application : Atspi::Described,
                     @watch : Watch, @offer : Request -> Nil, @log : Log? = nil)
        @external_watch = nil.as(ExternalChooserWatch?)
        @stopped = false
      end

      def expect_external_file_chooser(
        interval : Time::Span = POLL_INTERVAL,
        timeout : Time::Span = EXTERNAL_CHOOSER_TIMEOUT,
      ) : Bool
        return false if @stopped
        @external_watch.try(&.stop)
        @external_watch = ExternalChooserWatch.new(@accessibility, @application,
          interval, timeout, @log, &@offer)
        true
      rescue error
        @log.try(&.write("native.external-unavailable", {
          "error" => JSON::Any.new((error.message || "")[0, 160]),
        }))
        false
      end

      def stop : Nil
        @stopped = true
        @watch.stop
        @external_watch.try(&.stop)
        @accessibility.close
      end
    end

    # Everything a driver has to do to have the driver's browser's dialogs
    # answered here.
    #
    # Both engines want the same three things — the accessibility bus this
    # browser is on, which application on that bus is this browser, and a watch
    # — and both engines can fail to have any of the three for ordinary
    # reasons: a browser somebody else started, a machine with no D-Bus, an
    # engine that was not asked to describe its windows. None of those is an
    # error. Each of them means this browser has no native dialogs to offer,
    # and a reader who never meets one never notices.
    def self.arm(bus : A11yBus::Opened?, pid : Int64? = nil,
                 names : Array(String) = [] of String,
                 interval : Time::Span = POLL_INTERVAL,
                 log : Log? = nil,
                 &handler : Request -> Nil) : Armed?
      if bus.nil? || !bus.available?
        log.try(&.write("native.unavailable", {
          "reason" => JSON::Any.new(bus.try(&.reason) || "no accessibility bus"),
        }))
        return nil
      end
      accessibility = begin
        Atspi.open(address: bus.address, log: log)
      rescue error
        log.try(&.write("native.unavailable", {
          "reason" => JSON::Any.new((error.message || "")[0, 160]),
        }))
        return nil
      end
      application = begin
        accessibility.application_for(pid: pid, names: names)
      rescue
        nil
      end
      if application.nil?
        log.try(&.write("native.unavailable", {
          "reason" => JSON::Any.new("the browser is not describing its windows"),
        }))
        accessibility.close
        return nil
      end
      log.try(&.write("native.armed", {
        "application" => JSON::Any.new(application.name),
        "bus"         => JSON::Any.new(application.bus),
      }))
      # Browser-owned and portal-owned questions share one terminal. A mutex
      # keeps their handlers from racing each other onto it.
      gate = Mutex.new
      offer = ->(request : Request) { gate.synchronize { handler.call(request) } }
      watch = Watch.new(accessibility, application, interval, log, &offer)
      Armed.new(accessibility, application, watch, offer, log)
    end
  end
end
