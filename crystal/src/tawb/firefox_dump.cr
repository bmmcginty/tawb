require "json"
require "./bidi"
require "./blocks"
require "./broker"
require "./dump"
require "./endpoint"
require "./firefox_agent"
require "./firefox_driver"
require "./firefox_launch"
require "./frames"
require "./layout"
require "./lynx_display"
require "./lynx_settings"
require "./marionette"

module Tawb
  module FirefoxDump
    # Reads one page through Firefox and writes it as plain text.
    #
    # Firefox serves one WebDriver session per browser and does not end it
    # when a connection closes, so a dump never speaks to Firefox alone: the
    # broker holds the session, hands it to every reader of the browser, and
    # retains it when the reader leaves a browser behind on purpose. A broker
    # that died mid-conversation is a reason to start another, not an error
    # to report; a session a dead reader stranded is released through
    # Marionette, which is the one way out BiDi has no answer for.
    def self.run(options : Hash(String, JSON::Any)) : Nil
      target = Dump.resolve_target(options["url"].as_s?, search: options["search"].as_s)
      lynx = options["frontEnd"].as_s == "lynx"
      keep_browser = options["keepBrowser"].as_bool
      preferences = lynx ? LynxSettings.preferences : {} of String => JSON::Any

      if connect = options["connect"].as_s?
        profile_dir = options["profile"].as_s? || FirefoxLaunch.default_profile
        record = Endpoint.read_record(profile_dir) || {} of String => JSON::Any
        result = read_page(direct_endpoint(connect), profile_dir,
          record["marionettePort"]?.try(&.as_i?).try(&.to_i32),
          record["libraryPort"]?.try(&.as_i?).try(&.to_i32),
          owned: false, keep_browser: keep_browser, brokered: false,
          target: target, layout: lynx,
          escape_unicode: options["escapeUnicode"].as_bool, preferences: preferences)
        STDOUT << result["text"].as_s
        return
      end

      profile_dir = options["profile"].as_s? || FirefoxLaunch.default_profile
      timeout = options["browserTimeoutMs"].as_i64? || 45_000_i64
      started = FirefoxLaunch.launch(profile_dir, timeout)
      begin
        result = read_page(started.endpoint, started.profile_dir, started.marionette_port,
          started.library_port, owned: started.owned?, keep_browser: keep_browser,
          brokered: true, target: target, layout: lynx,
          escape_unicode: options["escapeUnicode"].as_bool, preferences: preferences)
        STDOUT << result["text"].as_s
      ensure
        # Only a browser we started is ours to shut down, and only when
        # --keep-browser did not ask for it to stay.
        started.close if started.owned? && !keep_browser
      end
    end

    # Opens the session, reads the page, and closes everything the way the
    # reader would. Returns what happened, so the shared behaviour can be
    # exercised against a browser that is only a socket.
    def self.read_page(browser_endpoint : String, profile_dir : String,
                       marionette_port : Int32?, library_port : Int32?,
                       owned : Bool, keep_browser : Bool, brokered : Bool,
                       target : String, layout : Bool, escape_unicode : Bool,
                       preferences : Hash(String, JSON::Any),
                       attempts = 3) : Hash(String, JSON::Any)
      endpoint = browser_endpoint
      protocol : Bidi::Session? = nil
      tag : String? = nil
      attempts.times do |attempt|
        endpoint = brokered ? Broker.ensure(profile_dir, browser_endpoint)[:url] : browser_endpoint
        begin
          candidate = Bidi::Session.new(endpoint)
          begin
            tag = start_session(candidate, profile_dir, marionette_port, brokered)
            protocol = candidate
            break
          rescue error
            candidate.close rescue nil
            raise error
          end
        rescue error
          raise error unless brokered && attempt < attempts - 1 && vanished_broker?(error.message)
          # A broker can go at any moment — it gives up shortly after its
          # last reader leaves, and the reader arriving in that moment finds
          # a socket that closes under it. That is not a failure to report to
          # anybody; it is a reason to start one of our own and try again.
          Broker.clear_record(profile_dir)
        end
      end
      session = protocol || raise IO::Error.new("could not reach a broker for this browser")

      begin
        tree_result = session.command("browsingContext.getTree").as_h
        top = tree_result["contexts"]?.try(&.as_a?).try(&.first?)
        raise IO::Error.new("Firefox exposed no browsing context") unless top
        context_id = top.as_h["context"].as_s
        replayed = tag == "replayed"
        if replayed
          # The broker kept the already-cleared session alive. One cheap read
          # from its existing document proves that remains true; creating
          # another probe and clearing parent-process state again would turn
          # every rejoin into a substantial fraction of a cold start.
          state = probe_state(session, context_id)
        else
          probe_state(session, context_id)
          if library_port
            FirefoxAgent.ask(library_port, JSON.parse(%({"kind":"clearAutomation"}))) rescue nil
          end
          state = probe_state(session, context_id)
        end
        require_not_automated(session, context_id, state)

        page = FirefoxDriver::Page.new(session, context_id,
          top.as_h["url"]?.try(&.as_s?) || "about:blank")
        page.navigate(target)
        Dump.settle_embedded_frames(page)
        tree, documents = page.accessibility_documents(layout)
        blocks = Frames.build(tree, documents)
        text = if layout
                 display = LynxDisplay.blocks(blocks, preferences, escape_unicode)
                 lines = Layout.lines(display, 80)
                 lines.empty? ? "" : "#{lines.map { |line| LynxDisplay.row_text(line, line.as_h["text"].as_s) }.join('\n')}\n"
               else
                 Dump.format_ax_blocks(blocks, escape_unicode)
               end
        {
          "text"          => JSON::Any.new(text),
          "brokerSession" => tag ? JSON::Any.new(tag.not_nil!) : JSON::Any.new(nil),
          "webdriver"     => state ? state.not_nil!["webdriver"]? || JSON::Any.new(nil) : JSON::Any.new(nil),
        }
      ensure
        close_session(session, profile_dir, owned, keep_browser, brokered)
      end
    end

    private def self.start_session(session : Bidi::Session, profile_dir : String,
                                   marionette_port : Int32?, brokered : Bool) : String?
      unless brokered
        status = nil
        begin
          status = session.command("session.status").as_h?
        rescue
          # A browser that cannot answer whether it is ready is treated as
          # ready; session.new will say no in its own words if it is not.
        end
        if status && status["ready"]?.try(&.as_bool?) == false
          record = Endpoint.read_record(profile_dir) || {} of String => JSON::Any
          owner = record["readerPid"]?.try(&.as_i64?)
          if owner && Broker.process_alive?(owner)
            raise IO::Error.new(
              "Another reader (process #{owner}) is already using this Firefox, and Firefox " \
              "allows one session at a time. Quit it, or use a different --profile.")
          end
          unless marionette_port
            raise IO::Error.new(
              "This Firefox has a session left over from a reader that died, and there is no " \
              "Marionette port recorded to release it through. Quit Firefox and start again.")
          end
          unless Marionette.release_stranded_session(marionette_port)
            raise IO::Error.new(
              "This Firefox has a session left over from a reader that died, and Marionette " \
              "did not answer to release it. Quit Firefox and start again.")
          end
        end
      end

      begin
        result = session.command("session.new", {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        }).as_h
      rescue error
        stranded = brokered && marionette_port &&
                   /Maximum number of active sessions/i.matches?(error.message || "")
        raise error unless stranded
        # A broker that went without ending its session. Nothing is reading
        # through it — it is gone — so releasing it takes nothing from
        # anybody.
        unless Marionette.release_stranded_session(marionette_port.not_nil!)
          raise error
        end
        result = session.command("session.new", {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        }).as_h
      end

      # Whoever holds the session says so, so the next reader can tell a live
      # owner from a dead one.
      record = Endpoint.read_record(profile_dir) || {} of String => JSON::Any
      record["readerPid"] = JSON::Any.new(Process.pid.to_i64)
      Endpoint.write_record(profile_dir, record)
      tag = result["capabilities"]?.try(&.as_h?)
        .try(&.["tawb:brokerSession"]?.try(&.as_s?))
      brokered && tag.nil? ? "unknown" : tag
    end

    private def self.probe_state(session : Bidi::Session, context_id : String) : Hash(String, JSON::Any)?
      result = session.command("script.evaluate", {
        "expression" => JSON::Any.new(
          "({ readyState: document.readyState, webdriver: navigator.webdriver })"),
        "target"          => JSON::Any.new({"context" => JSON::Any.new(context_id)}),
        "awaitPromise"    => JSON::Any.new(false),
        "resultOwnership" => JSON::Any.new("none"),
      }).as_h
      return nil unless result["result"]?
      Bidi.from_remote(result["result"]).as_h?
    rescue
      nil
    end

    # The launch clear having returned is not the announcement being gone:
    # the state travels to content processes as a message, and a page that
    # answered before it arrived reports the past. False is final; true is
    # re-asked until it turns false or the short confirmation window closes.
    private def self.require_not_automated(session : Bidi::Session, context_id : String,
                                           first : Hash(String, JSON::Any)?) : Nil
      state = first
      deadline = Time.instant + 30.seconds
      while state.nil? || state["webdriver"]?.nil? ||
            !(state["webdriver"].raw.is_a?(Bool))
        return if Time.instant >= deadline
        sleep 200.milliseconds
        state = probe_state(session, context_id)
      end
      return unless state.not_nil!["webdriver"].as_bool
      confirm = Time.instant + 3.seconds
      while Time.instant < confirm
        sleep 200.milliseconds
        state = probe_state(session, context_id)
        return unless state
        return unless state.not_nil!["webdriver"]?.try(&.raw.is_a?(Bool))
        return unless state.not_nil!["webdriver"].as_bool
      end
      raise IO::Error.new(
        "Firefox is still announcing itself as automated (navigator.webdriver is true)")
    end

    private def self.close_session(session : Bidi::Session, profile_dir : String,
                                   owned : Bool, keep_browser : Bool, brokered : Bool) : Nil
      # A browser deliberately kept, or one this reader only rejoined, must
      # retain Firefox's one allowed BiDi session in the broker. Ending it
      # makes current Firefox versions quit the browser, defeating
      # --keep-browser before process cleanup even gets a say. The retained
      # broker replays session.new to the next reader.
      if (!owned || keep_browser) && brokered
        session.command(Broker::RETAIN_SESSION) rescue nil
      else
        session.command("session.end") rescue nil
      end
      if record = Endpoint.read_record(profile_dir)
        if record["readerPid"]?.try(&.as_i64?) == Process.pid.to_i64
          record["readerPid"] = JSON::Any.new(nil)
          Endpoint.write_record(profile_dir, record)
        end
      end
      session.close
    end

    private def self.vanished_broker?(message : String?) : Bool
      /connection closed|could not reach|no BiDi endpoint|error connecting|websocket closed/i
        .matches?(message || "")
    end

    # --connect names a browser already running. The launcher records its
    # endpoint as ws://127.0.0.1:PORT/session, and a number or host:port
    # means the same browser.
    private def self.direct_endpoint(connect : String) : String
      return connect if connect.starts_with?("ws://") || connect.starts_with?("wss://")
      port = if connect.matches?(/^\d+$/)
               connect.to_i
             else
               Endpoint.port_of("ws://#{connect}") || Endpoint.port_of("http://#{connect}")
             end
      unless port && port.in?(1..65_535)
        raise ArgumentError.new("--connect needs a port or a WebSocket URL, not #{connect}")
      end
      "ws://127.0.0.1:#{port}/session"
    end
  end
end
