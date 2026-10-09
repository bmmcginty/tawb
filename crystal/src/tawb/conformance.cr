require "json"
require "./address"
require "./aria"
require "./blocks"
require "./bidi"
require "./broker"
require "./dump"
require "./endpoint"
require "./firefox_agent"
require "./firefox_driver"
require "./firefox_launch"
require "./layout"
require "./lynx_display"
require "./lynx_number"
require "./marionette"
require "./options"
require "./transport"
require "./unicode_escape"

module Tawb
  module Conformance
    def self.run(operation : String, input : IO = STDIN, output : IO = STDOUT) : Nil
      payload = JSON.parse(input.gets_to_end)
      value = dispatch(operation, payload)
      output.puts({
        "ok"    => JSON::Any.new(true),
        "value" => value,
      }.to_json)
    rescue error
      output.puts({
        "ok"    => JSON::Any.new(false),
        "error" => JSON::Any.new(error.message || error.class.name),
      }.to_json)
      exit 1
    end

    private def self.dispatch(operation : String, payload : JSON::Any) : JSON::Any
      case operation
      when "address.resolve"
        object = payload.as_h
        typed = object["typed"]?.try(&.as_s?)
        search = object["search"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        JSON::Any.new(Address.resolve(typed, search))
      when "address.search_url"
        object = payload.as_h
        words = object["words"].as_s
        template = object["template"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        JSON::Any.new(Address.search_url(words, template))
      when "aria.render_line"
        JSON::Any.new(Aria.render_line(payload.as_h["item"]))
      when "bidi.from_remote"
        Bidi.from_remote(payload.as_h["value"]?)
      when "bidi.session_scenario"
        bidi_session_scenario(payload)
      when "broker.handshake_accept"
        JSON::Any.new(Broker.handshake_accept(payload.as_h["key"].as_s))
      when "broker.scenario"
        broker_scenario(payload)
      when "broker.claim"
        object = payload.as_h
        JSON::Any.new(Broker.claim(object["profile"].as_s, object["record"].as_h))
      when "broker.read"
        record = Broker.read_record(payload.as_h["profile"].as_s)
        record ? JSON::Any.new(record) : JSON::Any.new(nil)
      when "broker.clear"
        Broker.clear_record(payload.as_h["profile"].as_s)
        JSON::Any.new(true)
      when "broker.ensure_scenario"
        object = payload.as_h
        found = Broker.ensure(object["profile"].as_s, object["upstream"].as_s)
        JSON::Any.new({
          "url"      => JSON::Any.new(found[:url]),
          "port"     => JSON::Any.new(found[:port].to_i64),
          "pid"      => JSON::Any.new(found[:pid]),
          "upstream" => JSON::Any.new(object["upstream"].as_s),
        })
      when "blocks.build"
        JSON::Any.new(Blocks.build(payload.as_h["items"].as_a))
      when "blocks.fold"
        JSON::Any.new(Blocks.fold(payload.as_h["blocks"].as_a))
      when "dump.resolve_target"
        object = payload.as_h
        existing = object["existing"].as_a.map(&.as_s).to_set
        JSON::Any.new(Dump.resolve_target(
          object["input"]?.try(&.as_s?), object["cwd"].as_s, existing,
          object["search"]?.try(&.as_s?) || Address::DEFAULT_SEARCH
        ))
      when "dump.format_ax_blocks"
        object = payload.as_h
        JSON::Any.new(Dump.format_ax_blocks(
          object["blocks"].as_a, object["escape_unicode"]?.try(&.as_bool?) || false
        ))
      when "endpoint.free_port"
        JSON::Any.new(Endpoint.free_port.to_i64)
      when "endpoint.port_of"
        port = Endpoint.port_of(payload.as_h["url"].as_s)
        port ? JSON::Any.new(port.to_i64) : JSON::Any.new(nil)
      when "endpoint.read"
        record = Endpoint.read_record(payload.as_h["profile"].as_s)
        record ? JSON::Any.new(record) : JSON::Any.new(nil)
      when "endpoint.write"
        object = payload.as_h
        Endpoint.write_record(object["profile"].as_s, object["record"].as_h)
        JSON::Any.new(true)
      when "endpoint.running"
        port = Endpoint.running(payload.as_h["profile"].as_s)
        port ? JSON::Any.new(port.to_i64) : JSON::Any.new(nil)
      when "firefox.agent_request"
        object = payload.as_h
        port = object["port"]?.try(&.as_i?).try(&.to_i32)
        FirefoxAgent.ask(port, object["request"])
      when "firefox.page_scenario"
        firefox_page_scenario(payload)
      when "firefox.verified_session"
        firefox_verified_session(payload)
      when "firefox.find"
        object = payload.as_h
        found = FirefoxLaunch.find_firefox(object["path"].as_s)
        if found
          JSON::Any.new({
            "executable" => JSON::Any.new(found[:executable]),
            "name"       => JSON::Any.new(found[:name]),
          })
        else
          JSON::Any.new(nil)
        end
      when "firefox.launch_preferences"
        JSON::Any.new(FirefoxLaunch.launch_preferences(payload.as_h["port"].as_i.to_i32))
      when "firefox.launch_scenario"
        firefox_launch_scenario(payload)
      when "firefox.default_profile"
        object = payload.as_h
        JSON::Any.new(FirefoxLaunch.default_profile(
          object["executable"]?.try(&.as_s?), object["home"].as_s,
          object["xdg_data_home"]?.try(&.as_s?)
        ))
      when "firefox.profile_last_version"
        value = FirefoxLaunch.profile_last_version(payload.as_h["profile"].as_s)
        value ? JSON::Any.new(value) : JSON::Any.new(nil)
      when "firefox.installed_version"
        value = FirefoxLaunch.installed_version(payload.as_h["executable"].as_s)
        value ? JSON::Any.new(value) : JSON::Any.new(nil)
      when "firefox.require_compatible_profile"
        object = payload.as_h
        FirefoxLaunch.require_compatible_profile(
          object["executable"].as_s, object["name"].as_s, object["profile"].as_s
        )
        JSON::Any.new(true)
      when "firefox.write_profile_prefs"
        object = payload.as_h
        FirefoxLaunch.write_profile_prefs(object["profile"].as_s, object["preferences"].as_h)
        JSON::Any.new(true)
      when "layout.wrap_with_offsets"
        object = payload.as_h
        JSON::Any.new(Layout.wrap_with_offsets(object["text"].as_s, object["width"].as_i))
      when "layout.spans_within"
        object = payload.as_h
        JSON::Any.new(Layout.spans_within(
          object["spans"].as_a, object["start"].as_i64, object["end"].as_i64
        ))
      when "layout.lines"
        object = payload.as_h
        JSON::Any.new(Layout.lines(object["blocks"].as_a, object["width"].as_i))
      when "lynx_display.blocks"
        object = payload.as_h
        JSON::Any.new(LynxDisplay.blocks(
          object["blocks"].as_a, object["preferences"].as_h,
          object["escape_unicode"]?.try(&.as_bool?) || false
        ))
      when "lynx_display.render_item"
        object = payload.as_h
        JSON::Any.new(LynxDisplay.render_item(
          object["item"]?, object["fallback"]?.try(&.as_s?) || "",
          object["escape_unicode"]?.try(&.as_bool?) || false
        ))
      when "lynx_display.render_block"
        object = payload.as_h
        LynxDisplay.render_block(object["block"], object["escape_unicode"]?.try(&.as_bool?) || false)
      when "lynx_display.number_blocks"
        object = payload.as_h
        JSON::Any.new(LynxDisplay.number_blocks(object["blocks"].as_a, object["preferences"].as_h))
      when "lynx_display.group_flows"
        JSON::Any.new(LynxDisplay.group_flows(payload.as_h["blocks"].as_a))
      when "lynx_display.group_table_rows"
        JSON::Any.new(LynxDisplay.group_table_rows(payload.as_h["blocks"].as_a))
      when "lynx_display.row_text"
        object = payload.as_h
        line = object["line"]?
        line = nil if line.try(&.raw.nil?)
        JSON::Any.new(LynxDisplay.row_text(line, object["text"].as_s))
      when "lynx_number.parse"
        parsed = LynxNumber.parse(payload.as_h["text"].as_s)
        parsed ? JSON::Any.new(parsed) : JSON::Any.new(nil)
      when "lynx_number.relative"
        object = payload.as_h
        JSON::Any.new(LynxNumber.relative(
          object["prompt"], object["amount"].as_i64, object["direction"].as_i64
        ))
      when "marionette.clear_automation"
        Marionette.clear_automation(payload.as_h["port"].as_i.to_i32)
      when "marionette.release_stranded"
        JSON::Any.new(Marionette.release_stranded_session(payload.as_h["port"].as_i.to_i32))
      when "transport.websocket_round_trip"
        socket = Transport::WebSocket.new(payload.as_h["url"].as_s)
        begin
          socket.send(payload.as_h["text"].as_s)
          JSON::Any.new(socket.receive)
        ensure
          socket.close
        end
      when "options.parse_reader", "options.parse_edb"
        object = payload.as_h
        argv = object["argv"].as_a.map(&.as_s)
        env = object["env"].as_h.transform_values(&.as_s)
        result = operation.ends_with?("reader") ? Options.parse_reader(argv, env) : Options.parse_edb(argv, env)
        JSON::Any.new(result)
      when "options.front_end_name"
        JSON::Any.new(Options.front_end_name(payload.as_h["value"]?.try(&.as_s?)))
      when "unicode.escape"
        JSON::Any.new(UnicodeEscape.escape(payload.as_h["value"]?.try(&.as_s?)))
      when "unicode.escaped_offset"
        object = payload.as_h
        value = object["value"]?.try(&.as_s?)
        offset = object["offset"].as_i.to_i32
        JSON::Any.new(UnicodeEscape.escaped_offset(value, offset).to_i64)
      else
        raise ArgumentError.new("unknown conformance operation #{operation}")
      end
    end

    private def self.firefox_launch_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      started = FirefoxLaunch.launch(
        object["profile"].as_s, object["timeout_ms"].as_i64,
        object["path"].as_s, object["display"]?.try(&.as_s?)
      )
      begin
        JSON::Any.new({
          "endpoint"       => JSON::Any.new(started.endpoint),
          "port"           => JSON::Any.new(started.port.to_i64),
          "marionettePort" => started.marionette_port.try { |port| JSON::Any.new(port.to_i64) } || JSON::Any.new(nil),
          "libraryPort"    => started.library_port.try { |port| JSON::Any.new(port.to_i64) } || JSON::Any.new(nil),
          "owned"          => JSON::Any.new(started.owned?),
          "record"         => JSON::Any.new(Endpoint.read_record(started.profile_dir) || {} of String => JSON::Any),
        })
      ensure
        started.close
      end
    end

    private def self.firefox_verified_session(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      begin
        result = browser.start_verified(object["library_port"].as_i.to_i32)
        JSON::Any.new({
          "session"   => result[:session],
          "cleared"   => result[:cleared],
          "webdriver" => JSON::Any.new(result[:webdriver]),
        })
      ensure
        browser.close
      end
    end

    private def self.firefox_page_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      begin
        started = browser.start
        events = object["events"].as_a.map(&.as_s)
        browser.subscribe(events)
        page = browser.existing_page
        page.navigate(object["target"].as_s)
        tree, documents = page.accessibility_documents(object["layout"]?.try(&.as_bool?) || false)
        created = browser.create_page(background: true)
        created.close
        JSON::Any.new({
          "session"   => started,
          "url"       => JSON::Any.new(page.url),
          "tree"      => tree,
          "documents" => JSON::Any.new(documents.transform_values { |items| JSON::Any.new(items) }),
          "created"   => JSON::Any.new(created.context_id),
        })
      ensure
        browser.close
      end
    end

    private def self.bidi_session_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      values = [] of JSON::Any
      begin
        object["actions"].as_a.each do |entry|
          action = entry.as_h
          case action["type"].as_s
          when "command"
            begin
              result = session.command(
                action["method"].as_s,
                action["params"]?.try(&.as_h) || {} of String => JSON::Any
              )
              values << JSON::Any.new({"result" => result})
            rescue error
              values << JSON::Any.new({
                "error" => JSON::Any.new(error.message || error.class.name),
              })
            end
          when "event"
            values << JSON::Any.new({
              "event" => session.next_event(action["method"].as_s),
            })
          else
            raise ArgumentError.new("unknown BiDi scenario action #{action["type"]}")
          end
        end
      ensure
        session.close
      end
      JSON::Any.new(values)
    end

    private class ScenarioReader
      @mutex = Mutex.new
      @messages = [] of JSON::Any
      @socket : Transport::WebSocket

      def initialize(url : String)
        socket = Transport::WebSocket.new(url, read_timeout: nil)
        @socket = socket
        spawn do
          loop do
            message = JSON.parse(socket.receive)
            @mutex.synchronize { @messages << message }
          end
        rescue
          # the scenario closed this reader, or the broker went away
        end
      end

      def send(text : String) : Nil
        @socket.send(text)
      end

      def close : Nil
        @socket.close
      rescue
      end

      def messages : Array(JSON::Any)
        @mutex.synchronize { @messages.dup }
      end

      def find(&predicate : JSON::Any -> Bool) : JSON::Any?
        @mutex.synchronize { @messages.find { |message| predicate.call(message) } }
      end
    end

    # Runs a whole broker conversation inside this process: the broker serves
    # readers that live here, while the fake browser on the far side of the
    # upstream URL is driven by the test that wrote the steps.
    private def self.broker_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      idle_ms = object["idle_ms"]?.try(&.as_i64?) || Broker::IDLE_EXIT_MS
      grace_ms = object["grace_ms"]?.try(&.as_i64?) || Broker::STARTUP_GRACE_MS
      reasons = [] of String
      server = Broker::Server.new(
        object["upstream"].as_s, 0, idle_ms, grace_ms,
        ->(reason : String) { reasons << reason; nil }
      )
      server.start
      readers = [] of ScenarioReader
      timeline = [] of JSON::Any
      stopped = false
      broker_url = "ws://127.0.0.1:#{server.port}/session"
      begin
        object["steps"].as_a.each_with_index do |step_any, index|
          step = step_any.as_h
          case step["type"].as_s
          when "reader"
            readers << ScenarioReader.new(broker_url)
          when "send"
            id = step["id"]? || raise ArgumentError.new("send needs an id")
            readers[reader_index(step)].send({
              "id"     => id,
              "method" => JSON::Any.new(step["method"].as_s),
              "params" => step["params"]? || JSON::Any.new({} of String => JSON::Any),
            }.to_json)
          when "wait"
            found = wait_for_reader(readers[reader_index(step)], step, index)
            timeline << JSON::Any.new({
              "waited"  => JSON::Any.new(index.to_i64),
              "message" => found,
            })
          when "sleep"
            sleep step["ms"].as_i64.milliseconds
          when "close"
            readers[reader_index(step)].close
          when "reasons"
            timeline << JSON::Any.new({
              "reasons" => JSON::Any.new(reasons.map { |reason| JSON::Any.new(reason) }),
            })
          when "clients"
            timeline << JSON::Any.new({
              "clients" => JSON::Any.new(server.client_count.to_i64),
            })
          when "stop"
            server.close(step["end_session"]?.try(&.as_bool?) != false)
            stopped = true
          else
            raise ArgumentError.new("unknown broker scenario step #{step["type"]}")
          end
        end
      ensure
        server.close(false) unless stopped
      end
      JSON::Any.new({
        "port"     => JSON::Any.new(server.port.to_i64),
        "readers"  => JSON::Any.new(readers.map { |reader| JSON::Any.new(reader.messages) }),
        "timeline" => JSON::Any.new(timeline),
        "reasons"  => JSON::Any.new(reasons.map { |reason| JSON::Any.new(reason) }),
      })
    end

    private def self.reader_index(step : Hash(String, JSON::Any)) : Int32
      step["reader"].as_i
    end

    private def self.wait_for_reader(reader : ScenarioReader, step : Hash(String, JSON::Any), index : Int32) : JSON::Any
      id = step["id"]?
      method = step["method"]?.try(&.as_s?)
      raise ArgumentError.new("wait needs an id or a method") unless id || method
      timeout = step["timeout"]?.try(&.as_i?) || 5000
      deadline = Time.instant + timeout.milliseconds
      loop do
        found = reader.find do |message|
          object = message.as_h?
          next false unless object
          (id ? object["id"]? == id : true) &&
            (method ? object["method"]?.try(&.as_s?) == method : true)
        end
        return found.not_nil! if found
        raise IO::TimeoutError.new("broker scenario step #{index} timed out") if Time.instant >= deadline
        sleep 10.milliseconds
      end
    end
  end
end
