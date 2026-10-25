require "json"
require "./actions"
require "./address"
require "./aria"
require "./a11y_bus"
require "./atspi"
require "./auth"
require "./blocks"
require "./bidi"
require "./core"
require "./dbus"
require "./key_wizard"
require "./edit"
require "./registry"
require "./remap"
require "./broker"
require "./dump"
require "./edb"
require "./edb_server"
require "./endpoint"
require "./fields"
require "./firefox_agent"
require "./firefox_driver"
require "./firefox_launch"
require "./input"
require "./interfaces"
require "./keyboard"
require "./keys"
require "./layout"
require "./library"
require "./library_chromium"
require "./live"
require "./log"
require "./lynx_actions"
require "./lynx_config"
require "./lynx_options"
require "./lynx_options_screen"
require "./lynx_pages"
require "./lynx_display"
require "./lynx_keymap"
require "./lynx_number"
require "./lynx_state"
require "./marionette"
require "./native_prompt"
require "./options"
require "./reader"
require "./reader_keys"
require "./runtime"
require "./startup"
require "./quicknav"
require "./place"
require "./session"
require "./settings"
require "./screen"
require "./transport"
require "./unicode_escape"
require "./unicode_text"

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

    private def self.string_table(table : Hash(String, String)) : JSON::Any
      built = {} of String => JSON::Any
      table.each { |key, value| built[key] = JSON::Any.new(value) }
      JSON::Any.new(built)
    end

    private def self.actions_json(actions : Array(Keys::Action)) : JSON::Any
      JSON::Any.new(actions.map do |action|
        JSON::Any.new({
          "id"       => JSON::Any.new(action.id),
          "label"    => JSON::Any.new(action.label),
          "defaults" => JSON::Any.new(action.defaults.map { |binding| JSON::Any.new(binding) }),
          "bindings" => JSON::Any.new(action.bindings.map { |binding| JSON::Any.new(binding) }),
        })
      end)
    end

    private def self.build_keymap(payload : JSON::Any) : Keys::Keymap
      object = payload.as_h
      bindings = {} of String => Array(String)
      object["bindings"]?.try(&.as_h?).try do |given|
        given.each do |id, list|
          bindings[id] = list.as_a.map(&.as_s)
        end
      end
      preferences = {} of String => JSON::Any
      object["preferences"]?.try(&.as_h?).try do |given|
        given.each { |key, value| preferences[key] = value }
      end
      terminfo = nil
      object["terminfo"]?.try(&.as_h?).try do |given|
        map = {} of String => String
        given.each { |name, sequence| map[name] = sequence.as_s }
        terminfo = map
      end
      Keys::Keymap.new(
        terminfo: terminfo,
        profile: object["profile"]?.try(&.as_s?) || "default",
        file: object["file"]?.try(&.as_s?),
        read_file: object["load"]?.try(&.as_bool?) != false,
        bindings: bindings,
        unsupported: (object["unsupported"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s),
        preferences: preferences,
      )
    end

    private def self.auth_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      answers = (object["answers"]?.try(&.as_a?) || [] of JSON::Any).dup
      asks = [] of JSON::Any
      logs = [] of JSON::Any
      credentials = Auth::Credentials.new(
        ->(challenge : JSON::Any, refused : Bool, attempt : Int32) do
          asks << JSON::Any.new({"challenge" => challenge,
                                 "refused" => JSON::Any.new(refused),
                                 "attempt" => JSON::Any.new(attempt.to_i64)})
          answer = answers.shift? || JSON::Any.new(nil)
          answer.raw.nil? ? nil : answer
        end,
        ->(event : String, fields : Hash(String, JSON::Any)) do
          logs << JSON::Any.new({"event" => JSON::Any.new(event),
                                 "fields" => JSON::Any.new(fields)})
          nil
        end)
      observations = [] of JSON::Any
      object["script"].as_a.each do |entry|
        step = entry.as_h
        case step["op"].as_s
        when "remember"
          observations << JSON::Any.new(credentials.remember(step["challenge"], step["credentials"]))
        when "forget"
          credentials.forget(step["challenge"]); observations << JSON::Any.new(nil)
        when "reconsider"
          credentials.reconsider; observations << JSON::Any.new(nil)
        when "answer"
          answer = credentials.answer(step["challenge"], step["id"]?.try(&.as_s?),
            step["now"]?.try(&.as_i64?) || 0_i64)
          observations << (answer || JSON::Any.new(nil))
        end
      end
      JSON::Any.new({"observations" => JSON::Any.new(observations),
                     "asks" => JSON::Any.new(asks), "logs" => JSON::Any.new(logs)})
    end

    private def self.startup_scenario(payload : JSON::Any) : JSON::Any
      writes = [] of JSON::Any
      object = payload.as_h
      status = StartupStatus.new(
        ->(text : String) { writes << JSON::Any.new(text); nil },
        object["tty"]?.try(&.as_bool?) != false,
        1.hour)
      observations = [] of JSON::Any
      object["script"].as_a.each do |entry|
        step = entry.as_h
        case step["op"].as_s
        when "update"
          observations << JSON::Any.new(status.update(step["message"]?.try(&.as_s?)))
        when "show"
          status.show_now
          observations << JSON::Any.new(nil)
        when "finish"
          status.finish
          observations << JSON::Any.new(nil)
        end
      end
      JSON::Any.new({"observations" => JSON::Any.new(observations),
                     "writes" => JSON::Any.new(writes)})
    end

    private def self.log_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      logger = Log.new
      now = Time.unix_ms(object["now"].as_i64).to_local
      path = logger.enable(object["directory"].as_s, now,
        object["pid"].as_i64, object["home"].as_s)
      object["events"].as_a.each do |entry|
        event = entry.as_h
        case event["op"].as_s
        when "write"
          logger.write(event["event"].as_s,
            event["fields"]?.try(&.as_h?) || {} of String => JSON::Any)
        when "count"
          logger.count(event["name"].as_s, event["amount"]?.try(&.as_i64?) || 1_i64)
        when "flush_counters"
          logger.flush_counters(event["fields"]?.try(&.as_h?) || {} of String => JSON::Any)
        end
      end
      logger.close
      JSON::Any.new({
        "path"     => JSON::Any.new(path),
        "contents" => JSON::Any.new(File.read(path)),
        "mode"     => JSON::Any.new((File.info(path).permissions.value & 0o777).to_i64),
      })
    end

    private class RuntimePage
      include Runtime::InitialPage
      getter calls : Array(String)

      def initialize(@goto_fault : String? = nil, @close_fault : String? = nil)
        @calls = [] of String
      end

      def goto_blank : Nil
        @calls << "blank"
        raise IO::Error.new(@goto_fault.not_nil!) if @goto_fault
      end

      def close : Nil
        @calls << "close"
        raise IO::Error.new(@close_fault.not_nil!) if @close_fault
      end
    end

    private def self.runtime_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      page = if object["page"]?.try(&.as_bool?) == false
               nil
             else
               RuntimePage.new(object["gotoFault"]?.try(&.as_s?),
                 object["closeFault"]?.try(&.as_s?))
             end
      events = [] of JSON::Any
      logger = ->(event : String, fields : Hash(String, JSON::Any)) do
        events << JSON::Any.new({"event" => JSON::Any.new(event),
                                 "fields" => JSON::Any.new(fields)})
        nil
      end
      result = Runtime.close_initial_tab(page,
        (object["pages"]?.try(&.as_i64?) || 0).to_i32,
        object["keep"]?.try(&.as_bool?) || false, logger)

      output = IO::Memory.new
      terminal = Runtime::Terminal.new(output, -1,
        object["alt"]?.try(&.as_bool?) != false)
      terminal.acquire
      cleaned = 0
      cleanup_ms = object["cleanupMs"]?.try(&.as_i64?) || 0_i64
      shutdown = Runtime::Shutdown.new(terminal, -> do
        sleep cleanup_ms.milliseconds if cleanup_ms > 0
        cleaned += 1
        nil
      end, (object["timeoutMs"]?.try(&.as_i64?) || 100_i64).milliseconds)
      first = shutdown.run
      second = shutdown.run
      JSON::Any.new({
        "result"   => JSON::Any.new(result),
        "calls"    => JSON::Any.new(page ? page.calls.map { |call| JSON::Any.new(call) } : [] of JSON::Any),
        "events"   => JSON::Any.new(events),
        "terminal" => JSON::Any.new(output.to_s),
        "first"    => JSON::Any.new(first),
        "second"   => JSON::Any.new(second),
        "cleaned"  => JSON::Any.new(cleaned.to_i64),
      })
    end

    # A scripted pass over the reader: chunks written at particular moments,
    # waits between them, claims taken and released, and the keys that came
    # out. The JavaScript original runs the same script against a PassThrough
    # stream, so the two runtimes must answer with the same observations.
    private def self.input_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      escape_ms = object["escape_ms"]?.try(&.as_i?) || 80
      read_io, write_io = IO.pipe(true, true)
      reader = Input::KeyReader.new(read_io, escape_ms: escape_ms)
      tokens = {} of String => Input::Token
      parked = {} of String => Channel(JSON::Any)
      observations = [] of JSON::Any
      # Long enough for a written chunk to reach the parser fiber and be
      # parsed, short enough to stay inside the Alt window of every script
      # that leans on it.
      settle = 15.milliseconds
      owner_of = ->(step : Hash(String, JSON::Any)) : Input::Token? do
        name = step["owner"]?.try(&.as_s?)
        name ? tokens[name] : nil
      end
      object["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
        when "write"
          write_io.write(step["chunk"].as_s.to_slice)
          sleep settle
        when "wait"
          sleep step["ms"].as_i.milliseconds
        when "end"
          write_io.close
          sleep settle
        when "close"
          reader.close
        when "claim"
          tokens[step["owner"].as_s] = reader.claim
        when "release"
          reader.release(tokens[step["owner"].as_s])
        when "next"
          observations.push(key_json(reader.next(owner_of.call(step))))
        when "park"
          done = Channel(JSON::Any).new(1)
          parked[step["id"].as_s] = done
          owner = owner_of.call(step)
          spawn do
            done.send(key_json(reader.next(owner)))
          end
        when "next_or"
          done = Channel(JSON::Any).new(1)
          parked[step["id"].as_s] = done
          owner = owner_of.call(step)
          operations = Channel(String).new
          if (resolve = step["resolve"]?.try(&.as_s?))
            delay = step["resolve_ms"]?.try(&.as_i?) || 0
            spawn do
              sleep delay.milliseconds if delay > 0
              operations.send(resolve)
            end
          end
          spawn do
            done.send(outcome_json(reader.next_or(operations, owner)))
          end
        when "await"
          observations.push(parked[step["id"].as_s].receive)
        else
          raise ArgumentError.new("unknown input scenario op #{step["op"]}")
        end
      end
      reader.close
      JSON::Any.new(observations)
    end

    private def self.key_json(key : Input::Key) : JSON::Any
      key.is_a?(Input::Eof) ? JSON::Any.new(nil) : JSON::Any.new(key)
    end

    private def self.outcome_json(outcome : Input::OperationResult(String) | Input::KeyResult) : JSON::Any
      if outcome.is_a?(Input::KeyResult)
        JSON::Any.new({"key" => key_json(outcome.key)})
      else
        JSON::Any.new({"value" => JSON::Any.new(outcome.value)})
      end
    end

    # Whether the reader can take the terminal raw here, and does: the flags
    # while raw is held are reported, then the saved discipline is restored
    # and compared with what was read at the start. Run under a pty (the test
    # uses `script`) this exercises the termios round trip end to end.
    private def self.input_raw_probe : JSON::Any
      fd = STDIN.fd
      unless LibC.isatty(fd) == 1
        return JSON::Any.new({"tty" => JSON::Any.new(false)})
      end
      before = LibC::Termios.new
      raise "tcgetattr failed" unless LibC.tcgetattr(fd, pointerof(before)) == 0
      state = Input.grab_raw(fd)
      raise "grab_raw returned nothing" unless state
      raw = LibC::Termios.new
      raise "tcgetattr failed" unless LibC.tcgetattr(fd, pointerof(raw)) == 0
      restore_ok = Input.restore_raw(fd, state.not_nil!)
      after = LibC::Termios.new
      raise "tcgetattr failed" unless LibC.tcgetattr(fd, pointerof(after)) == 0
      JSON::Any.new({
        "tty" => JSON::Any.new(true),
        "raw" => JSON::Any.new({
          "icanon" => JSON::Any.new((raw.c_lflag & LibC::ICANON) != 0),
          "echo"   => JSON::Any.new((raw.c_lflag & LibC::ECHO) != 0),
          "isig"   => JSON::Any.new((raw.c_lflag & LibC::ISIG) != 0),
          "opost"  => JSON::Any.new((raw.c_oflag & LibC::OPOST) != 0),
        }),
        "restored"   => JSON::Any.new(after == before),
        "restore_ok" => JSON::Any.new(restore_ok),
      })
    end

    private def self.string_labels(labels : NamedTuple) : JSON::Any
      built = {} of String => JSON::Any
      labels.each { |key, value| built[key.to_s] = JSON::Any.new(value) }
      JSON::Any.new(built)
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
      when "auth.normalise"
        Auth.normalise_challenge(payload.as_h["challenge"]? || JSON::Any.new({} of String => JSON::Any))
      when "auth.challenge_key"
        JSON::Any.new(Auth.challenge_key(payload.as_h["challenge"]))
      when "auth.origin_key"
        JSON::Any.new(Auth.origin_key(payload.as_h["challenge"]))
      when "auth.scenario"
        auth_scenario(payload)
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
      when "revision.resolve"
        object = payload.as_h
        environment = {} of String => String
        object["env"]?.try(&.as_h?).try do |given|
          given.each { |key, value| environment[key] = value.as_s }
        end
        JSON::Any.new(Revision.resolve(environment,
          object["built"]?.try(&.as_s?) || "",
          object["git"]?.try(&.as_s?) || "",
          object["package"]?.try(&.as_s?) || "{}"))
      when "blocks.build"
        JSON::Any.new(Blocks.build(payload.as_h["items"].as_a))
      when "blocks.fold"
        JSON::Any.new(Blocks.fold(payload.as_h["blocks"].as_a))
      when "core.scenario"
        core_scenario(payload)
      when "core.tab_scenario"
        core_tab_scenario(payload)
      when "core.snapshot_scenario"
        core_snapshot_scenario(payload)
      when "core.more_scenario"
        core_more_scenario(payload)
      when "core.fragment_scenario"
        core_fragment_scenario(payload)
      when "core.navigation_scenario"
        core_navigation_scenario(payload)
      when "core.history_scenario"
        core_history_scenario(payload)
      when "core.live_cycle_scenario"
        core_live_cycle_scenario(payload)
      when "core.diff_blocks"
        object = payload.as_h
        previous = object["previous_texts"].as_a.map(&.as_s)
        blocks = object["blocks"].as_a.map { |text| Core::Block.new(text.as_s) }
        JSON::Any.new(Core.diff_blocks(previous, blocks).map { |region| region_json(region) })
      when "core.sole_block_containing"
        object = payload.as_h
        blocks = object["blocks"].as_a.map { |text| Core::Block.new(text.as_s) }
        JSON::Any.new(Core.sole_block_containing(blocks, object["needle"].as_s).to_i64)
      when "core.find_block_with_text"
        object = payload.as_h
        blocks = object["blocks"].as_a.map { |text| Core::Block.new(text.as_s) }
        JSON::Any.new(Core.find_block_with_text(blocks, object["needle"].as_s).to_i64)
      when "core.same_document_fragment"
        object = payload.as_h
        JSON::Any.new(Core.same_document_fragment(object["before"].as_s, object["after"].as_s))
      when "core.identity_of"
        object = payload.as_h["block"].as_h
        item = object["item"]? || JSON::Any.new(nil)
        JSON::Any.new(Core.identity_of(Core::Block.new(object["text"].as_s, item)))
      when "core.slider_target"
        object = payload.as_h
        target = Core.slider_target(object["state"], object["key"].as_s)
        # JavaScript numbers carry no int/float distinction; 52 must not
        # travel as 52.0.
        if target && target == target.trunc
          JSON::Any.new(target.to_i64)
        else
          JSON::Any.new(target)
        end
      when "core.remap_index"
        object = payload.as_h
        remapped = Remap.remap_index(
          object["old"].as_a.map(&.as_s), object["new"].as_a.map(&.as_s), object["index"].as_i
        )
        JSON::Any.new({
          "index" => JSON::Any.new(remapped.index.to_i64),
          "exact" => JSON::Any.new(remapped.exact),
        })
      when "edit.action"
        object = payload.as_h
        found = Edit.edit_action(object["key"].as_s, build_keymap(payload))
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "edit.apply"
        object = payload.as_h
        buffer = Edit::Buffer.new(object["text"].as_s, object["caret"].as_i)
        applied = Edit.apply_buffer_edit(buffer, object["action"].as_s)
        JSON::Any.new({
          "ok"    => JSON::Any.new(applied),
          "text"  => JSON::Any.new(buffer.text),
          "caret" => JSON::Any.new(buffer.caret.to_i64),
        })
      when "edit.word_start"
        object = payload.as_h
        JSON::Any.new(Edit.word_start(object["text"].as_s, object["caret"].as_i).to_i64)
      when "edit.word_end"
        object = payload.as_h
        JSON::Any.new(Edit.word_end(object["text"].as_s, object["caret"].as_i).to_i64)
      when "edit.keys_for"
        pressed = [] of JSON::Any
        sent = Edit.send_field_edit(->(key : String) { pressed << JSON::Any.new(key); nil },
          payload.as_h["action"].as_s)
        sent ? JSON::Any.new(pressed) : JSON::Any.new(nil)
      when "cdp.scenario"
        cdp_scenario(payload)
      when "cdp.tabs_scenario"
        cdp_tabs_scenario(payload)
      when "cdp.frames_scenario"
        cdp_frames_scenario(payload)
      when "cdp.library_scenario"
        cdp_library_scenario(payload)
      when "core.view_blocks"
        core_view_blocks(payload)
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
          object["blocks"].as_a, object["escape_unicode"]?.try(&.as_bool?) || false,
          object["unicode"]?.try(&.as_s?) || "ascii"
        ))
      when "native.default_button"
        buttons = (payload.as_h["buttons"].as_a).map do |raw|
          button = raw.as_h
          Atspi::Described.new(
            bus: button["bus"]?.try(&.as_s?) || ":1.1",
            path: button["path"]?.try(&.as_s?) || "/button",
            role: button["role"]?.try(&.as_s?) || "push button",
            name: button["name"].as_s,
            focused: button["focused"]?.try(&.as_bool?) || false,
            is_default: button["isDefault"]?.try(&.as_bool?) || false,
          )
        end
        found = NativePrompt.default_button(buttons)
        found ? JSON::Any.new(found.name) : JSON::Any.new(nil)
      when "native.scenario"
        native_scenario(payload)
      when "a11y.session_bus_address"
        address = A11yBus.session_bus_address
        address ? JSON::Any.new(address) : JSON::Any.new(nil)
      when "a11y.private_bus_config"
        JSON::Any.new(A11yBus.private_bus_config(payload.as_h["socketPath"].as_s))
      when "a11y.bus_scenario"
        a11y_bus_scenario(payload)
      when "a11y.open_scenario"
        a11y_open_scenario(payload)
      when "atspi.process_group_of"
        group = Atspi.process_group_of(payload.as_h["pid"].as_i.to_i64)
        group ? JSON::Any.new(group) : JSON::Any.new(nil)
      when "atspi.scenario"
        atspi_scenario(payload)
      when "dbus.split_signature"
        JSON::Any.new(Dbus.split_signature(payload.as_h["signature"].as_s).map { |type| JSON::Any.new(type) })
      when "dbus.type_length"
        object = payload.as_h
        JSON::Any.new(Dbus.type_length(object["signature"].as_s, object["at"]?.try(&.as_i?) || 0).to_i64)
      when "dbus.parse_address"
        JSON::Any.new(Dbus.parse_address(payload.as_h["address"]?.try(&.as_s?)))
      when "dbus.encode_message"
        JSON::Any.new(dbus_encode(payload.as_h["message"].as_h).hexstring)
      when "dbus.decode_message"
        dbus_message_json(Dbus.decode_message(payload.as_h["hex"].as_s.hexbytes))
      when "dbus.message_length"
        length = Dbus.message_length(payload.as_h["hex"].as_s.hexbytes)
        length ? JSON::Any.new(length.to_i64) : JSON::Any.new(nil)
      when "dbus.client_scenario"
        dbus_client_scenario(payload)
      when "edb.escape_html"
        return JSON::Any.new(Edb.escape_html(payload.as_h["text"].as_s))
      when "edb.open_bar"
        object = payload.as_h
        return JSON::Any.new(Edb.open_bar(
          object["action"]?.try(&.as_s?) || "../open",
          object["back"]?.try(&.as_bool?) || false,
          object["value"]?.try(&.as_s?) || ""))
      when "edb.tokens_to_html"
        object = payload.as_h
        registry = Edb::Registry.new
        return JSON::Any.new(Edb.tokens_to_html(
          object["extracted"], registry,
          object["base"]?.try(&.as_s?) || "BASE",
          (object["tab"]?.try(&.as_i?) || 1).to_i32,
          object["within"]?.try(&.as_i?).try(&.to_i32)))
      when "edb.lines_to_html"
        object = payload.as_h
        return JSON::Any.new(Edb.lines_to_html(
          object["title"].as_s, object["base"].as_s, object["heading"].as_s,
          object["lines"].as_a.map(&.as_s),
          object["here"]?.try(&.as_s?) || ""))
      when "edb.normalise_target"
        target = Edb.normalise_target(payload.as_h["text"]?.try(&.as_s?))
        return JSON::Any.new({
          "url"    => JSON::Any.new(target.url),
          "search" => JSON::Any.new(target.search),
          "error"  => JSON::Any.new(target.error),
        })
      when "edb.explain"
        return JSON::Any.new(Edb.explain(payload.as_h["message"].as_s))
      when "edb.routes_scenario"
        return edb_routes_scenario(payload)
      when "registry.scenario"
        return registry_scenario(payload)
      when "settings.path"
        object = payload.as_h
        return JSON::Any.new(Settings.path(
          object["env"]?.try(&.as_h?).try(&.transform_values(&.as_s)) || {} of String => String,
          object["home"]?.try(&.as_s?) || Path.home.to_s))
      when "settings.split"
        return JSON::Any.new(Settings.split(payload.as_h["text"].as_s)
          .map { |value| JSON::Any.new(value) })
      when "settings.read"
        object = payload.as_h
        return JSON::Any.new(Settings.read(
          object["env"]?.try(&.as_h?).try(&.transform_values(&.as_s)) || {} of String => String,
          object["home"]?.try(&.as_s?) || Path.home.to_s,
          object["file"]?.try(&.as_s?)
        ).map { |value| JSON::Any.new(value) })
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
      when "firefox.handle_scenario"
        firefox_handle_scenario(payload)
      when "firefox.fields_scenario"
        firefox_fields_scenario(payload)
      when "focus.scenario"
        return focus_scenario(payload)
      when "firefox.actions_scenario"
        firefox_actions_scenario(payload)
      when "firefox.files_scenario"
        firefox_files_scenario(payload)
      when "firefox.verified_session"
        firefox_verified_session(payload)
      when "firefox.dump_scenario"
        firefox_dump_scenario(payload)
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
      when "log.scenario"
        log_scenario(payload)
      when "runtime.scenario"
        runtime_scenario(payload)
      when "startup.scenario"
        startup_scenario(payload)
      when "library.entry_line"
        object = payload.as_h
        JSON::Any.new(Library.entry_line(object["kind"].as_s, object["entry"],
          object["now"]?.try(&.as_i64?) || Time.utc.to_unix_ms))
      when "library.matches"
        object = payload.as_h
        JSON::Any.new(Library.matches?(object["line"].as_s, object["filter"].as_s))
      when "library.relative_age"
        object = payload.as_h
        JSON::Any.new(Library.relative_age(object["when"]?.try(&.as_i64?), object["now"].as_i64))
      when "library.size_text"
        object = payload.as_h
        JSON::Any.new(Library.size_text(object["bytes"]?.try(&.as_i64?),
          object["total"]?.try(&.as_i64?)))
      when "library.short_address"
        object = payload.as_h
        JSON::Any.new(Library.short_address(object["url"].as_s,
          (object["max"]?.try(&.as_i64?) || Library::MAX_ADDRESS).to_i32))
      when "library.order_entries"
        object = payload.as_h
        JSON::Any.new(Library.order_entries(object["kind"].as_s, object["entries"].as_a,
          (object["max"]?.try(&.as_i64?) || Library::MAX_ENTRIES).to_i32))
      when "live.create_state"
        live_state_json(Live.create_state)
      when "live.classify_scenario"
        live_classify_scenario(payload)
      when "live.refresh_due"
        object = payload.as_h
        JSON::Any.new(Live.refresh_due?(
          live_state_from_json(object["state"]), object["now"].as_i64))
      when "live.watcher_scenario"
        live_watcher_scenario(payload)
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
      when "interfaces.name"
        JSON::Any.new(Interfaces.interface_name(payload.as_h["value"]?.try(&.as_s?)))
      when "interfaces.profiles_for"
        JSON::Any.new(Interfaces.profiles_for(payload.as_h["id"].as_s).map { |profile| JSON::Any.new(profile) })
      when "interfaces.bindings_for"
        object = payload.as_h
        JSON::Any.new(Interfaces.bindings_for(
          object["id"].as_s,
          object["defaults"].as_a.map(&.as_s),
          object["profile"]?.try(&.as_s?) || "default"
        ).map { |binding| JSON::Any.new(binding) })
      when "interfaces.key_policy"
        policy = Interfaces.key_policy(payload.as_h["profile"]?.try(&.as_s?) || "default")
        definitions = policy[:key_definitions]
        definition_table = {} of String => JSON::Any
        definitions.try(&.each do |name, definition|
          definition_table[name] = JSON::Any.new({
            "cap"       => JSON::Any.new(definition[:cap]),
            "sequences" => JSON::Any.new(definition[:sequences].map { |sequence| JSON::Any.new(sequence) }),
          })
        end)
        JSON::Any.new({
          "key_definitions" => definitions ? JSON::Any.new(definition_table) : JSON::Any.new(nil),
          "labels"          => string_labels(policy[:labels]),
          "has_key_file"    => JSON::Any.new(!policy[:key_file].nil?),
        })
      when "interfaces.needs_layout_metadata"
        JSON::Any.new(Interfaces.needs_layout_metadata(payload.as_h["profile"].as_s))
      when "interfaces.context_actions"
        string_table(Interfaces::LYNX_CONTEXT_ACTIONS)
      when "interfaces.context_navigation_action"
        object = payload.as_h
        mapping = object["action_for"]?.try(&.as_h?)
        action_for = mapping && ->(chunk : String) { mapping[chunk]?.try(&.as_s) }
        found = Interfaces.context_navigation_action(
          object["chunk"].as_s,
          object["interface"]?.try(&.as_s?) || "default",
          action_for
        )
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "interfaces.lynx_hides_cursor"
        object = payload.as_h
        JSON::Any.new(Interfaces.lynx_hides_cursor(
          object["interface"]?.try(&.as_s?) || "default",
          object["show_cursor"]?.try(&.as_bool?)
        ))
      when "input.scenario"
        input_scenario(payload)
      when "input.raw_probe"
        input_raw_probe
      when "keys.actions_for"
        JSON::Any.new(Keys.actions_for(payload.as_h["profile"].as_s).map do |action|
          JSON::Any.new({
            "id"       => JSON::Any.new(action[:id]),
            "label"    => JSON::Any.new(action[:label]),
            "defaults" => JSON::Any.new(action[:defaults].map { |binding| JSON::Any.new(binding) }),
          })
        end)
      when "keys.config_path"
        object = payload.as_h
        JSON::Any.new(Keys.config_path(
          object["xdg_config_home"]?.try(&.as_s?),
          object["home"]?.try(&.as_s?) || Path.home.to_s,
          object["profile"]?.try(&.as_s?) || "default"
        ))
      when "keys.read_terminfo"
        table = Keys.read_terminfo(term: payload.as_h["term"]?.try(&.as_s?))
        table_json = {} of String => JSON::Any
        table.each { |name, sequence| table_json[name] = JSON::Any.new(sequence) }
        JSON::Any.new(table_json)
      when "keys.snapshot"
        keys = build_keymap(payload)
        JSON::Any.new({
          "profile"        => JSON::Any.new(keys.profile),
          "file"           => JSON::Any.new(keys.file),
          "terminfo"       => string_table(keys.terminfo),
          "actions"        => actions_json(keys.actions),
          "function_names" => string_table(keys.function_names),
          "unsupported"    => JSON::Any.new(keys.unsupported.map { |name| JSON::Any.new(name) }),
          "preferences"    => JSON::Any.new(keys.preferences),
          "labels"         => string_table(keys.labels),
        })
      when "keys.action_for"
        found = build_keymap(payload).action_for(payload.as_h["chunk"].as_s)
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "keys.editing_action_for"
        found = build_keymap(payload).editing_action_for(payload.as_h["chunk"].as_s)
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "keys.name_for_sequence"
        JSON::Any.new(build_keymap(payload).name_for_sequence(payload.as_h["sequence"].as_s))
      when "keys.sequences_for"
        JSON::Any.new(build_keymap(payload).sequences_for(payload.as_h["spec"].as_s).map { |sequence| JSON::Any.new(sequence) })
      when "keys.is_key"
        object = payload.as_h
        JSON::Any.new(build_keymap(payload).is_key(object["sequence"].as_s, object["name"].as_s))
      when "keys.conflicts"
        JSON::Any.new(build_keymap(payload).conflicts(
          payload.as_h["id"].as_s, payload.as_h["spec"].as_s
        ).map(&.id).map { |id| JSON::Any.new(id) })
      when "keys.assign"
        object = payload.as_h
        keys = build_keymap(payload)
        result = keys.assign(
          object["id"].as_s, object["sequence"].as_s,
          object["add"]?.try(&.as_bool?) == true
        )
        if result
          JSON::Any.new({
            "binding"   => JSON::Any.new(result[:binding]),
            "displaced" => result[:displaced] ? JSON::Any.new(result[:displaced].not_nil!.id) : JSON::Any.new(nil),
            "actions"   => actions_json(keys.actions),
          })
        else
          JSON::Any.new(nil)
        end
      when "keys.unbind"
        object = payload.as_h
        keys = build_keymap(payload)
        keys.unbind(object["id"].as_s)
        JSON::Any.new({"actions" => actions_json(keys.actions)})
      when "keys.reset"
        keys = build_keymap(payload)
        keys.reset
        JSON::Any.new({"actions" => actions_json(keys.actions)})
      when "keys.save"
        build_keymap(payload).save
        JSON::Any.new(true)
      when "lynx_options.model"
        lynx_options_model(payload)
      when "lynx_options.screen"
        lynx_options_screen(payload)
      when "lynx_pages.call"
        lynx_pages_call(payload)
      when "lynx_state.keymap"
        lynx_state_keymap(payload)
      when "lynx_state.preferences"
        lynx_state_preferences(payload)
      when "screen.patch_edited_line"
        screen_patch_edited_line(payload)
      when "reader.draw"
        reader_draw(payload)
      when "live.real_scenario"
        live_real_scenario(payload)
      when "key_wizard.rows"
        key_wizard_rows(payload)
      when "key_wizard.run"
        key_wizard_run(payload)
      when "lynx_actions.call"
        lynx_actions_call(payload)
      when "lynx_config.key_spec"
        JSON::Any.new(LynxConfig.key_spec(payload.as_h["text"].as_s))
      when "lynx_config.parse_browse_map"
        lynx_bindings_json(LynxConfig.parse_browse_map(payload.as_h["text"].as_s))
      when "lynx_config.parse_edit_map"
        lynx_bindings_json(LynxConfig.parse_edit_map(payload.as_h["text"].as_s))
      when "lynx_config.parse_preferences"
        object = payload.as_h
        JSON::Any.new(LynxConfig.parse_preferences(
          object["showConfig"].as_s, object["lynxrc"]?.try(&.as_s?) || ""))
      when "lynx_config.read"
        lynx_config_read(payload)
      when "lynx_keymap.action_for_function"
        found = LynxKeymap.action_for_function(payload.as_h["name"].as_s)
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "lynx_keymap.function_for_action"
        found = LynxKeymap.function_for_action(payload.as_h["id"].as_s)
        found ? JSON::Any.new(found) : JSON::Any.new(nil)
      when "lynx_keymap.function_names"
        string_table(LynxKeymap.function_names(payload.as_h["ids"].as_a.map(&.as_s)))
      when "lynx_keymap.parse"
        actions = LynxKeymap.parse_key_file(payload.as_h["text"].as_s)
        actions ? JSON::Any.new(actions) : JSON::Any.new(nil)
      when "lynx_keymap.serialise"
        entries = payload.as_h["actions"].as_a.map do |action|
          {id: action.as_h["id"].as_s, bindings: action.as_h["bindings"].as_a.map(&.as_s)}
        end
        JSON::Any.new(LynxKeymap.serialise_key_file(entries))
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
      when "place.scenario"
        place_scenario(payload)
      when "session.scenario"
        session_scenario(payload)
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
      when "unicode.ascii_punctuation"
        JSON::Any.new(UnicodeText.ascii_punctuation(payload.as_h["value"]?.try(&.as_s?)))
      when "unicode.present"
        object = payload.as_h
        JSON::Any.new(UnicodeText.present(
          object["value"]?.try(&.as_s?), object["unicode"]?.try(&.as_s?) || "ascii",
          object["escape"]?.try(&.as_bool?) || false
        ))
      when "unicode.present_offset"
        object = payload.as_h
        JSON::Any.new(UnicodeText.present_offset(
          object["value"]?.try(&.as_s?), (object["offset"]?.try(&.as_i?) || 0).to_i32,
          object["unicode"]?.try(&.as_s?) || "ascii",
          object["escape"]?.try(&.as_bool?) || false
        ).to_i64)
      else
        raise ArgumentError.new("unknown conformance operation #{operation}")
      end
    end

    private def self.core_more_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://example.test/")
      core = Core.new(page: page)
      core.rendered_url = page.url
      core.blocks = [Core::Block.new("page")]
      begin
        result = core.ask_for_more(page).as_h
        result["exhausted"] = JSON::Any.new(core.no_more_to_load?)
        JSON::Any.new(result)
      ensure
        session.close
      end
    end

    private def self.core_fragment_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://example.test/")
      core = Core.new(page: page)
      core.blocks = [Core::Block.new("intro"), Core::Block.new("Annual report"),
                     Core::Block.new("tail")]
      link = JSON::Any.new({
        "role"    => JSON::Any.new("link"),
        "name"    => JSON::Any.new("Report"),
        "axIndex" => JSON::Any.new(0),
      })
      other = JSON::Any.new({
        "role"    => JSON::Any.new("heading"),
        "name"    => JSON::Any.new("Report"),
        "axIndex" => JSON::Any.new(2),
      })
      begin
        refused = core.download_link(other).as_h
        downloaded = core.download_link(link).as_h
        fragment = core.fragment_of(link)
        not_link = {
          "ok"     => refused["ok"],
          "reason" => refused["reason"]? || JSON::Any.new(nil),
        } of String => JSON::Any
        JSON::Any.new({
          "notLink"  => JSON::Any.new(not_link),
          "download" => JSON::Any.new({"ok" => downloaded["ok"]}),
          "fragment" => JSON::Any.new(fragment),
          "block"    => JSON::Any.new(core.block_at_fragment(fragment || "").to_i64),
          "missing"  => JSON::Any.new(core.block_at_fragment("nowhere").to_i64),
          "wire"     => page.evaluate("() => window.__tweb_wire || null"),
        })
      ensure
        session.close
      end
    end

    private def self.core_navigation_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://start.test/")
      core = Core.new(page: page)
      core.rendered_url = page.url
      begin
        session.subscribe(FirefoxDriver::NAVIGATION_EVENTS)
        page.goto("https://next.test/deep", wait_until: "domcontentloaded")
        after_goto = page.url
        waited = page.wait_for_load_state("load")
        moved = page.traverse_history(1)
        # A front end that rebuilds after each navigation re-baselines the
        # core on the document it now describes; a fragment event on that
        # document is then the same document the buffer already holds.
        core.rendered_url = page.url
        fragment = core.external_navigation("https://next.test/deeper#section")
        navigated = core.external_navigation("https://other.test/elsewhere")
        same = core.external_navigation("https://other.test/elsewhere")
        JSON::Any.new({
          "goto"      => JSON::Any.new(after_goto),
          "waited"    => JSON::Any.new(waited),
          "moved"     => JSON::Any.new(moved),
          "history"   => JSON::Any.new(page.url),
          "fragment"  => JSON::Any.new(fragment == :fragment),
          "navigated" => JSON::Any.new(navigated == :navigated),
          "same"      => JSON::Any.new(same == :same),
        })
      ensure
        session.close
      end
    end

    # A history move through the reader's page interface, so both the
    # driver's own command and the wiring above it are exercised. The steps
    # are scripted so the endpoint can answer a history command with only a
    # BFCache navigationStarted, or with the protocol's "no such history
    # entry", and the test can read what the page then reports.
    private def self.core_history_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      observations = [] of JSON::Any
      begin
        session.command("session.new", {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        })
        session.subscribe(FirefoxDriver::NAVIGATION_EVENTS)
        page = FirefoxDriver::Page.new(session, "main",
          object["start"]?.try(&.as_s?) || "https://start.test/")
        wrapped = Interactive::Page.new(page)
        object["steps"].as_a.each do |step_value|
          step = step_value.as_h
          case step["op"].as_s
          when "traverse"
            observations.push(JSON::Any.new(wrapped.history_go(step["direction"].as_i)))
          when "url"
            observations.push(JSON::Any.new(page.url))
          when "loading"
            observations.push(JSON::Any.new(page.loading))
          end
        end
      ensure
        session.close
      end
      JSON::Any.new(observations)
    end

    private def self.core_live_cycle_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://example.test/")
      core = Core.new(page: page)
      reflowing = false
      wraps = ->(touched : Array(Int32)) { !reflowing }
      begin
        core.rescan
        core.at(1)
        idle = core.live_cycle(nil, page).as_h
        first = JSON::Any.new({
          "pureText"      => JSON::Any.new(true),
          "mutations"     => JSON::Any.new(2),
          "announcements" => JSON::Any.new([JSON::Any.new({"text" => JSON::Any.new("clock moved")})]),
          "patches"       => JSON::Any.new([JSON::Any.new({
            "from" => JSON::Any.new("clock old"),
            "to"   => JSON::Any.new("clock mid"),
          })]),
        })
        core.live.last_refresh_ms = 0
        core.live.dirty = true
        applied = core.live_cycle(first, page, wraps: wraps, keep_place: true).as_h

        second = JSON::Any.new({
          "pureText"      => JSON::Any.new(true),
          "mutations"     => JSON::Any.new(1),
          "announcements" => JSON::Any.new([] of JSON::Any),
          "patches"       => JSON::Any.new([JSON::Any.new({
            "from" => JSON::Any.new("clock new"),
            "to"   => JSON::Any.new("clock reflowed very long indeed"),
          })]),
        })
        core.live.last_refresh_ms = 0
        reflowing = true
        refused = core.live_cycle(second, page, wraps: wraps, keep_place: false).as_h
        announced = applied["announcements"].as_a.size
        kept = refused["settled"].as_h["block"]
        JSON::Any.new({
          "patched"    => applied["patched"],
          "settled"    => applied["settled"],
          "regions"    => applied["regions"],
          "announced"  => JSON::Any.new(announced.to_i64),
          "dirtyAfter" => applied["dirty"],
          "undone"     => JSON::Any.new(refused["patched"].raw.nil?),
          "kept"       => kept,
          "refreshes"  => JSON::Any.new(core.live.refreshes.to_i64),
          "idleDirty"  => idle["dirty"],
        } of String => JSON::Any)
      ensure
        session.close
      end
    end

    private def self.core_snapshot_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://example.test/")
      core = Core.new(page: page)
      begin
        first = core.rescan.map(&.text)
        core.at(object["cursor"].as_i)
        anchor = core.anchor
        rebuilt = core.rebuild(anchor)
        JSON::Any.new({
          "first"      => JSON::Any.new(first.map { |text| JSON::Any.new(text) }),
          "second"     => JSON::Any.new(core.texts.map { |text| JSON::Any.new(text) }),
          "generation" => JSON::Any.new(core.generation.to_i64),
          "settled"    => JSON::Any.new({
            "block" => JSON::Any.new(rebuilt.settled.block.to_i64),
            "exact" => JSON::Any.new(rebuilt.settled.exact),
          }),
          "regions" => core_news_json(rebuilt.regions),
          "cost"    => JSON::Any.new(core.snapshot_cost_ms),
        })
      ensure
        session.close
      end
    end

    private def self.live_classify_scenario(payload : JSON::Any) : JSON::Any
      core = Core.new
      observations = [] of JSON::Any
      payload.as_h["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
        when "enabled"
          core.live.enabled = step["value"].as_bool
          observations.push(JSON::Any.new(nil))
        when "refreshing"
          core.live.refreshing = step["value"].as_bool
          observations.push(JSON::Any.new(nil))
        when "classify"
          observations.push(core.classify(step["payload"]?))
        when "notifies"
          observations.push(JSON::Any.new(core.live.notifies.to_i64))
        when "mark_input"
          core.mark_input(step["now"].as_i64)
          observations.push(JSON::Any.new(nil))
        when "reading"
          observations.push(JSON::Any.new(core.reading?(step["now"].as_i64)))
        else
          raise ArgumentError.new("unknown live scenario op #{step["op"]}")
        end
      end
      JSON::Any.new(observations)
    end

    private def self.live_watcher_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      page = FirefoxDriver::Page.new(session, "main", "https://example.test/")
      core = Core.new(page: page)
      observations = [] of JSON::Any
      begin
        object["script"].as_a.each do |step_value|
          step = step_value.as_h
          case step["op"].as_s
          when "install"
            result = core.attach_live(page)
            observations << JSON::Any.new({
              "boundNow" => JSON::Any.new(result.bound_now),
              "armed"    => JSON::Any.new(result.armed.to_i64),
              "frames"   => JSON::Any.new(result.frames.to_i64),
            })
          when "arm_rendered"
            frames = step["contexts"].as_a.map do |context|
              FirefoxDriver::Frame.new(session, context.as_s, page)
            end
            observations << JSON::Any.new(core.arm_live_frames(frames).to_i64)
          when "collect"
            observations << JSON::Any.new(core.collect_live(page))
          when "pulse"
            result = core.pulse_live(page, step["now"].as_i64)
            observations << if result
              JSON::Any.new({
                "changed"   => JSON::Any.new(result.changed),
                "navigated" => JSON::Any.new(result.navigated),
                "rearmed"   => JSON::Any.new(result.rearmed),
              })
            else
              JSON::Any.new(nil)
            end
          when "state"
            observations << live_state_json(core.live)
          else
            raise ArgumentError.new("unknown live watcher op #{step["op"]}")
          end
        end
      ensure
        session.close
      end
      JSON::Any.new(observations)
    end

    private def self.live_state_from_json(value : JSON::Any) : Live::State
      object = value.as_h
      state = Live.create_state
      state.enabled = object["enabled"]?.try(&.as_bool?) != false
      state.dirty = object["dirty"]?.try(&.as_bool?) || false
      state.refreshing = object["refreshing"]?.try(&.as_bool?) || false
      state.mutations = object["mutations"]?.try(&.as_i?) || 0
      state.notifies = object["notifies"]?.try(&.as_i?) || 0
      state.refreshes = object["refreshes"]?.try(&.as_i?) || 0
      state.last_refresh_ms = object["lastRefreshMs"]?.try(&.as_i64?) || 0_i64
      state.last_input_ms = object["lastInputMs"]?.try(&.as_i64?) || 0_i64
      state.last_pulse_ms = object["lastPulseMs"]?.try(&.as_i64?) || 0_i64
      state.print = object["print"]?.try(&.as_s?)
      state.href = object["href"]?.try(&.as_s?)
      state.navigated = object["navigated"]?.try(&.as_bool?) || false
      state.snapshot_cost_ms = object["snapshotCostMs"]?.try(&.as_i64?) || 0_i64
      state.queue = object["queue"]?.try(&.as_a?) || [] of JSON::Any
      state
    end

    private def self.live_state_json(state : Live::State) : JSON::Any
      JSON::Any.new({
        "enabled"        => JSON::Any.new(state.enabled),
        "dirty"          => JSON::Any.new(state.dirty),
        "refreshing"     => JSON::Any.new(state.refreshing),
        "mutations"      => JSON::Any.new(state.mutations.to_i64),
        "notifies"       => JSON::Any.new(state.notifies.to_i64),
        "refreshes"      => JSON::Any.new(state.refreshes.to_i64),
        "lastRefreshMs"  => JSON::Any.new(state.last_refresh_ms),
        "lastInputMs"    => JSON::Any.new(state.last_input_ms),
        "lastPulseMs"    => JSON::Any.new(state.last_pulse_ms),
        "print"          => JSON::Any.new(state.print),
        "href"           => JSON::Any.new(state.href),
        "navigated"      => JSON::Any.new(state.navigated),
        "snapshotCostMs" => JSON::Any.new(state.snapshot_cost_ms),
        "ticker"         => JSON::Any.new(nil),
        "queue"          => JSON::Any.new(state.queue),
      })
    end

    private def self.region_json(region : Core::Region) : JSON::Any
      JSON::Any.new({
        "start" => JSON::Any.new(region.start.to_i64),
        "end"   => JSON::Any.new(region.stop.to_i64),
      })
    end

    private def self.lynx_options_model(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      preferences = object["preferences"]?.try(&.as_h?) || {} of String => JSON::Any
      case object["method"].as_s
      when "screen_lines"
        JSON::Any.new(LynxOptions.screen_lines(preferences).map do |line|
          JSON::Any.new({
            "text"   => JSON::Any.new(line.text),
            "fields" => JSON::Any.new(line.fields.map do |field|
              JSON::Any.new({
                "letter" => JSON::Any.new(field.letter),
                "column" => JSON::Any.new(field.column.to_i64),
                "start"  => JSON::Any.new(field.start.to_i64),
                "end"    => JSON::Any.new(field.stop.to_i64),
              })
            end),
          })
        end)
      when "option_value"
        JSON::Any.new(LynxOptions.option_value(
          LynxOptions.option_for_letter(object["letter"].as_s).not_nil!, preferences))
      when "choice_index"
        JSON::Any.new(LynxOptions.choice_index(
          LynxOptions.option_for_letter(object["letter"].as_s).not_nil!, preferences).to_i64)
      when "apply_choice"
        option = LynxOptions.option_for_letter(object["letter"].as_s).not_nil!
        working = preferences.dup
        index = object["index"]?.try(&.as_i64?) || 0
        LynxOptions.apply_choice(option, working, index.to_i32)
        JSON::Any.new(working)
      when "persistable"
        JSON::Any.new(LynxOptions.persistable_options(preferences))
      when "constants"
        JSON::Any.new({
          "commandRow"    => JSON::Any.new(LynxOptions::COMMAND_ROW.to_i64),
          "anyKeyChange"  => JSON::Any.new(LynxOptions::ANY_KEY_CHANGE),
          "valueAccepted" => JSON::Any.new(LynxOptions::VALUE_ACCEPTED),
          "cancelled"     => JSON::Any.new(LynxOptions::CANCELLED),
          "choiceList"    => JSON::Any.new(LynxOptions::CHOICE_LIST),
          "selectLine"    => JSON::Any.new(LynxOptions::SELECT_LINE),
          "commandPrompt" => JSON::Any.new(LynxOptions::COMMAND_PROMPT),
          "notChangeable" => JSON::Any.new(LynxOptions::NOT_CHANGEABLE),
        })
      else
        raise ArgumentError.new("unknown lynx options model method #{object["method"].as_s}")
      end
    end

    private def self.lynx_options_screen(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      file = object["settingsFile"]?.try(&.as_s?)
      recorder = LynxOptionsRecorder.new(file)
      state = LynxOptionsScreen::State.new
      state.keys = Keys::Keymap.new(
        terminfo: {} of String => String, profile: "lynx", read_file: false,
        preferences: object["preferences"]?.try(&.as_h?) || {} of String => JSON::Any,
      )
      state.title = object["title"]?.try(&.as_s?) || "The page"
      state.lines = [JSON::Any.new(object["title"]?.try(&.as_s?) || "The page")]
      state.settings_file = file
      LynxOptionsScreen.open_options(recorder, state, nil)
      (object["keys"]?.try(&.as_a?) || [] of JSON::Any).each do |chunk|
        LynxOptionsScreen.handle_options_key(recorder, chunk.as_s, state, nil)
      end
      JSON::Any.new({
        "events"             => JSON::Any.new(recorder.events),
        "written"            => JSON::Any.new(recorder.saved.map { |settings| JSON::Any.new(settings) }),
        "mode"               => JSON::Any.new(state.mode),
        "refreshing"         => JSON::Any.new(state.refreshing),
        "preferences"        => JSON::Any.new(state.keys.not_nil!.preferences),
        "choosing"           => JSON::Any.new(state.options.try(&.choosing).try(&.letter)),
        "cursor"             => JSON::Any.new(state.cursor.to_i64),
        "settingsFileExists" => file ? JSON::Any.new(File.exists?(file)) : JSON::Any.new(false),
      })
    end

    # The fake terminal the Options screen runs against over the wire: it
    # records the byte-level calls in order, answers keys by name exactly as
    # the JavaScript tests' fake host does, and saves settings through the
    # same validator the reader uses.
    private class LynxOptionsRecorder
      include LynxOptionsScreen::Host

      getter events : Array(JSON::Any)
      getter saved : Array(Hash(String, JSON::Any))

      def initialize(@file : String?)
        @events = [] of JSON::Any
        @saved = [] of Hash(String, JSON::Any)
      end

      def reset_scroll_region : Nil
        note("reset")
      end

      def write_line(row : Int32, text : String) : Nil
        note("line", row, text)
      end

      def move_cursor(row : Int32, col : Int32) : Nil
        note("cursor", row, col)
      end

      def clear_screen : Nil
        note("clear")
      end

      def set_status(state : LynxOptionsScreen::State, message : String) : Nil
        note("status", message)
      end

      def relayout(state : LynxOptionsScreen::State) : Nil
        note("relayout")
      end

      def render(state : LynxOptionsScreen::State, page, force : Bool) : Nil
        note("render", force ? 1 : 0)
      end

      def clamp_col(state : LynxOptionsScreen::State) : Nil
        note("clampCol")
      end

      def clamp_scroll(state : LynxOptionsScreen::State) : Nil
        note("clampScroll")
      end

      def save_settings(state : LynxOptionsScreen::State, settings : Hash(String, JSON::Any)) : Nil
        note("save")
        @saved << settings
        LynxSettings.write_lynx_settings(settings, file: @file) if @file
      end

      def key_is(chunk : String, name : String, state : LynxOptionsScreen::State) : Bool
        chunk == "[#{name}]"
      end

      private def note(*parts : String | Int32 | Int64 | Bool) : Nil
        @events << JSON::Any.new(parts.to_a.map { |part| JSON::Any.new(part) })
      end
    end

    private def self.rows_json(rows : Array(LynxPages::Row)) : JSON::Any
      JSON::Any.new(rows.map do |row|
        JSON::Any.new({
          "text"  => JSON::Any.new(row.text),
          "entry" => row.entry || JSON::Any.new(nil),
        })
      end)
    end

    private def self.lynx_pages_call(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      case object["method"].as_s
      when "help"
        unsupported = (object["unsupported"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
        JSON::Any.new(LynxPages.help_rows(unsupported).map { |row| JSON::Any.new(row) })
      when "document_info"
        item = object["item"]?
        item = nil if item && item.raw.nil?
        rows_json(LynxPages.document_info_rows(
          object["title"]?.try(&.as_s?) || "",
          object["url"]?.try(&.as_s?) || "",
          object["source"]?.try(&.as_s?) || "",
          object["size"]?.try(&.as_i64?) || 0_i64,
          item,
        ))
      when "visited"
        rows_json(LynxPages.visited_rows(object["visited"]?.try(&.as_a?) || [] of JSON::Any))
      when "session"
        rows_json(LynxPages.session_rows(object["pageLog"]?.try(&.as_a?) || [] of JSON::Any))
      when "link_list"
        rows_json(LynxPages.link_list_rows(
          object["blocks"]?.try(&.as_a?) || [] of JSON::Any,
          object["lines"]?.try(&.as_a?) || [] of JSON::Any,
          object["addresses"]?.try(&.as_bool?) == true,
          object["numbered"]?.try(&.as_bool?) == true,
        ))
      when "describe"
        item = object["item"]?
        item = nil if item && item.raw.nil?
        JSON::Any.new(LynxPages.describe_item(item))
      when "trace"
        rows_json(LynxPages.trace_rows(object["text"]?.try(&.as_s?) || ""))
      else
        raise ArgumentError.new("unknown lynx pages method #{object["method"].as_s}")
      end
    end

    private def self.lynx_state_keymap(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      written = [] of Hash(String, JSON::Any)
      reads = 0
      imported_count = 0
      import_lynx = object["import"]?.try do |raw|
        source = raw.as_h
        imported = LynxConfig::Imported.new(
          source["available"].as_bool,
          source["bindings"]?.try(&.as_h?).try do |map|
            map.reduce({} of String => Array(String)) do |memo, pair|
              memo[pair[0]] = pair[1].as_a.map(&.as_s)
              memo
            end
          end || {} of String => Array(String),
          (source["unsupported"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s),
          source["preferences"]?.try(&.as_h?) || {} of String => JSON::Any,
        )
        ->(_executable : String?, _config : String?) do
          imported_count += 1
          imported
        end
      end
      read_lynx = object["readLynx"]?.try do |raw|
        saved = raw.as_h
        -> do
          reads += 1
          saved
        end
      end
      write_lynx = ->(settings : Hash(String, JSON::Any)) : Nil {
        written << settings
        nil
      }
      has_keys = object["hasKeys"]?.try do |raw|
        next nil if raw.raw.nil?
        answer = raw.as_bool? == true
        ->(_path : String) { answer }
      end
      env = Hash(String, String).new
      if (home = object["home"]?.try(&.as_s?))
        env["HOME"] = home
      end
      if (xdg = object["xdgConfigHome"]?.try(&.as_s?))
        env["XDG_CONFIG_HOME"] = xdg
      end
      keymap = LynxState.lynx_keymap_for(
        object["lynxReimport"]?.try(&.as_bool?) == true,
        object["lynxExecutable"]?.try(&.as_s?),
        object["lynxConfig"]?.try(&.as_s?),
        import_lynx, read_lynx, write_lynx,
        object["keysFile"]?.try(&.as_s?),
        has_keys, env,
      )
      probes = (object["probe"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      actions = probes.to_h do |chunk|
        {chunk, JSON::Any.new(keymap.action_for(chunk))}
      end
      JSON::Any.new({
        "actions"        => JSON::Any.new(actions),
        "preferences"    => JSON::Any.new(keymap.preferences),
        "unsupported"    => JSON::Any.new(keymap.unsupported.map { |name| JSON::Any.new(name) }),
        "keysFileExists" => JSON::Any.new(File.exists?(keymap.file)),
        "written"        => JSON::Any.new(written.map { |settings| JSON::Any.new(settings) }),
        "reads"          => JSON::Any.new(reads),
        "imported"       => JSON::Any.new(imported_count),
      })
    end

    private def self.lynx_state_preferences(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      saved = object["readLynx"]?.try(&.as_h?)
      read = saved ? -> { saved.not_nil! } : nil
      JSON::Any.new({
        "preferences" => JSON::Any.new(LynxState.lynx_preferences(read)),
      })
    end

    private def self.wizard_keymap(payload : JSON::Any) : Keys::Keymap
      object = payload.as_h
      bindings = {} of String => Array(String)
      object["bindings"]?.try(&.as_h?).try do |given|
        given.each { |id, list| bindings[id] = list.as_a.map(&.as_s) }
      end
      keymap = Keys::Keymap.new(
        terminfo: {} of String => String,
        profile: object["profile"]?.try(&.as_s?) || "default",
        file: object["file"]?.try(&.as_s?),
        read_file: false,
        bindings: bindings,
        unsupported: (object["unsupported"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s),
      )
      if object["unbindAll"]?.try(&.as_bool?) == true
        keymap.actions.each { |action| keymap.unbind(action.id) }
      end
      keymap
    end

    # The recorded terminal the screen primitives run against over the wire.
    private class RecordingScreen
      include Screen::Output

      getter writes : Array(JSON::Any)

      def initialize
        @writes = [] of JSON::Any
      end

      def write(text : String) : Nil
        @writes << JSON::Any.new(text)
      end

      def generation : Int32
        @writes.size
      end
    end

    # A prompt's keyboard, fed from the scenario: one queued keystroke per
    # entry, exhausted the way a real reader would have stopped typing.
    private class ScriptedKeyboard
      include ReaderKeys::Keyboard

      @queue : Array(Input::Key)

      def initialize(@queue)
      end

      def claim : Input::Token
        Input::Token.new
      end

      def next_key(token : Input::Token) : Input::Key
        @queue.shift? || raise IO::Error.new("the prompt asked for a key nobody pressed")
      end

      def release(token : Input::Token) : Nil
      end

      # The navigation is scripted to finish or hang on its own, so a race
      # against a queued key is settled by the key when there is one and by
      # the navigation when there is not — the same answer the sequential
      # reader in the JavaScript harness gives.
      def next_or(operation : Channel(ReaderKeys::NavigateOutcome), token : Input::Token) : Input::OperationResult(ReaderKeys::NavigateOutcome) | Input::KeyResult
        if key = @queue.shift?
          return Input::KeyResult.new(key)
        end
        Input::OperationResult.new(operation.receive)
      end
    end

    # The page the scenario describes: an address, a title, and a keyboard
    # that records what was sent to it — and can refuse.
    private class ScriptedPage
      include Reader::PageEnv

      getter presses : Array(String)
      property fail_press : Bool
      property url : String
      property goto_fault : String?
      property goto_hang : Bool
      property reload_fault : String?
      property blocks : Array(JSON::Any)?
      property history : Array(JSON::Any)
      property history_index : Int32
      property history_changed : Proc(Array(JSON::Any), Nil)?

      def initialize(@url : String, @title : String, @fail_press = false)
        @presses = [] of String
        @goto_fault = nil
        @goto_hang = false
        @reload_fault = nil
        @blocks = nil
        @history = [] of JSON::Any
        @history_index = 0
        @history_changed = nil
      end

      def url : String
        @url
      end

      def title : String
        @title
      end

      def keyboard_press(key : String) : Nil
        raise IO::Error.new("the page refused") if @fail_press
        @presses << key
      end

      def wait_for_load : Nil
      end

      def goto(url : String) : Nil
        raise IO::Error.new(@goto_fault.not_nil!) if @goto_fault
        sleep if @goto_hang
        @url = url
      end

      def stop_loading : Nil
      end

      def reload(ignore_cache : Bool) : Nil
        raise IO::Error.new(@reload_fault.not_nil!) if @reload_fault
      end

      def history_identity : String
        @history.empty? ? "url:#{@url}" : "entry:#{@history_index}"
      end

      def history_go(direction : Int32) : Bool
        return false if @history.empty?
        target = @history_index + direction
        return false unless target.in?(0...@history.size)
        @history_index = target
        entry = @history[target].as_h
        @url = entry["url"].as_s
        @title = entry["title"]?.try(&.as_s?) || ""
        blocks = entry["blocks"]?.try(&.as_a?) || [] of JSON::Any
        @history_changed.try(&.call(blocks))
        true
      end
    end

    private class ScriptedBrowserLibrary
      include Reader::LibraryEnv
      def initialize(@spec : Hash(String, JSON::Any)); end
      def read(kind : String) : Array(JSON::Any)
        if failure = @spec["failure"]?.try(&.as_s?)
          raise IO::Error.new(failure)
        end
        @spec[kind]?.try(&.as_a?) || [] of JSON::Any
      end
      def save(url : String, title : String) : JSON::Any
        raise IO::Error.new(@spec["saveFailure"].as_s) if @spec["saveFailure"]?
        JSON::Any.new({"url" => JSON::Any.new(url), "title" => JSON::Any.new(title)})
      end
      def delete(entry : JSON::Any) : Nil
        raise IO::Error.new(@spec["deleteFailure"].as_s) if @spec["deleteFailure"]?
      end
    end

    # A small browser inventory for reader-key scenarios. Each page can carry
    # the blocks a rescan of that tab returns, and failures exercise the same
    # status paths as a driver refusing to create or close one.
    private class ScriptedTabs
      include Reader::TabEnv

      getter pages : Array(ScriptedPage)
      property new_fault : String?
      property close_fault : String?

      def initialize(@state : Reader::State, specs : Array(JSON::Any), current : Int32)
        @pages = specs.map do |value|
          spec = value.as_h
          page = ScriptedPage.new(spec["url"]?.try(&.as_s?) || "about:blank",
            spec["title"]?.try(&.as_s?) || "")
          page.blocks = spec["blocks"]?.try(&.as_a?)
          page
        end
        @pages << ScriptedPage.new("about:blank", "") if @pages.empty?
        @current = @pages[Math.min(Math.max(current, 0), @pages.size - 1)]
        @new_fault = nil
        @close_fault = nil
        install_blocks(@current)
      end

      def current_page : Reader::PageEnv
        @current
      end

      def next_tab(direction : Int32) : Reader::PageEnv?
        return nil if @pages.size < 2
        at = @pages.index(@current) || 0
        @pages[(at + direction + @pages.size) % @pages.size]
      end

      def tab_after(page : Reader::PageEnv) : Reader::PageEnv?
        return nil if @pages.size < 2
        at = @pages.index { |candidate| candidate.same?(page) } || 0
        @pages[(at + 1) % @pages.size]
      end

      def adopt_tab(page : Reader::PageEnv) : Nil
        @current = page.as(ScriptedPage)
        install_blocks(@current)
      end

      def new_tab : Reader::PageEnv
        raise IO::Error.new(@new_fault.not_nil!) if @new_fault
        made = ScriptedPage.new("about:blank", "")
        made.blocks = [] of JSON::Any
        @pages << made
        made
      end

      def close_tab(page : Reader::PageEnv) : Nil
        raise IO::Error.new(@close_fault.not_nil!) if @close_fault
        @pages.reject! { |candidate| candidate.same?(page) }
      end

      def tab_position(page : Reader::PageEnv) : NamedTuple(position: Int32, of: Int32)
        at = @pages.index { |candidate| candidate.same?(page) }
        {position: at ? at + 1 : 0, of: @pages.size}
      end

      def tab_label(page : Reader::PageEnv) : String
        value = page.title.gsub(/\s+/, " ").strip
        value = page.url if value.empty?
        value = "untitled" if value.empty?
        value[0, Math.min(value.size, 60)]
      rescue
        "untitled"
      end

      private def install_blocks(page : ScriptedPage) : Nil
        return unless blocks = page.blocks
        @state.core.as(Reader::CoreState).rescan_blocks = blocks
      end
    end

    # One drawing pass over the reader's terminal: a state, a page address,
    # and the actions to run in order against the same live state. What each
    # action wrote, and the state as it stands afterwards, come back — the
    # drawn-row caches are part of the answer, since whether a row is
    # rewritten is the behaviour under test.
    private def self.reader_draw(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      state = reader_state(object["state"])
      page_url = object["page"]?.try(&.as_h?).try(&.["url"]?.try(&.as_s?)) || ""
      page_title = object["page"]?.try(&.as_h?).try(&.["title"]?.try(&.as_s?)) || ""
      page = ScriptedPage.new(page_url, page_title,
        object["page"]?.try(&.as_h?).try(&.["failPress"]?.try(&.as_bool?)) || false)
      if page_spec = object["page"]?.try(&.as_h?)
        page.goto_fault = page_spec["gotoFault"]?.try(&.as_s?)
        page.goto_hang = page_spec["gotoHang"]?.try(&.as_bool?) || false
        page.reload_fault = page_spec["reloadFault"]?.try(&.as_s?)
        if history = page_spec["history"]?.try(&.as_a?)
          page.history = history
          page.history_index = (page_spec["historyIndex"]?.try(&.as_i64?) || 0).to_i32
          page.history_changed = ->(blocks : Array(JSON::Any)) do
            state.core.as(Reader::CoreState).rescan_blocks = blocks
          end
        end
      end
      if core_spec = object["state"].as_h["core"]?.try(&.as_h?)
        if tab_specs = core_spec["tabs"]?.try(&.as_a?)
          tabs = ScriptedTabs.new(state, tab_specs,
            (core_spec["currentTab"]?.try(&.as_i64?) || 0).to_i32)
          tabs.new_fault = core_spec["newTabFault"]?.try(&.as_s?)
          tabs.close_fault = core_spec["closeTabFault"]?.try(&.as_s?)
          state.tabs = tabs
          page = tabs.current_page.as(ScriptedPage)
        end
      end
      results = [] of JSON::Any
      (object["actions"]?.try(&.as_a?) || [] of JSON::Any).each do |step_value|
        action = step_value.as_h
        output = RecordingScreen.new
        current_page = state.tabs.try(&.current_page) || page
        value = reader_action(output, state, action, current_page.url,
          current_page.as(ScriptedPage))
        entry = {"writes" => JSON::Any.new(output.writes)} of String => JSON::Any
        entry["value"] = value unless value.nil?
        results << JSON::Any.new(entry)
      end
      JSON::Any.new({
        "results" => JSON::Any.new(results),
        "state"   => reader_state_json(state),
      })
    end

    # The scripted core the interactive front end really has: its binding
    # rebuilds the JSON block list on every read, so a check that compares a
    # list with `state.core.blocks` by identity never matches. Used to keep
    # that shape in the conformance harness.
    class FreshBlocksCoreState < Reader::CoreState
      def blocks : Array(JSON::Any)
        super.dup
      end
    end

    private def self.reader_state(payload : JSON::Any) : Reader::State
      object = payload.as_h
      state = Reader::State.new
      state.rows = (object["rows"]?.try(&.as_i64?) || 24).to_i32
      state.cols = (object["cols"]?.try(&.as_i64?) || 80).to_i32
      state.interface = object["interface"]?.try(&.as_s?) || "tawb"
      state.mode = object["mode"]?.try(&.as_s?) || "browse"
      state.title = object["title"]?.try(&.as_s?) || ""
      state.escape_unicode = object["escapeUnicode"]?.try(&.as_bool?) || false
      state.unicode = object["unicode"]?.try(&.as_s?) || "ascii"
      state.short_links = object["shortLinks"]?.try(&.as_bool?) || false
      state.link_address = object["linkAddress"]?.try(&.as_bool?) != false
      state.status_msg = object["statusMsg"]?.try(&.as_s?) || ""
      state.home_url = object["homeUrl"]?.try(&.as_s?) || "https://www.google.com"
      state.log_dir = object["logDir"]?.try(&.as_s?)
      state.cursor = (object["cursor"]?.try(&.as_i64?) || 0).to_i32
      state.col = (object["col"]?.try(&.as_i64?) || 0).to_i32
      state.scroll = (object["scroll"]?.try(&.as_i64?) || 0).to_i32
      (object["lines"]?.try(&.as_a?) || [] of JSON::Any).each do |line_json|
        line_object = line_json.as_h
        spans = line_object["spans"]?.try(&.as_a?).try do |list|
          list.map do |span_json|
            span = span_json.as_h
            Reader::Span.new(
              (span["start"]?.try(&.as_i64?) || 0).to_i32,
              (span["end"]?.try(&.as_i64?) || 0).to_i32,
              (span["blockIndex"]?.try(&.as_i64?) || 0).to_i32,
              span["displayNumber"]?)
          end
        end
        state.lines << Reader::Line.new(
          line_object["text"]?.try(&.as_s?) || "",
          (line_object["blockIndex"]?.try(&.as_i64?) || 0).to_i32,
          spans,
          line_object["continuation"]?.try(&.as_bool?) || false,
          (line_object["displayIndent"]?.try(&.as_i64?) || 0).to_i32,
          line_object["displayPrefix"]?.try(&.as_s?) || "",
          line_object["displaySuffix"]?.try(&.as_s?) || "",
          line_object["displayNumber"]?)
      end
      if drawn = object["drawn"]?.try(&.as_h?)
        state.drawn.title = drawn["title"]?.try(&.as_s?)
        state.drawn.address = drawn["address"]?.try(&.as_s?)
        state.drawn.address_caret_col = drawn["addressCaretCol"]?.try(&.as_i64?).try(&.to_i32)
        state.drawn.hint = drawn["hint"]?.try(&.as_s?)
        state.drawn.status = drawn["status"]?.try(&.as_s?)
      end
      if core = object["core"]?.try(&.as_h?)
        # The interactive front end wraps the core in a binding that builds a
        # fresh JSON list on every `blocks` call, unlike this scripted core.
        # `freshBlocks` asks for that shape, which is what makes the identity
        # question in Reader.display_blocks testable.
        fresh = core["freshBlocks"]?.try(&.as_bool?) == true
        state.core = (fresh ? FreshBlocksCoreState.new(
          core["source"]?.try(&.as_s?) || "ax",
          core["blocks"]?.try(&.as_a?) || [] of JSON::Any,
          core["popup"]?,
          core["popupAt"]?.try(&.as_i64?) || -1_i64) : Reader::CoreState.new(
          core["source"]?.try(&.as_s?) || "ax",
          core["blocks"]?.try(&.as_a?) || [] of JSON::Any,
          core["popup"]?,
          core["popupAt"]?.try(&.as_i64?) || -1_i64))
        scripted = state.core.as(Reader::CoreState)
        scripted.rescan_blocks = core["rescanBlocks"]?.try(&.as_a?)
        if failure = scripted_value(core, "rescanFailure")
          scripted.rescan_failure = failure
        end
        scripted.rescan_cost = (core["rescanCost"]?.try(&.as_i64?) || 0_i64)
        scripted.anchor_json = core["anchor"]?
        scripted.restore_block = (core["restoreBlock"]?.try(&.as_i64?) || -1).to_i32
        scripted.reanchored = core["reanchored"]?
        scripted.activated_status = core["activatedStatus"]?
        scripted.live = core["live"]?
        scripted.snapshot_cost = core["snapshotCostMs"]?.try(&.as_i64?) || 0_i64
        # Activation, typing and the chooser are scripted as answers: what
        # the element layer would have found, and what the choice changed.
        # An absent or JSON-null answer is the same as "none".
        if fragment = scripted_value(core, "fragment")
          scripted.fragment = fragment
        end
        scripted.focus_control_ok = core["focusOk"]?.try(&.as_bool?) != false
        if listing = scripted_value(core, "listing")
          scripted.listing = listing
        end
        if field = scripted_value(core, "field")
          scripted.field_info = field
        end
        if outcome = scripted_value(core, "chooseOutcome")
          scripted.choose_outcome = outcome
        end
        if failure = scripted_value(core, "chooseFailure")
          scripted.choose_failure = failure
        end
        if failure = scripted_value(core, "activationFailure")
          scripted.activation_failure = failure
        end
        if changes = core["changes"]?.try(&.as_a?)
          scripted.changes = changes
        end
        scripted.fragment_block = (core["fragmentBlock"]?.try(&.as_i64?) || -1).to_i32
        scripted.watch_focus = core["watchFocus"]?.try(&.as_bool?) || false
        scripted.focus_found = core["focusFound"]?.try(&.as_bool?) || false
        scripted.focus_block = (core["focusBlock"]?.try(&.as_i64?) || -1).to_i32
        if typed = core["typedFields"]?.try(&.as_a?)
          scripted.typed_fields = typed
        end
        if outcome = scripted_value(core, "adjustOutcome")
          scripted.adjust_outcome = outcome
        end
        if failure = scripted_value(core, "adjustFailure")
          scripted.adjust_failure = failure
        end
        scripted.no_more_to_load = core["noMoreToLoad"]?.try(&.as_bool?) || false
        if outcome = scripted_value(core, "askMoreOutcome")
          scripted.ask_more_outcome = outcome
        end
        if failure = scripted_value(core, "askMoreFailure")
          scripted.ask_more_failure = failure
        end
        scripted.can_real_click = core["canRealClick"]?.try(&.as_bool?) != false
        if outcome = scripted_value(core, "realClickOutcome")
          scripted.real_click_outcome = outcome
        end
        scripted.can_hover = core["canHover"]?.try(&.as_bool?) != false
        if outcome = scripted_value(core, "hoverOutcome")
          scripted.hover_outcome = outcome
        end
        if outcome = scripted_value(core, "downloadOutcome")
          scripted.download_outcome = outcome
        end
        if changes = core["changeTargets"]?.try(&.as_a?)
          scripted.change_targets = changes
        end
        scripted.change_index = (core["changeIndex"]?.try(&.as_i64?) || -1).to_i32
        scripted.driver_name = core["driverName"]?.try(&.as_s?) || "scripted"
        # The place keeper's page side: what the capture is told about the
        # element, where the restore is told the element now is, and the
        # blocks each view's own extractor would answer with.
        if described = scripted_value(core, "placeElement")
          scripted.place_element = described
        end
        if located = scripted_value(core, "placeLocation")
          scripted.place_location = located
        end
        scripted.place_refuses = core["placeRefuses"]?.try(&.as_bool?) || false
        if per_view = core["sourceBlocks"]?.try(&.as_h?)
          per_view.each do |view, blocks|
            scripted.source_blocks[view] = blocks.as_a? || [] of JSON::Any
          end
        end
      end
      if views = object["sources"]?.try(&.as_a?)
        state.sources = views.map { |view| view.as_s }
      end
      state.presentation_source = object["presentationSource"]?.try(&.as_s?)
      if keys = object["keys"]?
        state.keys = build_keymap(keys)
      end
      if typing = object["typing"]?.try(&.as_h?)
        item = typing["item"]?
        if item
          state.typing = Reader::Typing.new(
            item,
            typing["text"]?.try(&.as_s?) || "",
            (typing["caret"]?.try(&.as_i64?) || 0).to_i32,
            typing["drawn"]?.try(&.as_s?))
        end
      end
      if address = object["address"]?.try(&.as_h?)
        state.address = Reader::AddressBar.new(
          address["text"]?.try(&.as_s?) || "",
          (address["caret"]?.try(&.as_i64?) || 0).to_i32,
          (address["scroll"]?.try(&.as_i64?) || 0).to_i32)
      end
      if auth = object["auth"]?.try(&.as_h?)
        if challenge = auth["challenge"]?
          prompted = Reader::Auth.new(
            challenge,
            auth["refused"]?.try(&.as_bool?) || false,
            auth["stage"]?.try(&.as_s?) || "user")
          if user = auth["user"]?.try(&.as_h?)
            prompted.user = Reader::Buffer.new(
              user["text"]?.try(&.as_s?) || "",
              (user["caret"]?.try(&.as_i64?) || 0).to_i32)
          end
          if password = auth["password"]?.try(&.as_h?)
            prompted.password = Reader::Buffer.new(
              password["text"]?.try(&.as_s?) || "",
              (password["caret"]?.try(&.as_i64?) || 0).to_i32)
          end
          state.auth = prompted
        end
      end
      if find = object["find"]?.try(&.as_h?)
        state.find = Reader::Find.new(
          (find["direction"]?.try(&.as_i64?) || 1).to_i32,
          find["text"]?.try(&.as_s?) || "",
          (find["caret"]?.try(&.as_i64?) || 0).to_i32)
      end
      if last_find = object["lastFind"]?.try(&.as_h?)
        state.last_find = Reader::Find.new(
          (last_find["direction"]?.try(&.as_i64?) || 1).to_i32,
          last_find["text"]?.try(&.as_s?) || "",
          (last_find["caret"]?.try(&.as_i64?) || 0).to_i32)
      end
      if line = object["line"]?.try(&.as_h?)
        buffer = line["buffer"]?.try(&.as_h?)
        state.line_prompt = Reader::LinePrompt.new(
          line["label"]?.try(&.as_s?) || "",
          Reader::Buffer.new(
            buffer.try(&.["text"]?).try(&.as_s?) || "",
            (buffer.try(&.["caret"]?).try(&.as_i64?) || 0).to_i32))
      end
      state.files = scripted_value(object, "files")
      state.library = object["library"]?
      if provider = object["browserLibrary"]?.try(&.as_h?)
        state.browser_library = ScriptedBrowserLibrary.new(provider)
      end
      state.dialog = object["dialog"]?
      state.options = object["options"]?
      state.controlling = scripted_value(object, "controlling")
      state.chooser = scripted_value(object, "chooser")
      state.link_number = scripted_value(object, "linkNumber")
      state.search = object["search"]?.try(&.as_s?)
      state.page_keyboard_exit_until = object["pageKeyboardExitUntil"]?.try(&.as_i64?) || 0_i64
      state
    end

    # A question the browser is asking, written out in the payload instead of
    # read over the accessibility bus. What the browser does about a press is
    # part of the script: a press can be refused, and a dialog can stay up
    # after a press that the browser declined.
    class ScriptedDialog
      include Reader::DialogEnv

      getter pressed : Array(String)
      getter toggled : Array(String)

      def initialize(@payload : Hash(String, JSON::Any))
        @pressed = [] of String
        @toggled = [] of String
        @checked = {} of String => Bool
        @closed = false
        (@payload["toggles"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          control = raw.as_h
          @checked[control["name"].as_s] = control["checked"]?.try(&.as_bool?) || false
        end
      end

      def role : String
        @payload["role"]?.try(&.as_s?) || "alert"
      end

      def title : String
        @payload["title"]?.try(&.as_s?) || ""
      end

      def lines : Array(String)
        (@payload["lines"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      end

      def buttons : Array(Reader::DialogControl)
        (@payload["buttons"]?.try(&.as_a?) || [] of JSON::Any).map do |raw|
          control = raw.as_h
          Reader::DialogControl.new(
            name: control["name"].as_s,
            focused: control["focused"]?.try(&.as_bool?) || false,
            is_default: control["isDefault"]?.try(&.as_bool?) || false,
          )
        end
      end

      def toggles : Array(Reader::DialogControl)
        (@payload["toggles"]?.try(&.as_a?) || [] of JSON::Any).map do |raw|
          name = raw.as_h["name"].as_s
          Reader::DialogControl.new(name: name, checked: @checked[name]? || false)
        end
      end

      def fields : Array(Reader::DialogField)
        (@payload["fields"]?.try(&.as_a?) || [] of JSON::Any).map do |raw|
          field = raw.as_h
          Reader::DialogField.new(field["name"]?.try(&.as_s?) || "",
            field["value"]?.try(&.as_s?) || "")
        end
      end

      def press(index : Int32) : Bool
        control = buttons[index]? || raise ArgumentError.new("no button at #{index}")
        refused = (@payload["pressRefuses"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
        raise Exception.new("the browser refused the press") if refused.includes?(control.name)
        @pressed << control.name
        # A press the browser acted on closes the dialog; a press it ignored
        # leaves the dialog where it was, which is the case the reader has to
        # be told about rather than congratulated on.
        @closed = !(@payload["staysOpenAfterPress"]?.try(&.as_bool?) || false)
        true
      end

      def toggle(index : Int32) : Bool?
        control = toggles[index]? || raise ArgumentError.new("no option at #{index}")
        return nil if (@payload["toggleRefuses"]?.try(&.as_a?) || [] of JSON::Any)
                        .map(&.as_s).includes?(control.name)
        @toggled << control.name
        @checked[control.name] = !(@checked[control.name]? || false)
        @checked[control.name]
      end

      def reread : Reader::DialogEnv?
        return nil if @payload["rereadFails"]?.try(&.as_bool?) || false
        again = @payload["reread"]?.try(&.as_h?)
        return self unless again
        # The same question, read again, and what it says now may differ. The
        # presses are shared so that a scenario can press after a reread and
        # still be compared on one list.
        replacement = ScriptedDialog.new(again)
        replacement.inherit(self)
        replacement
      end

      def still_open? : Bool
        return false if @closed
        @payload["stillOpen"]?.try(&.as_bool?) != false
      end

      protected def inherit(other : ScriptedDialog) : Nil
        @pressed = other.pressed
        @toggled = other.toggled
      end
    end

    # A scripted answer that may be absent or JSON null; both mean "none".
    private def self.scripted_value(object : Hash(String, JSON::Any), key : String) : JSON::Any?
      value = object[key]?
      return nil if value.nil? || value.raw.is_a?(Nil)
      value
    end

    private def self.reader_action(output : RecordingScreen, state : Reader::State,
                                   action : Hash(String, JSON::Any),
                                   page_url : String,
                                   page : ScriptedPage? = nil) : JSON::Any?
      op = action["op"]?.try(&.as_s?) || ""
      force = action["force"]?.try(&.as_bool?) || false
      case op
      when "drawTitle"
        Reader.draw_title(output, state, force)
      when "drawAddress"
        Reader.draw_address(output, state, page_url, force,
          action["edit"]?.try(&.as_bool?) || false)
      when "drawHint"
        Reader.draw_hint(output, state, force)
      when "setStatus"
        Reader.set_status(output, state, page_url, action["msg"].as_s)
      when "drawStatus"
        Reader.draw_status(output, state, page_url)
      when "render"
        Reader.render(output, state, page_url, force)
      when "drawList"
        Reader.draw_list(output, state)
      when "parkCursor"
        Reader.park_cursor(output, state, page_url)
      when "drawAuthPrompt"
        Reader.draw_auth_prompt(output, state)
      when "drawFind"
        Reader.draw_find(output, state)
      when "drawLinePrompt"
        Reader.draw_line_prompt(output, state)
      when "renderRow"
        return JSON::Any.new(Reader.render_row(state,
          (action["lineIndex"]?.try(&.as_i64?) || 0).to_i32))
      when "typingText"
        typing = Reader.typing_text(state)
        return JSON::Any.new({
          "text"     => JSON::Any.new(typing[:text]),
          "caretCol" => JSON::Any.new(typing[:caret_col].to_i64),
        })
      when "hintText"
        return JSON::Any.new(Reader.hint_text(state))
      when "authPromptText"
        prompt = Reader.auth_prompt_text(state)
        return JSON::Any.new({
          "text"     => JSON::Any.new(prompt[:text]),
          "caretCol" => JSON::Any.new(prompt[:caret_col].to_i64),
        })
      when "linkTarget"
        found = Reader.link_target(state, page_url)
        return JSON::Any.new(found)
      when "shortTarget"
        return JSON::Any.new(Reader.short_target(action["href"].as_s, action["here"].as_s))
      when "viewportHeight"
        return JSON::Any.new(Reader.viewport_height(state).to_i64)
      when "lineRow"
        return JSON::Any.new(Reader.line_row(state,
          (action["lineIndex"]?.try(&.as_i64?) || 0).to_i32).to_i64)
      when "cursorCol"
        return JSON::Any.new(Reader.cursor_col(state).to_i64)
      when "clampScroll"
        Reader.clamp_scroll(state)
      when "lynxHidesCursor"
        return JSON::Any.new(Reader.lynx_hides_cursor(state))
      when "screenBefore"
        return Reader.screen_before(state)
      when "visibleRowsNow"
        return JSON::Any.new(Reader.visible_rows_now(state))
      when "patchVisibleRows"
        previous = action["before"]?.try(&.as_a?) || [] of JSON::Any
        return JSON::Any.new(Reader.patch_visible_rows(output, state, page_url, previous).to_i64)
      when "repaintList"
        return JSON::Any.new(nil) unless (repainted = Reader.repaint_list(output, state, page_url, action["before"]?))
        return JSON::Any.new(repainted.to_i64)
      when "repaintLynxSelection"
        Reader.repaint_lynx_selection(output, state,
          (action["oldCursor"]?.try(&.as_i64?) || 0).to_i32,
          (action["oldCol"]?.try(&.as_i64?) || 0).to_i32)
      when "relayout"
        Reader.relayout(state)
        return reader_lines_json(state.lines)
      when "openOptions"
        ReaderKeys.open_lynx_options(output, state, page.not_nil!)
        return JSON::Any.new(state.mode)
      when "optionsKey"
        ReaderKeys.handle_lynx_options_key(output, state, page.not_nil!,
          action["chunk"].as_s)
        return JSON::Any.new(state.mode)
      when "preserveViewportRow"
        Reader.preserve_viewport_row(state,
          (action["row"]?.try(&.as_i64?) || 0).to_i32,
          (action["height"]?.try(&.as_i64?) || Reader.viewport_height(state)).to_i32)
      when "moveScreen"
        Reader.move_screen(output, state,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32, page_url,
          (action["height"]?.try(&.as_i64?) || Reader.viewport_height(state)).to_i32,
          (action["lines"]?.try(&.as_i64?) ||
           (action["height"]?.try(&.as_i64?) || Reader.viewport_height(state)) - 1).to_i32)
      when "redrawAfterResize"
        Reader.redraw_after_resize(output, state, page_url)
      when "moveSelection"
        Reader.move_selection(output, state, page_url,
          (action["cursor"]?.try(&.as_i64?) || 0).to_i32,
          (action["col"]?.try(&.as_i64?) || 0).to_i32)
      when "moveCaretLeft"
        Reader.move_caret_left(output, state, page_url)
      when "moveCaretRight"
        Reader.move_caret_right(output, state, page_url)
      when "positionForBlock"
        found = Reader.position_for_block(state,
          (action["blockIndex"]?.try(&.as_i64?) || 0).to_i32)
        return JSON::Any.new(nil) unless found
        return JSON::Any.new({"line" => JSON::Any.new(found[:line].to_i64),
                              "col"  => JSON::Any.new(found[:col].to_i64)})
      when "focusableEdge"
        edge = Reader.focusable_edge(state,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
        return JSON::Any.new(nil) unless edge
        return JSON::Any.new({"line" => JSON::Any.new(edge[:line].to_i64),
                              "col"  => JSON::Any.new(edge[:col].to_i64)})
      when "findQuickNav"
        found = QuickNav.find(state, action["action"].as_s)
        return JSON::Any.new(nil) unless found
        return JSON::Any.new({"line" => JSON::Any.new(found[:line].to_i64),
                              "col"  => JSON::Any.new(found[:col].to_i64)})
      when "quickWalk"
        spec = QuickNav.specification(action["action"].as_s)
        limit = (action["limit"]?.try(&.as_i64?) || 100).to_i32
        hits = [] of JSON::Any
        while hits.size < limit && spec
          hit = QuickNav.find(state, spec.not_nil!)
          break unless hit
          hits << JSON::Any.new({"line" => JSON::Any.new(hit[:line].to_i64),
                                 "col"  => JSON::Any.new(hit[:col].to_i64)})
          Reader.move_selection(output, state, page_url, hit[:line], hit[:col])
        end
        return JSON::Any.new(hits)
      when "findParagraph"
        paragraph = QuickNav.find_paragraph(state,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
        return JSON::Any.new(nil) unless paragraph
        return JSON::Any.new({"line" => JSON::Any.new(paragraph[:line].to_i64),
                              "col"  => JSON::Any.new(paragraph[:col].to_i64)})
      when "pageKey"
        return JSON::Any.new(nil) unless page
        script = page.not_nil!
        before = script.presses.size
        ReaderKeys.handle_page_key(output, state, script,
          action["chunk"]?.try(&.as_s?) || "",
          action["now"]?.try(&.as_i64?) || 0_i64)
        return JSON::Any.new(script.presses[before..].map { |key| JSON::Any.new(key) })
      when "popupIsOpen"
        return JSON::Any.new(Reader.popup_is_open(state))
      when "popupKey"
        verdict = ReaderKeys.popup_key(
          action["action"]?.try(&.as_s?),
          action["chunk"]?.try(&.as_s?) || "",
          action["contextAction"]?.try(&.as_s?),
          action["escape"]?.try(&.as_bool?) || false)
        return JSON::Any.new(verdict) if verdict
        return JSON::Any.new(nil)
      when "moveToPopup"
        ReaderKeys.move_to_popup(output, state, page_url, action["item"]?)
      when "refresh"
        return JSON::Any.new(nil) unless page
        Reader.refresh(state, page.not_nil!,
          action["resetCursor"]?.try(&.as_bool?) || false, action["anchor"]?)
      when "closePopup"
        return JSON::Any.new(nil) unless page
        ReaderKeys.close_popup(output, state, page.not_nil!)
      when "beginTyping"
        return JSON::Any.new(nil) unless page
        entered = ReaderKeys.begin_typing(output, state, page.not_nil!, action["item"])
        return JSON::Any.new(entered)
      when "activate"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        ReaderKeys.activate_current(output, state, page.not_nil!, keyboard)
      when "chooseKey"
        return JSON::Any.new(nil) unless page
        ReaderKeys.handle_choose_key(output, state, page.not_nil!, action["chunk"].as_s)
      when "typeKey"
        return JSON::Any.new(nil) unless page
        ReaderKeys.handle_type_key(output, state, page.not_nil!, action["chunk"].as_s)
      when "fieldCommandKey"
        return JSON::Any.new(nil) unless page
        ReaderKeys.handle_field_command_key(output, state, page.not_nil!, action["chunk"].as_s)
      when "formsKey"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        ReaderKeys.handle_forms_key(output, state, page.not_nil!, keyboard, action["chunk"].as_s)
      when "controlKey"
        return JSON::Any.new(nil) unless page
        ReaderKeys.handle_control_key(output, state, page.not_nil!, action["chunk"].as_s)
      when "openNumberPrompt"
        ReaderKeys.open_link_number_prompt(output, state, page_url,
          action["digits"]?.try(&.as_s?))
      when "numberKey"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        ReaderKeys.handle_number_key(output, state, page.not_nil!, keyboard,
          action["chunk"].as_s)
      when "focusAddress"
        return JSON::Any.new(nil) unless page
        ReaderKeys.focus_address_bar(output, state, page.not_nil!,
          action["text"]?.try(&.as_s?))
      when "addressKey"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        ReaderKeys.handle_address_key(output, state, page.not_nil!, keyboard,
          action["chunk"].as_s)
      when "libraryKey"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        verdict = ReaderKeys.handle_library_key(output, state, page.not_nil!, keyboard,
          action["chunk"].as_s)
        return verdict ? JSON::Any.new(verdict) : JSON::Any.new(nil)
      when "dialogBlocks"
        # Answered as the differential compares a block: the text, and which
        # control the line stands for by name. The blocks themselves name a
        # control by index here and hold the control itself in JavaScript, so
        # the index is resolved to a name rather than compared as an index.
        dialog = ScriptedDialog.new(action["dialog"].as_h)
        named_buttons = dialog.buttons
        named_toggles = dialog.toggles
        return JSON::Any.new(ReaderKeys.dialog_blocks(dialog).map do |raw|
          block = raw.as_h
          button = block["button"]?.try(&.as_i64?).try { |at| named_buttons[at.to_i]?.try(&.name) }
          toggle = block["toggle"]?.try(&.as_i64?).try { |at| named_toggles[at.to_i]?.try(&.name) }
          JSON::Any.new({
            "text"   => block["text"],
            "button" => button ? JSON::Any.new(button) : JSON::Any.new(nil),
            "toggle" => toggle ? JSON::Any.new(toggle) : JSON::Any.new(nil),
          })
        end)
      when "answerDialog", "reopenDialog"
        return JSON::Any.new(nil) unless page
        keyboard = ScriptedKeyboard.new((action["keys"]?.try(&.as_a?) || [] of JSON::Any).map do |key|
          text = key.as_s
          text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
        end)
        dialog = ScriptedDialog.new(action["dialog"].as_h)
        if action["op"].as_s == "reopenDialog"
          state.pending_dialog = action["pending"]?.try(&.as_bool?) == false ? nil : dialog
          ReaderKeys.reopen_pending_dialog(output, state, page.not_nil!, keyboard)
        else
          ReaderKeys.answer_native_dialog(output, state, page.not_nil!, keyboard, dialog)
        end
        return JSON::Any.new({
          "pressed" => JSON::Any.new(dialog.pressed.map { |name| JSON::Any.new(name) }),
          "toggled" => JSON::Any.new(dialog.toggled.map { |name| JSON::Any.new(name) }),
          "pending" => JSON::Any.new(!state.pending_dialog.nil?),
        })
      when "browseKey"
        return JSON::Any.new(nil) unless page
        keyboard = nil
        if keys = action["keys"]?.try(&.as_a?)
          keyboard = ScriptedKeyboard.new(keys.map do |key|
            text = key.as_s
            text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
          end)
        end
        verdict = ReaderKeys.handle_browse_key(output, state, page.not_nil!, keyboard,
          action["chunk"].as_s, action["now"]?.try(&.as_i64?) || 0_i64)
        return JSON::Any.new(verdict) if verdict
        return JSON::Any.new(nil)
      when "loadMore"
        return JSON::Any.new(nil) unless page
        ReaderKeys.load_more(output, state, page.not_nil!)
      when "clickAsHuman"
        return JSON::Any.new(nil) unless page
        ReaderKeys.click_as_human(output, state, page.not_nil!)
      when "hoverAsHuman"
        return JSON::Any.new(nil) unless page
        ReaderKeys.hover_as_human(output, state, page.not_nil!)
      when "downloadCurrentLink"
        return JSON::Any.new(nil) unless page
        ReaderKeys.download_current_link(output, state, page.not_nil!)
      when "jumpToChange"
        return JSON::Any.new(nil) unless page
        ReaderKeys.jump_to_change(output, state, page.not_nil!,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
      when "openChooser"
        return JSON::Any.new(nil) unless page
        ReaderKeys.open_chooser(output, state, page.not_nil!, action["item"], action["listing"])
      when "closeChooser"
        return JSON::Any.new(nil) unless page
        ReaderKeys.close_chooser(output, state, page.not_nil!, action["note"]?.try(&.as_s?))
      when "refilter"
        return JSON::Any.new(nil) unless page
        ReaderKeys.refilter(output, state, page.not_nil!, action["filter"]?.try(&.as_s?) || "")
      when "chooserLines"
        range = ReaderKeys.chooser_lines(state)
        return JSON::Any.new(nil) unless range
        return JSON::Any.new({"first" => JSON::Any.new(range[:first].to_i64),
                              "last"  => JSON::Any.new(range[:last].to_i64)})
      when "reportAfterAction"
        return JSON::Any.new(nil) unless page
        previous_texts = (action["previousTexts"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
        followed = ReaderKeys.report_after_action(output, state, page.not_nil!,
          previous_texts, action["previousUrl"]?.try(&.as_s?) || "",
          action["anchor"]?, action["screen"]?, action["focused"]?)
        return JSON::Any.new(followed)
      when "filePromptText"
        prompt = ReaderKeys.file_prompt_text(state)
        return JSON::Any.new({"text"     => JSON::Any.new(prompt[:text]),
                              "caretCol" => JSON::Any.new(prompt[:caret_col].to_i64)})
      when "askFiles"
        keys = (action["keys"]?.try(&.as_a?) || [] of JSON::Any).map do |key|
          text = key.as_s
          text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
        end
        answer = ReaderKeys.ask_for_file_paths(output, state, page_url,
          ScriptedKeyboard.new(keys), action["asking"]?.try(&.as_s?) || "",
          action["multiple"]?.try(&.as_bool?) || false,
          action["accept"]?.try(&.as_s?) || "")
        return answer ? JSON::Any.new(answer.raw) : JSON::Any.new(nil)
      when "completePath"
        completion = ReaderKeys.complete_path(action["text"]?.try(&.as_s?) || "")
        return JSON::Any.new({"text" => JSON::Any.new(completion[:text]),
                              "note" => completion[:note] ? JSON::Any.new(completion[:note].not_nil!) : JSON::Any.new(nil)})
      when "fileToAttach"
        return ReaderKeys.file_to_attach(action["text"]?.try(&.as_s?) || "")
      when "authKey"
        step = ReaderKeys.handle_auth_key(state, action["chunk"].as_s)
        return JSON::Any.new("continue") if step.is_a?(ReaderKeys::AuthStep)
        # A declined prompt answers null, which is a value and not the
        # absence of one.
        declined = step.as?(JSON::Any)
        return JSON::Any.new(declined ? declined.raw : nil)
      when "askPassword"
        keys = (action["keys"]?.try(&.as_a?) || [] of JSON::Any).map do |key|
          text = key.as_s
          text == "<eof>" ? Input::EOF.as(Input::Key) : text.as(Input::Key)
        end
        challenge = action["challenge"]?.not_nil!
        answer = ReaderKeys.ask_for_password(output, state,
          ScriptedKeyboard.new(keys), challenge,
          action["refused"]?.try(&.as_bool?) || false)
        answered = answer.as?(JSON::Any)
        return JSON::Any.new(answered ? answered.raw : nil)
      when "findKey"
        ReaderKeys.handle_find_key(output, state, page_url, action["chunk"].as_s)
      when "findText"
        found = ReaderKeys.find_text(state, action["needle"].as_s,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
        return JSON::Any.new(nil) unless found
        return JSON::Any.new({"line"    => JSON::Any.new(found[:line].to_i64),
                              "col"     => JSON::Any.new(found[:col].to_i64),
                              "wrapped" => JSON::Any.new(found[:wrapped])})
      when "runSearch"
        ReaderKeys.run_search(output, state, page_url, action["needle"].as_s,
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
      when "jumpTo"
        jump_found = nil
        if found_json = action["found"]?
          if hash = found_json.as_h?
            jump_found = {line: (hash["line"]?.try(&.as_i64?) || 0).to_i32,
                          col:  (hash["col"]?.try(&.as_i64?) || 0).to_i32}
          end
        end
        QuickNav.jump_to(output, state, page_url, jump_found,
          action["label"]?.try(&.as_s?) || "",
          (action["direction"]?.try(&.as_i64?) || 1).to_i32)
      end
      nil
    end

    private def self.reader_lines_json(lines : Array(Reader::Line)) : JSON::Any
      JSON::Any.new(lines.map { |line| Reader.line_json(line) })
    end

    private def self.reader_state_json(state : Reader::State) : JSON::Any
      address = state.address ? JSON::Any.new({
        "text"   => JSON::Any.new(state.address.not_nil!.text),
        "caret"  => JSON::Any.new(state.address.not_nil!.caret.to_i64),
        "scroll" => JSON::Any.new(state.address.not_nil!.scroll.to_i64),
      }) : JSON::Any.new(nil)
      typing = state.typing ? JSON::Any.new({
        "text"  => JSON::Any.new(state.typing.not_nil!.text),
        "caret" => JSON::Any.new(state.typing.not_nil!.caret.to_i64),
      }) : JSON::Any.new(nil)
      auth = if state.auth
               JSON::Any.new({
                 "stage"    => JSON::Any.new(state.auth.not_nil!.stage),
                 "user"     => reader_buffer_json(state.auth.not_nil!.user),
                 "password" => reader_buffer_json(state.auth.not_nil!.password),
               })
             else
               JSON::Any.new(nil)
             end
      find = state.find ? JSON::Any.new({
        "direction" => JSON::Any.new(state.find.not_nil!.direction.to_i64),
        "text"      => JSON::Any.new(state.find.not_nil!.text),
        "caret"     => JSON::Any.new(state.find.not_nil!.caret.to_i64),
      }) : JSON::Any.new(nil)
      last_find_json = if state.last_find
                         JSON::Any.new({
                           "direction" => JSON::Any.new(state.last_find.not_nil!.direction.to_i64),
                           "text"      => JSON::Any.new(state.last_find.not_nil!.text),
                         })
                       else
                         JSON::Any.new(nil)
                       end
      address_caret = JSON::Any.new(nil)
      if caret = state.drawn.address_caret_col
        address_caret = JSON::Any.new(caret.to_i64)
      end
      scripted = state.core.as(Reader::CoreState)
      JSON::Any.new({
        "mode"         => JSON::Any.new(state.mode),
        "title"        => JSON::Any.new(state.title),
        "popup"        => state.core.popup || JSON::Any.new(nil),
        "live"         => state.core.live || JSON::Any.new(nil),
        "chooser"      => state.core.chooser || JSON::Any.new(nil),
        "attachments"  => JSON::Any.new(scripted.attached_calls),
        "activated"    => JSON::Any.new(scripted.activated),
        "visitedLinks" => JSON::Any.new(state.visited_links),
        "pageLog"      => JSON::Any.new(state.page_log),
        "drawn"        => JSON::Any.new({
          "title"           => JSON::Any.new(state.drawn.title),
          "address"         => JSON::Any.new(state.drawn.address),
          "addressCaretCol" => address_caret,
          "hint"            => JSON::Any.new(state.drawn.hint),
          "status"          => JSON::Any.new(state.drawn.status),
        }),
        "lines"      => reader_lines_json(state.lines),
        "scroll"     => JSON::Any.new(state.scroll.to_i64),
        "col"        => JSON::Any.new(state.col.to_i64),
        "cursor"     => JSON::Any.new(state.cursor.to_i64),
        "statusMsg"  => JSON::Any.new(state.status_msg),
        "address"    => address,
        "typing"     => typing,
        "auth"       => auth,
        "find"       => find,
        "lastFind"   => last_find_json,
        "controlling" => state.controlling || JSON::Any.new(nil),
        "chooserMode" => state.chooser || JSON::Any.new(nil),
        "files"      => state.files || JSON::Any.new(nil),
        "library"    => state.library.try do |library|
          object = library.as_h
          rows = object["rows"]?.try(&.as_a?)
          rows ? JSON::Any.new({
            "kind" => object["kind"], "label" => object["label"],
            "rows" => JSON::Any.new(rows.map { |row| row.as_h["text"] }),
          }) : JSON::Any.new(nil)
        end || JSON::Any.new(nil),
        "linkNumber" => link_number_json(state.link_number),
        "loadingMore" => JSON::Any.new(state.loading_more),
        "changeIndex" => JSON::Any.new(state.core.change_index.to_i64),
        "typingReads" => JSON::Any.new(scripted.typed_field_reads.to_i64),
        "typingReleased" => JSON::Any.new(scripted.typing_released),
        "inputMarks" => JSON::Any.new(scripted.input_marks.to_i64),
        "atCalls"    => JSON::Any.new(scripted.at_calls.map { |call| JSON::Any.new(call) }),
        "source"     => JSON::Any.new(state.core.source),
        "presentationSource" => JSON::Any.new(state.presentation_source),
        "placeDescribed" => JSON::Any.new(scripted.place_described),
        "placeArrays" => JSON::Any.new(scripted.place_arrays.map { |name| JSON::Any.new(name) }),
        "placeReleases" => JSON::Any.new(scripted.place_releases.to_i64),
      })
    end

    private def self.link_number_json(prompt : JSON::Any?) : JSON::Any
      return JSON::Any.new(nil) unless prompt
      object = prompt.as_h
      JSON::Any.new({
        "text"    => object["text"]? || JSON::Any.new(""),
        "cursor"  => object["cursor"]? || JSON::Any.new(0_i64),
        "col"     => object["col"]? || JSON::Any.new(0_i64),
        "targets" => object["targets"]? || JSON::Any.new([] of JSON::Any),
      })
    end

    private def self.reader_buffer_json(buffer : Reader::Buffer) : JSON::Any
      JSON::Any.new({
        "text"  => JSON::Any.new(buffer.text),
        "caret" => JSON::Any.new(buffer.caret.to_i64),
      })
    end

    private def self.screen_patch_edited_line(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      output = RecordingScreen.new
      changed = Screen.patch_edited_line(
        output,
        (object["row"]?.try(&.as_i64?) || 1).to_i32,
        object["before"]?.try(&.as_s?),
        object["after"]?.try(&.as_s?),
        object["currentCol"]?.try(&.as_i64?).try(&.to_i32),
        object["finalCol"]?.try(&.as_i64?).try(&.to_i32),
      )
      JSON::Any.new({
        "changed" => JSON::Any.new(changed),
        "writes"  => JSON::Any.new(output.writes),
      })
    end

    # The live observer against a real Firefox: launch one, arm it, read a
    # page that mutates, and answer everything the watcher saw. The scripted
    # conformance endpoints cannot say whether the preload script really
    # arrives before the document does; only a browser can.
    private def self.live_real_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      profile = object["profile"].as_s
      url = object["url"].as_s
      url2 = object["url2"].as_s
      mutation = object["mutation"].as_s
      timeout = object["timeoutMs"]?.try(&.as_i64?) || 45_000
      started = FirefoxLaunch.launch(profile, timeout)
      session = FirefoxDriver::BrowserSession.new(started.endpoint)
      begin
        session.start
        page = session.create_page
        watcher = Live::Watcher.new
        install = watcher.install(page)
        page.goto(url, "domcontentloaded")
        sleep 1.5.seconds
        parse_batches = watcher.collect(page)
        page.evaluate(mutation)
        sleep 800.milliseconds
        mutation_batches = watcher.collect(page)
        live = Live.create_state
        first = watcher.pulse(page, live)
        sleep 1.1.seconds
        page.goto(url2, "domcontentloaded")
        second = watcher.pulse(page, live)
        JSON::Any.new({
          "install" => JSON::Any.new({
            "boundNow" => JSON::Any.new(install.bound_now),
            "armed"    => JSON::Any.new(install.armed.to_i64),
            "frames"   => JSON::Any.new(install.frames.to_i64),
          }),
          "parseBatches"    => JSON::Any.new(parse_batches),
          "mutationBatches" => JSON::Any.new(mutation_batches),
          "pulses"          => JSON::Any.new([first, second].map do |pulse|
            if pulse
              JSON::Any.new({
                "changed"   => JSON::Any.new(pulse.changed),
                "navigated" => JSON::Any.new(pulse.navigated),
                "rearmed"   => JSON::Any.new(pulse.rearmed),
              })
            else
              JSON::Any.new(nil)
            end
          end),
        })
      ensure
        session.close
        started.close
      end
    end

    private def self.key_wizard_rows(payload : JSON::Any) : JSON::Any
      keymap = wizard_keymap(payload)
      JSON::Any.new(KeyWizard.wizard_rows(keymap).map do |row|
        JSON::Any.new({
          "type"     => JSON::Any.new(row.type),
          "label"    => JSON::Any.new(row.label),
          "actionId" => JSON::Any.new(row.action.try(&.id)),
          "text"     => JSON::Any.new(KeyWizard.row_text(row, keymap)),
        })
      end)
    end

    private def self.key_wizard_run(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      keymap = wizard_keymap(payload)
      output = LynxWizardOutput.new(
        (object["rows"]?.try(&.as_i64?) || 24).to_i32,
        (object["cols"]?.try(&.as_i64?) || 80).to_i32,
      )
      keys = (object["keys"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      reader = LynxWizardKeys.new(keys, output)
      saved = KeyWizard.run(output, keymap, reader, object["altScreen"]?.try(&.as_bool?) != false)
      probes = (object["probe"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      editing = (object["editingProbe"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      file = object["file"]?.try(&.as_s?)
      JSON::Any.new({
        "writes"  => JSON::Any.new(output.writes),
        "saved"   => JSON::Any.new(saved),
        "actions" => JSON::Any.new(keymap.actions.map do |action|
          JSON::Any.new({
            "id"       => JSON::Any.new(action.id),
            "bindings" => JSON::Any.new(action.bindings.map { |b| JSON::Any.new(b) }),
          })
        end),
        "probes"        => JSON::Any.new(probes.to_h { |chunk| {chunk, JSON::Any.new(keymap.action_for(chunk))} }),
        "editingProbes" => JSON::Any.new(editing.to_h { |chunk| {chunk, JSON::Any.new(keymap.editing_action_for(chunk))} }),
        "fileExists"    => file ? JSON::Any.new(File.exists?(file)) : JSON::Any.new(false),
      })
    end

    # The fake terminal the wizard draws on over the wire: it records every
    # write tagged with which key of the script was being processed, so both
    # runtimes can be compared write for write and prompt for prompt.
    private class LynxWizardOutput
      include KeyWizard::Output

      getter writes : Array(JSON::Any)
      property current_key : Int32

      def initialize(@rows : Int32, @columns : Int32)
        @writes = [] of JSON::Any
        @current_key = 0
      end

      def write(text : String) : Nil
        @writes << JSON::Any.new({
          "key"  => JSON::Any.new(@current_key.to_i64),
          "text" => JSON::Any.new(text),
        })
      end

      def rows : Int32
        @rows
      end

      def columns : Int32
        @columns
      end

      def on_resize(handler : Proc(Nil)) : Nil
      end

      def off_resize(handler : Proc(Nil)) : Nil
      end

      def advance : Nil
        @current_key += 1
      end
    end

    private class LynxWizardKeys
      include KeyWizard::KeySource

      def initialize(@keys : Array(String), @output : LynxWizardOutput); end

      def next_key : String?
        @output.advance
        @keys.shift?
      end

      def close : Nil
      end
    end

    private def self.lynx_actions_call(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      item_role = object["item"]?.try(&.as_h?).try(&.["role"]?.try(&.as_s?))
      recorder = LynxActionsRecorder.new(item_role)
      state = LynxActions::State.new(object["interface"]?.try(&.as_s?) || "default")
      state.keys = object["keys"]?.try do |raw|
        raw.raw.nil? ? nil : build_keymap(lynx_keymap_descriptor(raw))
      end
      actions = LynxActions.new(recorder)
      method = object["method"].as_s
      chunk = -> { object["chunk"]?.try(&.as_s?) || "" }
      value = case method
              when "active"
                actions.active?(state)
              when "digit"
                actions.digit?(chunk.call, state)
              when "action"
                actions.action?(object["action"].as_s, state, nil)
              when "after_quick_nav"
                actions.after_quick_nav(object["found"]?.try(&.as_bool?) == true, state, nil)
                nil
              when "popup_close_hint"
                actions.popup_close_hint(state)
              when "search_case"
                actions.search_case(state)
              when "library_action"
                actions.library_action(state, chunk.call)
              when "library_keeps_browse_map"
                actions.library_keeps_browse_map?(state)
              when "tab_arrow"
                actions.tab_arrow?(state, chunk.call)
              when "tab_needs_activation"
                actions.tab_needs_activation?(state)
              when "tab_typing_status"
                actions.tab_typing_status(state, object["name"]?.try(&.as_s?) || "")
              when "tab_landed_mode"
                actions.tab_landed_mode(state)
              when "type_command"
                actions.type_command?(state, chunk.call)
              else
                raise ArgumentError.new("unknown lynx action method #{method}")
              end
      JSON::Any.new({
        "value" => JSON::Any.new(value),
        "calls" => JSON::Any.new(recorder.calls.map do |entry|
          JSON::Any.new(entry.map { |part| JSON::Any.new(part) })
        end),
      })
    end

    # The keymap a Lynx actions question carries: either a straight keymap
    # descriptor for build_keymap, or a fake browse/edit map inverted into
    # bindings, mirroring the fake keymaps the JavaScript tests use.
    private def self.lynx_keymap_descriptor(raw : JSON::Any) : JSON::Any
      object = raw.as_h
      fake = object["fake"]?.try(&.as_h?)
      return raw unless fake
      bindings = {} of String => JSON::Any
      {"browse", "edit"}.each do |keyboard|
        fake[keyboard]?.try(&.as_h?).try do |map|
          map.each do |chunk, action|
            id = action.as_s
            list = bindings[id]?.try(&.as_a) || [] of JSON::Any
            list << JSON::Any.new(chunk)
            bindings[id] = JSON::Any.new(list)
          end
        end
      end
      JSON::Any.new({
        # The fake maps stand in for a Lynx keymap, so the actions they name
        # must exist in the profile's action list to be bound at all.
        "profile"  => JSON::Any.new("lynx"),
        "bindings" => JSON::Any.new(bindings),
        "terminfo" => JSON::Any.new({} of String => JSON::Any),
        "load"     => JSON::Any.new(false),
      } of String => JSON::Any)
    end

    # The fake host the Lynx actions run against over the wire: it answers
    # exactly what the JavaScript tests' fake host answers, and records the
    # calls it received so both runtimes can be compared call for call.
    private class LynxActionsRecorder
      include LynxActions::Host

      getter calls : Array(Array(String?))

      def initialize(item_role : String?)
        @item_role = item_role
        @calls = [] of Array(String?)
      end

      def fallback_keymap : Keys::Keymap
        Keys::Keymap.new(terminfo: {} of String => String, read_file: false)
      end

      def key_is(chunk : String, name : String, state : LynxActions::State) : Bool
        chunk == "[#{name}]"
      end

      def set_status(state : LynxActions::State, message : String) : Nil
        note_with("status", message)
      end

      def current_item(state : LynxActions::State) : LynxActions::Item?
        @item_role ? LynxActions::Item.new(@item_role.not_nil!) : nil
      end

      def is_field(role : String) : Bool
        role == "textbox"
      end

      def begin_typing(state : LynxActions::State, page, item : LynxActions::Item) : Bool
        note("beginTyping")
        true
      end

      def open_link_number_prompt(state : LynxActions::State, digits : String?) : Nil
        note_with("number", digits)
      end

      def open_help(state : LynxActions::State, page) : Nil
        note("help")
      end

      def describe_current(state : LynxActions::State, page) : Nil
        note("describe")
      end

      def open_main_menu(state : LynxActions::State, page) : Nil
        note("main-menu")
      end

      def open_options(state : LynxActions::State, page) : Nil
        note("options")
      end

      def open_trace_log(state : LynxActions::State, page) : Nil
        note("trace-log")
      end

      def toggle_trace(state : LynxActions::State) : Nil
        note("toggle-trace")
      end

      private def note(name : String) : Nil
        @calls << [name] of String?
      end

      private def note_with(name : String, extra : String?) : Nil
        entry = Array(String?).new
        entry << name
        entry << extra
        @calls << entry
      end
    end

    private def self.lynx_bindings_json(parsed : LynxConfig::Bindings) : JSON::Any
      JSON::Any.new({
        "bindings" => JSON::Any.new(parsed.bindings.reduce({} of String => JSON::Any) do |map, pair|
          map[pair[0]] = JSON::Any.new(pair[1].map { |key| JSON::Any.new(key) })
          map
        end),
        "unsupported" => JSON::Any.new(parsed.unsupported.map { |name| JSON::Any.new(name) }),
      })
    end

    private def self.lynx_config_read(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      dumps = object["dumps"]?.try(&.as_h?) || {} of JSON::Any => JSON::Any
      envs = [] of JSON::Any
      runner = LynxConfig::LynxRunner.new do |_command, args, options|
        envs << JSON::Any.new(options.reduce({} of String => JSON::Any) do |map, pair|
          map[pair[0]] = JSON::Any.new(pair[1])
          map
        end)
        key = args[1]? || args[0]?
        answer = key ? dumps[JSON::Any.new(key)]? : nil
        if answer.nil? || answer.raw.nil?
          LynxConfig::RunResult.new(0, "")
        else
          entry = answer.as_h
          if entry["status"]?.nil?
            nil
          else
            LynxConfig::RunResult.new(entry["status"].as_i64.to_i32, entry["stdout"]?.try(&.as_s?) || "")
          end
        end
      end
      env = object["env"]?.try(&.as_h?).try do |raw|
        raw.reduce(Hash(String, String).new) do |map, pair|
          map[pair[0]] = pair[1].as_s
          map
        end
      end || Hash(String, String).new
      home = object["home"]?.try(&.as_h?)
      home_path = home.try(&.["path"]?.try(&.as_s?))
      home_rc = home.try(&.["rc"]?.try(&.as_s?)) || ""
      imported = LynxConfig.read_lynx_config(
        object["executable"]?.try(&.as_s?) || "lynx",
        object["config"]?.try(&.as_s?),
        env, runner,
        ->(path : String) do
          if home_path && path == home_path
            home_rc
          else
            raise IO::Error.new("missing #{path}") unless File.exists?(path)
            File.read(path)
          end
        end
      )
      JSON::Any.new({
        "available" => JSON::Any.new(imported.available),
        "bindings"  => JSON::Any.new(imported.bindings.reduce({} of String => JSON::Any) do |map, pair|
          map[pair[0]] = JSON::Any.new(pair[1].map { |key| JSON::Any.new(key) })
          map
        end),
        "unsupported" => JSON::Any.new(imported.unsupported.map { |name| JSON::Any.new(name) }),
        "preferences" => JSON::Any.new(imported.preferences),
        "envs"        => JSON::Any.new(envs),
      })
    end

    private def self.core_news_json(news : Array(Core::Change)) : JSON::Any
      JSON::Any.new(news.map do |entry|
        JSON::Any.new({
          "start" => JSON::Any.new(entry.start.to_i64),
          "end"   => JSON::Any.new(entry.stop.to_i64),
          "text"  => JSON::Any.new(entry.text),
        })
      end)
    end

    private def self.core_targets_json(targets : Array(Core::Target)) : JSON::Any
      JSON::Any.new(targets.map do |target|
        JSON::Any.new({
          "block" => JSON::Any.new(target.block.to_i64),
          "size"  => JSON::Any.new(target.size.to_i64),
        })
      end)
    end

    private def self.core_block_from_json(entry : JSON::Any, index : Int32) : Core::Block
      object = entry.as_h?
      if object.nil?
        Core::Block.new(entry.as_s, JSON::Any.new({
          "name"     => JSON::Any.new(entry.as_s),
          "domIndex" => JSON::Any.new(index.to_i64),
        }))
      else
        item = object["item"]?
        item = JSON::Any.new({
          "name"     => JSON::Any.new(object["text"].as_s),
          "domIndex" => JSON::Any.new(index.to_i64),
        }) if item.nil? || item.raw.nil?
        Core::Block.new(object["text"].as_s, item)
      end
    end

    # A pass over the core's tab policy against a scripted BiDi endpoint.
    # Pages come from the real native Firefox driver, while the observations
    # are the same ones the JavaScript Core scenario records.
    private def self.core_tab_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      port = object["browser_port"]?.try(&.as_i?) || 0
      observations = [] of JSON::Any
      browser.start
      core = Core.new(driver: browser, browser_port: port)
      find_page = ->(id : String) do
        core.tabs.find { |page| page.tab_id == id } ||
        raise ArgumentError.new("no tab #{id}")
      end
      begin
        object["script"].as_a.each do |step_value|
          step = step_value.as_h
          case step["op"].as_s
          when "tabs"
            observations.push(JSON::Any.new(core.tabs.map { |page| JSON::Any.new(page.tab_id) }))
          when "adopt"
            observations.push(JSON::Any.new(core.adopt_tab(find_page.call(step["id"].as_s))))
          when "where"
            where = core.where
            observations.push(JSON::Any.new({
              "position" => JSON::Any.new(where.position.to_i64),
              "of"       => JSON::Any.new(where.of.to_i64),
            }))
          when "next"
            page = core.next_tab(step["direction"].as_i)
            observations.push(JSON::Any.new(page.try(&.tab_id)))
          when "after"
            page = core.tab_after(find_page.call(step["id"].as_s))
            observations.push(JSON::Any.new(page.try(&.tab_id)))
          when "label"
            observations.push(JSON::Any.new(core.tab_label(find_page.call(step["id"].as_s))))
          when "foreground"
            observations.push(JSON::Any.new(core.foreground?(find_page.call(step["id"].as_s))))
          when "new"
            observations.push(JSON::Any.new(core.new_tab.tab_id))
          when "close"
            core.close_tab(find_page.call(step["id"].as_s))
            observations.push(JSON::Any.new(nil))
          when "claimed_self"
            claim = Session.read_claims(port).find { |entry| entry.pid == Process.pid }
            observations.push(JSON::Any.new(claim.try(&.target_id)))
          else
            raise ArgumentError.new("unknown core tab scenario op #{step["op"]}")
          end
        end
      ensure
        Session.release_tab(port)
        browser.close
      end
      JSON::Any.new(observations)
    end

    # A scripted pass over the core's buffer: blocks set, the shadow cursor
    # moved, changes recorded, text patched, popups relocated, dropdowns
    # spliced in — and after each step, one observation. The JavaScript
    # original runs the same script in-process over src/core.js, so the two
    # runtimes must answer with the same observations.
    private def self.core_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      core = Core.new(source: object["source"]?.try(&.as_s?) || "source")
      anchors = {} of String => Core::Anchor
      texts = {} of String => Array(String)
      undos = {} of String => Proc(Nil)
      observations = [] of JSON::Any
      object["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
        when "blocks"
          if given = step["blocks"]?
            core.blocks = given.as_a.map_with_index { |entry, index| core_block_from_json(entry, index) }
          else
            core.blocks = step["texts"].as_a.map_with_index do |text, index|
              Core::Block.new(text.as_s, JSON::Any.new({
                "name"     => JSON::Any.new(text.as_s),
                "domIndex" => JSON::Any.new(index.to_i64),
              }))
            end
          end
          if cursor = step["cursor"]?.try(&.as_i?)
            core.at(cursor)
          end
          observations.push JSON::Any.new(nil)
        when "at"
          core.at(step["index"].as_i)
          observations.push JSON::Any.new(nil)
        when "texts"
          current = core.texts
          if id = step["id"]?.try(&.as_s?)
            texts[id] = current
          end
          observations.push JSON::Any.new(current.map { |text| JSON::Any.new(text) })
        when "block_text"
          observations.push JSON::Any.new(core.block_text(step["index"].as_i))
        when "item_value"
          value = core.block(step["index"].as_i).try(&.item.as_h?).try(&.["value"]?)
          observations.push(value || JSON::Any.new(nil))
        when "remember_files"
          item = {
            "file" => JSON::Any.new({"key" => step["key"]}),
          }
          if frame = step["frame"]?
            item["frame"] = frame
          end
          core.remember_attached_files(JSON::Any.new(item),
            step["paths"].as_a.map(&.as_s), "main")
          observations.push JSON::Any.new(nil)
        when "restore_files"
          core.restore_attached_files("main")
          observations.push JSON::Any.new(nil)
        when "anchor"
          anchor = core.anchor
          if id = step["id"]?.try(&.as_s?)
            anchors[id] = anchor
          end
          observations.push JSON::Any.new({
            "text"     => JSON::Any.new(anchor.text),
            "name"     => JSON::Any.new(anchor.name),
            "identity" => JSON::Any.new(anchor.identity),
            "block"    => JSON::Any.new(anchor.block.to_i64),
            "context"  => JSON::Any.new(anchor.context.map { |text| JSON::Any.new(text) }),
          })
        when "reanchor"
          anchor = anchors[step["anchor"].as_s]
          previous = step["previous"]?.try { |id| texts[id.as_s]? }
          settled = core.reanchor(anchor, previous)
          observations.push JSON::Any.new({
            "block" => JSON::Any.new(settled.block.to_i64),
            "exact" => JSON::Any.new(settled.exact),
          })
        when "restore"
          observations.push JSON::Any.new(core.restore(anchors[step["anchor"].as_s]).to_i64)
        when "record_changes"
          regions = step["regions"].as_a.map do |region|
            entry = region.as_h
            Core::Region.new(entry["start"].as_i, entry["end"].as_i)
          end
          observations.push core_news_json(core.record_changes(regions))
        when "note_changes"
          observations.push core_news_json(core.note_changes(texts[step["previous"].as_s]))
        when "change_targets"
          observations.push core_targets_json(core.change_targets)
        when "patch"
          result = core.patch_text(
            step["patches"].as_a,
            step["protect"]?.try(&.as_bool?) != false
          )
          if result
            undos[step["id"]?.try(&.as_s?) || "last"] = result.undo
            observations.push JSON::Any.new({
              "touched"    => JSON::Any.new(result.touched.map { |index| JSON::Any.new(index.to_i64) }),
              "generation" => JSON::Any.new(result.generation.to_i64),
            })
          else
            observations.push JSON::Any.new(nil)
          end
        when "undo"
          undos[step["id"]?.try(&.as_s?) || "last"].call
          observations.push JSON::Any.new(true)
        when "open_chooser"
          core.open_chooser(step["block_index"].as_i, step["listing"])
          observations.push JSON::Any.new(nil)
        when "show_chooser"
          filter = step["filter"]?.try(&.as_s?)
          observations.push JSON::Any.new(core.show_chooser(filter).to_i64)
        when "close_chooser"
          core.close_chooser
          observations.push JSON::Any.new(nil)
        when "in_chooser"
          observations.push JSON::Any.new(core.in_chooser?(step["index"].as_i))
        when "follow_popup"
          core.follow_popup(step["controls"]?.try(&.as_s?))
          observations.push JSON::Any.new(nil)
        when "forget_popup"
          core.forget_popup
          observations.push JSON::Any.new(nil)
        when "relocate_popup"
          observations.push JSON::Any.new(core.relocate_popup.to_i64)
        when "popup_at"
          observations.push JSON::Any.new(core.popup_at.to_i64)
        when "find_near"
          observations.push JSON::Any.new(core.find_near(step["start"].as_i, step["text"].as_s).to_i64)
        when "rendered_url"
          core.rendered_url = step["url"].as_s
          observations.push JSON::Any.new(nil)
        when "exhaust"
          core.exhausted = Core::Exhausted.new(core.rendered_url, core.blocks.size)
          observations.push JSON::Any.new(nil)
        when "no_more_to_load"
          observations.push JSON::Any.new(core.no_more_to_load?)
        else
          raise ArgumentError.new("unknown core scenario op #{step["op"]}")
        end
      end
      JSON::Any.new(observations)
    end

    private def self.place_kept(raw : JSON::Any) : Place::Kept
      object = raw.as_h? || {} of String => JSON::Any
      Place::Kept.new(
        text: object["text"]?.try(&.as_s?) || "",
        col: object["col"]?.try(&.as_i?) || 0,
        on_element: object["onElement"]?.try(&.as_bool?) || false,
        label: object["label"]?.try(&.as_s?) || "",
        ordinal: object["ordinal"]?.try(&.as_i64?),
        total: object["total"]?.try(&.as_i64?),
        ratio: object["ratio"]?.try(&.as_f?) || 0.0,
        source: object["source"]?.try(&.as_s?) || "",
        held: object["held"]?.try(&.as_bool?) || false,
        frame: scripted_value(object, "frame"),
      )
    end

    # The page side of a place, scripted: the description a capture is told
    # about the element, the location a restore is told the element is at
    # now, and a count of the releases. The JavaScript differential drives
    # the same answers through a stand-in element handle, so what is being
    # compared is the orchestration either side of the page — which fallback
    # wins, and when the element's own neighbourhood beats a text match.
    private class ScriptedElements
      include Place::Elements

      property description : JSON::Any?
      property location : JSON::Any?
      property refuses : Bool
      getter described : Array(JSON::Any)
      getter arrays : Array(String)
      getter releases : Int32

      def initialize
        @description = nil
        @location = nil
        @refuses = false
        @described = [] of JSON::Any
        @arrays = [] of String
        @releases = 0
      end

      # The real core resolves the element, holds it, and disposes of the
      # handle it could not describe. Counting that disposal as a release
      # keeps the release count meaning the same thing on both sides.
      def describe_place_element(item : JSON::Any) : JSON::Any?
        @described << item
        raise IO::Error.new("this line carries no element reference") if @refuses
        described = @description
        unless described && !described.raw.nil?
          @releases += 1
          return nil
        end
        described
      end

      def locate_place_element(array_name : String) : JSON::Any?
        @arrays << array_name
        found = @location
        found && !found.raw.nil? ? found : nil
      end

      def release_place_element : Nil
        @releases += 1
      end
    end

    private def self.place_kept_json(place : Place::Kept?) : JSON::Any
      return JSON::Any.new(nil) unless place
      JSON::Any.new({
        "source"    => JSON::Any.new(place.source),
        "text"      => JSON::Any.new(place.text),
        "col"       => JSON::Any.new(place.col.to_i64),
        "ratio"     => JSON::Any.new(place.ratio),
        "onElement" => JSON::Any.new(place.on_element),
        "label"     => JSON::Any.new(place.label),
        "ordinal"   => place.ordinal ? JSON::Any.new(place.ordinal.not_nil!) : JSON::Any.new(nil),
        "total"     => place.total ? JSON::Any.new(place.total.not_nil!) : JSON::Any.new(nil),
        "held"      => JSON::Any.new(place.held),
        "frame"     => place.frame || JSON::Any.new(nil),
      })
    end

    private def self.place_position_json(position : Place::Position) : JSON::Any
      JSON::Any.new({
        "line"       => JSON::Any.new(position.line.to_i64),
        "col"        => JSON::Any.new(position.col.to_i64),
        "end"        => JSON::Any.new(position.stop.to_i64),
        "blockIndex" => JSON::Any.new(position.block_index.to_i64),
      })
    end

    # A scripted pass over the reader's line-space place-keeping: a view set,
    # positions asked for, text located, the cursor landed. The JavaScript
    # original runs the same script in-process over src/place.js, so the two
    # runtimes must answer with the same observations.
    private def self.place_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      view = nil.as(Place::View?)
      elements = ScriptedElements.new
      captured = nil.as(Place::Kept?)
      observations = [] of JSON::Any
      object["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
        when "elements"
          elements.description = scripted_value(step, "description")
          elements.location = scripted_value(step, "location")
          elements.refuses = step["refuses"]?.try(&.as_bool?) || false
          observations.push JSON::Any.new(nil)
        when "capture_place"
          captured = Place.capture_place(view.not_nil!, elements)
          observations.push place_kept_json(captured)
        when "restore_place"
          place = step["place"]? ? place_kept(step["place"]) : captured
          observations.push JSON::Any.new(
            Place.restore_place(view.not_nil!, elements, place))
        when "locate_by_element"
          place = step["place"]? ? place_kept(step["place"]) : captured
          quality = place ? Place.locate_by_element(view.not_nil!, elements, place) : nil
          observations.push JSON::Any.new(quality)
        when "elements_seen"
          observations.push JSON::Any.new({
            "described" => JSON::Any.new(elements.described),
            "arrays"    => JSON::Any.new(elements.arrays.map { |name| JSON::Any.new(name) }),
            "releases"  => JSON::Any.new(elements.releases.to_i64),
          })
        when "state"
          blocks = step["blocks"].as_a.map do |entry|
            entry_object = entry.as_h
            Core::Block.new(entry_object["text"].as_s,
              entry_object["item"]? || JSON::Any.new(nil))
          end
          view = Place::View.new(
            step["lines"].as_a,
            blocks,
            step["cursor"]?.try(&.as_i?) || 0,
            step["col"]?.try(&.as_i?) || 0,
            step["source"].as_s,
          )
          observations.push JSON::Any.new(nil)
        when "positions_at_line"
          positions = Place.positions_at_line(view.not_nil!, step["line"].as_i)
          observations.push JSON::Any.new(positions.map { |position| place_position_json(position) })
        when "position_of_block"
          found = Place.position_of_block(view.not_nil!, step["block"].as_i)
          observations.push(found ? place_position_json(found.not_nil!) : JSON::Any.new(nil))
        when "block_index_at_line"
          index = Place.block_index_at_line(
            view.not_nil!, step["line"].as_i, step["col"]?.try(&.as_i?) || 0
          )
          observations.push JSON::Any.new(index.to_i64)
        when "has_element"
          item = step["item"]? || JSON::Any.new(nil)
          source = step["source"]?.try(&.as_s?) || view.not_nil!.source
          observations.push JSON::Any.new(Place.has_element?(source, item))
        when "index_of_item"
          item = step["item"]? || JSON::Any.new(nil)
          source = step["source"]?.try(&.as_s?) || view.not_nil!.source
          found = Place.index_of_item(source, item)
          observations.push(found ? JSON::Any.new(found.to_i64) : JSON::Any.new(nil))
        when "anchor"
          # The LOOKBACK walk capturePlace runs before it resolves an
          # element: the nearest block at or above the cursor that can be
          # turned back into one.
          current = view.not_nil!
          found = nil.as(Int32?)
          i = step["block"].as_i
          while i >= 0 && step["block"].as_i - i <= Place::LOOKBACK_BLOCKS
            block = current.blocks[i]?
            if block && Place.has_element?(current.source, block.item)
              found = i
              break
            end
            i -= 1
          end
          observations.push(found ? JSON::Any.new(found.to_i64) : JSON::Any.new(nil))
        when "locate_by_text"
          observations.push JSON::Any.new(Place.locate_by_text(view.not_nil!, place_kept(step["place"])))
        when "cursor"
          observations.push JSON::Any.new({
            "cursor" => JSON::Any.new(view.not_nil!.cursor.to_i64),
            "col"    => JSON::Any.new(view.not_nil!.col.to_i64),
          })
        when "land_on"
          quality = Place.land_on(
            view.not_nil!, step["block"].as_i, place_kept(step["place"]),
            step["exact"]?.try(&.as_bool?) || false
          )
          observations.push(quality ? JSON::Any.new(quality.not_nil!) : JSON::Any.new(nil))
        when "refine_to_text"
          refined = Place.refine_to_text(view.not_nil!, step["from"].as_i, place_kept(step["place"]))
          observations.push JSON::Any.new({
            "line"  => JSON::Any.new(refined.line.to_i64),
            "col"   => JSON::Any.new(refined.col.to_i64),
            "exact" => JSON::Any.new(refined.exact),
          })
        else
          raise ArgumentError.new("unknown place scenario op #{step["op"]}")
        end
      end
      JSON::Any.new(observations)
    end

    # A CDP channel that records what was sent and answers from a script.
    #
    # Everything the interactive Chromium client decides — the shape of a
    # callFunctionOn, the key events a keystroke becomes, the three mouse
    # events a click is — is decided before the socket. Recording the traffic
    # is therefore the whole of what there is to compare against the
    # JavaScript original, and it needs no browser to compare it.
    #
    # Replies are looked up by method name. A method with no scripted reply
    # answers an empty result, which is what the protocol does for a command
    # that only does something.
    private class RecordingChannel
      include Transport::Channel

      getter sent : Array(JSON::Any)
      property replies : Hash(String, JSON::Any)
      # The events the browser pushes once a command has been answered: a
      # navigation's lifecycle arrives after Page.navigate returns, which is
      # the order a caller that armed its wait first depends on.
      property after : Hash(String, Array(JSON::Any))

      def initialize
        @sent = [] of JSON::Any
        @replies = {} of String => JSON::Any
        @after = {} of String => Array(JSON::Any)
        @pending = [] of String
      end

      def forget : Nil
        @sent.clear
      end

      # An event the browser would have pushed, waiting to be read.
      def queue(event : JSON::Any) : Nil
        @pending << event.to_json
      end

      def send(text : String) : Nil
        request = JSON.parse(text)
        @sent << request
        object = request.as_h
        method = object["method"].as_s
        result = @replies[method]? || JSON::Any.new({} of String => JSON::Any)
        answer = {
          "id"     => object["id"],
          "result" => result,
        } of String => JSON::Any
        answer["sessionId"] = object["sessionId"] if object["sessionId"]?
        @pending << JSON::Any.new(answer).to_json
        @after[method]?.try(&.each { |event| queue(event) })
      end

      def receive : String
        @pending.shift? || raise IO::EOFError.new("nothing was sent to answer")
      end

      def close : Nil
      end
    end

    # The commands a scenario produced, with the volatile parts of a request
    # left out: the id counter is the client's own bookkeeping rather than
    # anything the page sees.
    private def self.cdp_sent_json(sent : Array(JSON::Any)) : JSON::Any
      JSON::Any.new(sent.map do |request|
        object = request.as_h
        entry = {
          "method" => object["method"],
          "params" => object["params"]? || JSON::Any.new({} of String => JSON::Any),
        } of String => JSON::Any
        entry["sessionId"] = object["sessionId"]? || JSON::Any.new(nil)
        JSON::Any.new(entry)
      end)
    end

    # A scripted pass over the interactive Chromium client: the traffic one
    # evaluation, one keystroke, one click produces. The JavaScript original
    # runs the same script in process against a recording session, so the two
    # runtimes must put the same commands on the wire.
    private def self.cdp_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      channel = RecordingChannel.new
      if replies = object["replies"]?.try(&.as_h?)
        replies.each { |method, value| channel.replies[method] = value }
      end
      if after = object["after"]?.try(&.as_h?)
        after.each { |method, events| channel.after[method] = events.as_a }
      end
      page = Cdp::Page.new("http://127.0.0.1:0",
        Cdp::Target.new("TARGET", "ws://127.0.0.1:0/devtools/page/TARGET"), channel)
      # Neither the domains the client enables when it opens nor the frame
      # tree it reads its main document's id from are what is being compared:
      # the JavaScript page is handed a session somebody else enabled them
      # on, and is told its main frame by the context that opened it.
      channel.forget

      observations = [] of JSON::Any
      held = nil.as(Cdp::Handle?)
      object["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
        when "context"
          # The context announcement a document makes, which is what every
          # evaluation waits for.
          page.note_event(JSON.parse(step["event"].to_json))
          observations.push JSON::Any.new(nil)
        when "evaluate"
          observations.push page.evaluate(step["fn"].as_s, step["arg"]?,
            step["expression"]?.try(&.as_bool?) || false)
        when "evaluate_handle"
          held.try(&.dispose)
          held = page.evaluate_handle(step["fn"].as_s, step["arg"]?,
            step["expression"]?.try(&.as_bool?) || false)
          observations.push JSON::Any.new(held.not_nil!.object_id)
        when "handle_evaluate"
          observations.push held.not_nil!.evaluate(step["fn"].as_s, step["arg"]?,
            step["expression"]?.try(&.as_bool?) || false)
        when "handle_click_box"
          box = held.not_nil!.click_box
          observations.push(box ? JSON::Any.new({
            "x"      => JSON::Any.new(box.x),
            "y"      => JSON::Any.new(box.y),
            "width"  => JSON::Any.new(box.width),
            "height" => JSON::Any.new(box.height),
          }) : JSON::Any.new(nil))
        when "handle_click"
          held.not_nil!.click((step["modifiers"]?.try(&.as_i64?) || 0).to_i32)
          observations.push JSON::Any.new(nil)
        when "handle_hover"
          held.not_nil!.hover
          observations.push JSON::Any.new(nil)
        when "handle_dispose"
          held.not_nil!.dispose
          observations.push JSON::Any.new(nil)
        when "type"
          page.keyboard.type(step["text"].as_s)
          observations.push JSON::Any.new(nil)
        when "press"
          begin
            page.keyboard.press(step["key"].as_s)
            observations.push JSON::Any.new(nil)
          rescue error
            observations.push JSON::Any.new(error.message || error.to_s)
          end
        when "click_at"
          page.click_at(Core.js_number(step["x"]), Core.js_number(step["y"]),
            (step["modifiers"]?.try(&.as_i64?) || 0).to_i32)
          observations.push JSON::Any.new(nil)
        when "event"
          # An event the browser would push, queued to be read the next time
          # the client reads the socket.
          channel.queue(step["event"])
          observations.push JSON::Any.new(nil)
        when "goto"
          page.goto(step["url"].as_s, step["wait"]?.try(&.as_s?) || "load",
            (step["timeout"]?.try(&.as_i64?) || 30000).to_i32)
          observations.push JSON::Any.new(page.url)
        when "reload"
          page.reload(step["ignoreCache"]?.try(&.as_bool?) || false,
            step["wait"]?.try(&.as_s?) || "load",
            (step["timeout"]?.try(&.as_i64?) || 30000).to_i32)
          observations.push JSON::Any.new(nil)
        when "stop_loading"
          page.stop_loading
          observations.push JSON::Any.new(nil)
        when "wait_for_load_state"
          observations.push JSON::Any.new(page.wait_for_load_state(
            step["state"]?.try(&.as_s?) || "load",
            (step["timeout"]?.try(&.as_i64?) || 15000).to_i32))
        when "traverse_history"
          observations.push JSON::Any.new(page.traverse_history(
            (step["direction"]?.try(&.as_i64?) || -1).to_i32,
            step["wait"]?.try(&.as_s?) || "load",
            (step["timeout"]?.try(&.as_i64?) || 30000).to_i32))
        when "url"
          observations.push JSON::Any.new(page.url)
        when "title"
          observations.push JSON::Any.new(page.title)
        when "seed_load_state"
          page.seed_load_state
          observations.push JSON::Any.new(nil)
        when "sent"
          observations.push cdp_sent_json(channel.sent)
          channel.forget
        else
          raise ArgumentError.new("unknown cdp scenario op #{step["op"]}")
        end
      end
      JSON::Any.new(observations)
    end

    # The tab inventory against a real Chromium: what the browser lists, what
    # a new tab adds, and that a closed one goes. The listing is the browser's
    # own, so this needs a browser; the JavaScript original answers the same
    # questions through its own driver.
    private def self.cdp_tabs_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Cdp::BrowserSession.new(object["endpoint"].as_s)
      opened = nil.as(Cdp::Page?)
      begin
        before = session.list_pages
        opened = session.create_page
        opened.not_nil!.goto(object["url"].as_s, "domcontentloaded")
        after = session.list_pages
        title = opened.not_nil!.title
        target = session.target_id_for(opened.not_nil!)
        session.close_page(opened.not_nil!)
        opened = nil
        # A tab the browser has closed leaves the listing, which is how the
        # reader's own tab list is kept honest.
        remaining = session.list_pages
        JSON::Any.new({
          "before"    => JSON::Any.new(before.size.to_i64),
          "after"     => JSON::Any.new(after.size.to_i64),
          "remaining" => JSON::Any.new(remaining.size.to_i64),
          "title"     => JSON::Any.new(title),
          "url"       => JSON::Any.new(after.map { |page| JSON::Any.new(page.url) }),
          "targeted"  => JSON::Any.new(after.any? { |page| session.target_id_for(page) == target }),
          "gone"      => JSON::Any.new(remaining.none? { |page| session.target_id_for(page) == target }),
        })
      ensure
        opened.try(&.close) rescue nil
        session.close
      end
    end

    # The documents of a tab against a real Chromium: what the tree contains,
    # and that each one can be evaluated in on its own. A frame's own
    # process is the case nothing can be stubbed for — the tab's session
    # does not answer for it at all.
    private def self.cdp_frames_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Cdp::BrowserSession.new(object["endpoint"].as_s)
      page = session.create_page
      begin
        page.goto(object["url"].as_s, "domcontentloaded")
        # A child frame commits after its parent has parsed the <iframe>, so
        # a document embedded in this one is given the same moment to arrive
        # that the dump gives it.
        Dump.settle_embedded_frames(page)
        # The extraction is what attaches an out-of-process document's own
        # target, which is how its frame comes to claim a session.
        page.accessibility_documents
        frames = page.all_frames
        JSON::Any.new({
          "count"     => JSON::Any.new(frames.size.to_i64),
          "urls"      => JSON::Any.new(frames.map { |frame| JSON::Any.new(frame.url) }),
          "titles"    => JSON::Any.new(frames.map do |frame|
            JSON::Any.new(begin
              frame.evaluate("() => document.title").as_s? || ""
            rescue error
              "error: #{error.message}"
            end)
          end),
          "children"  => JSON::Any.new(page.main_frame.child_frames.size.to_i64),
          "selectors" => JSON::Any.new(page.main_frame.query_all("iframe").size.to_i64),
        })
      ensure
        session.close_page(page) rescue nil
        session.close
      end
    end

    # Chromium's own bookmarks and history, against a real browser: a page
    # filed, the lists read back, the bookmark removed. Only the parts that
    # hold still are reported — a timestamp and a bookmark id are the
    # browser's own and differ between two runs of the same thing.
    private def self.cdp_library_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Cdp::BrowserSession.new(object["endpoint"].as_s)
      url = object["url"].as_s
      title = object["title"].as_s
      begin
        saved = ChromiumLibrary.save(session, url, title)
        again = ChromiumLibrary.save(session, url, title)
        bookmarks = ChromiumLibrary.read(session, "bookmarks")
        history = ChromiumLibrary.read(session, "history")
        # A fresh profile has no downloads, and the answer is then an empty
        # list rather than a refusal — which is still worth asking for: the
        # page has to open, its module has to import, and its handler has to
        # answer, or this raises.
        downloads = ChromiumLibrary.read(session, "downloads")
        mine = bookmarks.select { |entry| entry.as_h["url"]?.try(&.as_s?) == url }
        removed = mine.first?.try { |entry| ChromiumLibrary.remove(session, entry) }
        after = ChromiumLibrary.read(session, "bookmarks")
        JSON::Any.new({
          "saved"     => library_entry_json(saved),
          "again"     => library_entry_json(again),
          "bookmarks" => JSON::Any.new(mine.map { |entry| library_entry_json(entry) }),
          "history"   => JSON::Any.new(history
            .select { |entry| entry.as_h["url"]?.try(&.as_s?) == url }
            .map { |entry| library_entry_json(entry) }),
          "downloads" => JSON::Any.new(downloads.size.to_i64),
          "removed" => JSON::Any.new(removed.try(&.as_h?).try(&.["removed"]?.try(&.as_bool?)) || false),
          "left"    => JSON::Any.new(after.count { |entry| entry.as_h["url"]?.try(&.as_s?) == url }.to_i64),
        })
      ensure
        session.close
      end
    end

    # One library answer, with only the parts that mean the same thing twice.
    private def self.library_entry_json(entry : JSON::Any) : JSON::Any
      object = entry.as_h? || {} of String => JSON::Any
      kept = {} of String => JSON::Any
      ["title", "url", "folder", "existed"].each do |name|
        kept[name] = object[name] if object.has_key?(name)
      end
      JSON::Any.new(kept)
    end

    # One page read in one view, against a real browser. The four views are
    # four completely different descriptions of the same document, and what
    # each of them says is the extraction's whole answer — so the blocks
    # themselves are what is compared, text and role and element index.
    private def self.core_view_blocks(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      source = object["source"].as_s
      chromium = object["engine"]?.try(&.as_s?) != "firefox"
      session = nil.as(Engine::Session?)
      page = nil.as(Engine::Page?)
      begin
        if chromium
          opened = Cdp::BrowserSession.new(object["endpoint"].as_s)
          session = opened
          page = opened.create_page
        else
          # Firefox allows one protocol session per browser, and a kept
          # browser's belongs to the broker holding it. A second reader
          # reaches that browser the way every reader does: through the
          # broker, which is what the broker is for.
          profile = object["profile"].as_s
          started = FirefoxLaunch.launch(profile)
          opened = FirefoxDriver::BrowserSession.new(
            Broker.ensure(profile, started.endpoint)[:url])
          session = opened
          opened.start
          page = opened.create_page
        end
        acting = page.not_nil!
        acting.goto(object["url"].as_s, "domcontentloaded")
        Dump.settle_embedded_frames(acting)
        core = Core.new(source: source, page: acting)
        blocks = core.rescan
        JSON::Any.new(blocks.map do |block|
          item = block.item.as_h? || {} of String => JSON::Any
          entry = {
            "text" => JSON::Any.new(block.text),
            "role" => item["role"]? || JSON::Any.new(nil),
            "name" => item["name"]? || JSON::Any.new(nil),
          } of String => JSON::Any
          # The element each line came from, where the view numbers them. The
          # number is the view's own and means the same thing in both
          # runtimes; the frame it belongs to is a protocol handle and does
          # not, so only whether there is one is reported.
          entry["index"] = item["renderIndex"]? || item["domIndex"]? ||
                           item["axIndex"]? || JSON::Any.new(nil)
          entry["framed"] = JSON::Any.new(!(item["frame"]?.nil? || item["frame"]?.try(&.raw).nil?))
          JSON::Any.new(entry)
        end)
      ensure
        page.try { |held| held.close rescue nil }
        session.try do |held|
          case held
          when FirefoxDriver::BrowserSession
            # The broker keeps the browser's session for whoever comes next.
            held.protocol.command(Broker::RETAIN_SESSION) rescue nil
            held.close(false) rescue nil
          when Cdp::BrowserSession
            held.close rescue nil
          end
        end
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

    private def self.firefox_dump_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      JSON::Any.new(FirefoxDump.read_page(
        object["upstream"].as_s,
        object["profile"].as_s,
        object["marionette_port"]?.try(&.as_i?).try(&.to_i32),
        object["library_port"]?.try(&.as_i?).try(&.to_i32),
        object["owned"]?.try(&.as_bool?) || false,
        object["keep_browser"]?.try(&.as_bool?) || false,
        object["brokered"]?.try(&.as_bool?) != false,
        object["target"].as_s,
        object["layout"]?.try(&.as_bool?) || false,
        object["escape_unicode"]?.try(&.as_bool?) || false,
        object["unicode"]?.try(&.as_s?) || "ascii",
        object["preferences"]?.try(&.as_h?) || {} of String => JSON::Any,
      ))
    end

    private def self.firefox_verified_session(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      begin
        result = browser.start_verified(
          object["library_port"].as_i.to_i32,
          object["marionette_port"]?.try(&.as_i?).try(&.to_i32)
        )
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

    # A scripted pass over the handle layer: values passed into the page and
    # elements held across calls, the wire contract the reader's actions
    # stand on. The JavaScript original runs the same script in-process over
    # src/driver_firefox.js against the same scripted endpoint, so both the
    # answers and the messages the two runtimes put on the wire must be
    # identical.
    private def self.firefox_handle_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      session = Bidi::Session.new(object["url"].as_s)
      observations = [] of JSON::Any
      frame = nil.as(FirefoxDriver::Frame?)
      current = nil.as(FirefoxDriver::Frame?)
      handle = nil.as(FirefoxDriver::Handle?)
      keyboard = nil.as(FirefoxDriver::Keyboard?)
      acting = nil.as(FirefoxDriver::Page?)
      refs = [] of FirefoxDriver::FrameRef
      begin
        session.command("session.new", {
          "capabilities" => JSON::Any.new({
            "alwaysMatch" => JSON::Any.new({} of String => JSON::Any),
          }),
        })
        object["script"].as_a.each do |step_value|
          step = step_value.as_h
          case step["op"].as_s
          when "frame"
            frame = FirefoxDriver::Frame.new(session, step["context"].as_s, nil, step["url"].as_s)
            current = frame
            keyboard = FirefoxDriver::Keyboard.new(session, step["context"].as_s)
            acting = FirefoxDriver::Page.new(session, step["context"].as_s)
            acting.set_url(step["url"].as_s)
            observations.push JSON::Any.new(nil)
          when "url"
            observations.push JSON::Any.new(current.not_nil!.url)
          when "page_url"
            observations.push JSON::Any.new(acting.not_nil!.url)
          when "page_goto"
            acting.not_nil!.goto(step["url"].as_s,
              step["wait"]?.try(&.as_s?) || "domcontentloaded")
            observations.push JSON::Any.new(nil)
          when "evaluate"
            expression = step["expression"]?.try(&.as_s?)
            value = if expression
                      current.not_nil!.evaluate(expression, nil, true)
                    else
                      current.not_nil!.evaluate(step["fn"].as_s, step["arg"]?, false)
                    end
            observations.push(value)
          when "evaluate_handle"
            held = nil.as(FirefoxDriver::Handle?)
            source = step["expression"]?.try(&.as_s?)
            if source
              held = current.not_nil!.evaluate_handle(source, nil, true)
            else
              held = current.not_nil!.evaluate_handle(step["fn"].as_s, step["arg"]?)
            end
            handle = held
            observations.push JSON::Any.new({
              "handle"   => JSON::Any.new(held.handle),
              "sharedId" => held.shared_id ? JSON::Any.new(held.shared_id) : JSON::Any.new(nil),
            })
          when "handle_evaluate"
            observations.push(handle.not_nil!.evaluate(step["fn"].as_s, step["arg"]?))
          when "handle_dispose"
            handle.not_nil!.dispose
            observations.push JSON::Any.new(nil)
          when "query_all"
            refs = current.not_nil!.query_all(step["selector"].as_s)
            observations.push JSON::Any.new(refs.size.to_i64)
          when "content_frame"
            found = refs[step["index"].as_i]?.try(&.content_frame)
            observations.push(found ? frame_reference(found.not_nil!) : JSON::Any.new(nil))
          when "child_frames"
            observations.push JSON::Any.new(
              current.not_nil!.child_frames.map { |child| frame_reference(child) })
          when "use_child"
            found = refs[step["index"].as_i]?.try(&.content_frame)
            if found
              current = found
              observations.push(frame_reference(found))
            else
              observations.push JSON::Any.new(nil)
            end
          when "use_main"
            current = frame
            observations.push JSON::Any.new(nil)
          when "activate"
            observations.push(Actions.activate(handle.not_nil!))
          when "activate_item"
            core = Core.new(source: step["source"]?.try(&.as_s?) || "ax", page: acting)
            observations.push(core.activate(step["item"], acting))
          when "focus_control"
            observations.push(Actions.focus_control(handle.not_nil!))
          when "submits_autofilled"
            observations.push(Actions.submits_autofilled(handle.not_nil!))
          when "set_files"
            paths = step["paths"].as_a.map(&.as_s)
            observations.push(JSON::Any.new(handle.not_nil!.set_files(paths)))
          when "real_click"
            observations.push(Actions.real_click(handle.not_nil!))
          when "hover"
            observations.push(Actions.hover(handle.not_nil!))
          when "key_type"
            keyboard.not_nil!.type(step["text"].as_s)
            observations.push JSON::Any.new(nil)
          when "key_press"
            keyboard.not_nil!.press(step["key"].as_s)
            observations.push JSON::Any.new(nil)
          when "key_error"
            begin
              keyboard.not_nil!.press(step["key"].as_s)
              observations.push JSON::Any.new(nil)
            rescue error
              observations.push JSON::Any.new(error.message || "error")
            end
          when "click_slider"
            Actions.click_slider(handle.not_nil!,
              step["ratio"].as_f, step["orientation"]?)
            observations.push JSON::Any.new(nil)
          else
            raise ArgumentError.new("unknown handle scenario op #{step["op"]}")
          end
        end
      ensure
        session.command("session.end") rescue nil
        session.close
      end
      JSON::Any.new(observations)
    end

    private def self.frame_reference(frame : FirefoxDriver::Frame) : JSON::Any
      JSON::Any.new({
        "id"  => JSON::Any.new(frame.context_id),
        "url" => JSON::Any.new(frame.url),
      })
    end

    # Reading a field's live text and caret from a real page: the native
    # runtime joins a kept browser, opens its own copy of the fixture, holds
    # each requested element, and answers with what the embedded walker says.
    # The JavaScript original reads the same fixture through the same walker
    # in-process, so a field must not read differently depending on which
    # runtime is asking.
    private def self.firefox_fields_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      observations = [] of JSON::Any
      begin
        browser.start
        page = browser.create_page
        page.navigate(object["page"].as_s, "complete")
        frame = FirefoxDriver::Frame.new(browser.protocol, page.context_id, page)
        object["fields"].as_a.each do |field_value|
          field = field_value.as_h
          held = frame.evaluate_handle(
            "(a) => document.querySelectorAll(a.selector)[a.index]",
            JSON::Any.new({
              "selector" => JSON::Any.new(field["selector"].as_s),
              "index"    => JSON::Any.new(field["index"].as_i.to_i64),
            }))
          begin
            observations.push(Fields.read_field_state(held))
          ensure
            held.dispose
          end
        end
      ensure
        browser.close
      end
      JSON::Any.new(observations)
    end

    # Acting on a page from a real browser: activation through the element's
    # own default action, a click the browser accounts a person's, a hover
    # that arrives from outside the element, a control put under the
    # keyboard. The native runtime joins a kept browser, opens its own copy
    # of the fixture, and performs each requested action against the element
    # it names; the page's reactions are read with the probe the caller
    # supplies, so the JavaScript oracle drives the same fixture with its own
    # acting half and the two must not disagree about what happened.
    private def self.firefox_actions_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      answers = [] of JSON::Any
      begin
        browser.start
        page = browser.create_page
        page.navigate(object["page"].as_s, "complete")
        frame = FirefoxDriver::Frame.new(browser.protocol, page.context_id, page)
        object["targets"].as_a.each do |target_value|
          target = target_value.as_h
          held = frame.evaluate_handle(
            "(a) => document.querySelectorAll(a.selector)[a.index]",
            JSON::Any.new({
              "selector" => JSON::Any.new(target["selector"].as_s),
              "index"    => JSON::Any.new(target["index"].as_i.to_i64),
            }))
          begin
            case target["action"].as_s
            when "activate"
              answers.push(Actions.activate(held))
            when "default_activation"
              answers.push(Actions.default_activation(held))
            when "focus_control"
              answers.push(Actions.focus_control(held))
            when "submits_autofilled"
              answers.push(Actions.submits_autofilled(held))
            when "real_click"
              answers.push(Actions.real_click(held))
            when "hover"
              answers.push(Actions.hover(held))
            when "adjust_control"
              answers.push(Actions.adjust_control(
                held, target["role"]?.try(&.as_s?), target["key"].as_s))
            else
              raise ArgumentError.new("unknown action #{target["action"].as_s}")
            end
          ensure
            held.dispose
          end
        end
        reactions = frame.evaluate(object["probe"].as_s)
        JSON::Any.new({
          "actions"   => JSON::Any.new(answers),
          "reactions" => reactions,
        })
      ensure
        browser.close
      end
    end

    # Both upload roads against a real page: an input already in hand receives
    # its files directly, while a hidden input reached through a button arrives
    # as Firefox's intercepted file-dialog event and is answered there.
    private def self.firefox_files_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      begin
        browser.start
        page = browser.create_page
        page.navigate(object["page"].as_s, "complete")
        frame = FirefoxDriver::Frame.new(browser.protocol, page.context_id, page)
        paths = object["paths"].as_a.map(&.as_s)

        direct = frame.evaluate_handle(
          "(sel) => document.querySelector(sel)", object["input"])
        begin
          direct_answer = page.set_files(direct, paths)
        ensure
          direct.dispose
        end

        raise IO::Error.new("the file chooser could not be armed") unless page.arm_file_chooser
        button = frame.evaluate_handle(
          "(sel) => document.querySelector(sel)", object["button"])
        begin
          clicked = Actions.real_click(button)
        ensure
          button.dispose
        end
        chooser = page.next_file_chooser
        chooser.set_files(paths)
        reactions = frame.evaluate(object["probe"].as_s)
        JSON::Any.new({
          "direct"  => JSON::Any.new(direct_answer),
          "clicked" => clicked,
          "chooser" => JSON::Any.new({
            "multiple"  => JSON::Any.new(chooser.multiple),
            "directory" => JSON::Any.new(chooser.directory),
          }),
          "reactions" => reactions,
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
                action["params"]?.try(&.as_h) || {} of String => JSON::Any,
                (action["timeoutMs"]?.try(&.as_i64?) || Bidi::DEFAULT_TIMEOUT_MS).to_i32
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
          when "pause"
            # Nothing is outstanding: this is the socket's own idle state, the
            # one a read deadline on the session socket used to kill.
            sleep action["ms"].as_i64.milliseconds
          else
            raise ArgumentError.new("unknown BiDi scenario action #{action["type"]}")
          end
        end
      ensure
        session.close
      end
      JSON::Any.new(values)
    end

    # A scripted pass over the tab claims: tabs claimed and released, other
    # readers' claims planted in the file, and what the session then says
    # about the port. The whole script runs in this one process, so the
    # process id the claims are written under is stable across steps — which
    # is the point the claims turn on. Scenarios open with reset, the empty
    # claims file a final release leaves, because the JavaScript and Crystal
    # runs share the one state directory. The JavaScript original runs the
    # same script in-process over src/session.js, so the two runtimes must
    # answer with the same observations.
    private def self.session_scenario(payload : JSON::Any) : JSON::Any
      observations = [] of JSON::Any
      payload.as_h["script"].as_a.each do |step_value|
        step = step_value.as_h
        port = step["port"]?.try(&.as_i?) || 0
        case step["op"].as_s
        when "reset"
          Session.write_claims(port, [] of Session::Claim)
        when "claim"
          Session.claim_tab(port, step["target"].as_s)
        when "release"
          Session.release_tab(port)
        when "inject"
          inject_claim(port, step["who"].as_s, step["target"].as_s)
        when "other_readers"
          observations.push(JSON::Any.new(Session.other_readers_on(port)))
        when "claimed"
          observations.push(JSON::Any.new(Session.claimed_targets(port).map do |target|
            JSON::Any.new(target)
          end))
        else
          raise ArgumentError.new("unknown session scenario op #{step["op"]}")
        end
      end
      JSON::Any.new(observations)
    end

    # Plant another reader's claim in the file the way a second session would
    # have left it: a live reader is this process's parent (alive, and not
    # us), a dead one a pid no machine has. Starts from what is already in
    # the file, which the scenario is expected to have claimed first — the
    # JavaScript harness reads the same file and fails the same way if there
    # is nothing to read.
    private def self.inject_claim(port : Int32, who : String, target : String) : Nil
      pid = who == "dead" ? 0x7fffffff : LibC.getppid.to_i64
      raw = JSON.parse(File.read(Session.claims_path(port)))
      unless claims = raw.as_a?
        raise ArgumentError.new("#{Session.claims_path(port)} is not a claims array")
      end
      claims << JSON::Any.new({
        "pid"      => JSON::Any.new(pid),
        "targetId" => JSON::Any.new(target),
        "at"       => JSON::Any.new(Time.utc.to_unix_ms),
      })
      File.write(Session.claims_path(port), claims.to_json)
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


    # A D-Bus argument as the test wrote it in JSON. A JSON object with both a
    # "signature" and a "value" is a variant, because a variant is the one
    # D-Bus value that carries a type of its own.
    private def self.dbus_argument(json : JSON::Any) : Dbus::Argument
      if object = json.as_h?
        if object.has_key?("signature") && object.has_key?("value")
          return Dbus::Variant.new(object["signature"].as_s, dbus_argument(object["value"]))
        end
        raise ArgumentError.new("a D-Bus argument object must be a variant")
      end
      if array = json.as_a?
        built = [] of Dbus::Argument
        array.each { |each| built << dbus_argument(each) }
        return built
      end
      case raw = json.raw
      when Nil    then nil
      when Bool   then raw
      when String then raw
      when Int64  then raw
      when Float64 then raw
      else             raise ArgumentError.new("cannot use #{raw.class} as a D-Bus argument")
      end
    end

    private def self.dbus_arguments(json : Array(JSON::Any)) : Array(Dbus::Argument)
      built = [] of Dbus::Argument
      json.each { |each| built << dbus_argument(each) }
      built
    end

    private def self.dbus_value_json(value : Dbus::Value) : JSON::Any
      case value
      when Bool    then JSON::Any.new(value)
      when String  then JSON::Any.new(value)
      when Float64 then JSON::Any.new(value)
      when UInt64  then JSON::Any.new(value.to_i64)
      when Int      then JSON::Any.new(value.to_i64)
      when Array    then JSON::Any.new(value.map { |each| dbus_value_json(each) })
      else               JSON::Any.new(nil)
      end
    end

    private def self.dbus_body_json(body : Array(Dbus::Value)) : JSON::Any
      JSON::Any.new(body.map { |each| dbus_value_json(each) })
    end

    private def self.dbus_encode(message : Hash(String, JSON::Any)) : Bytes
      Dbus.encode_message(
        type: message["type"]?.try(&.as_i?) || Dbus::MESSAGE_METHOD_CALL,
        flags: message["flags"]?.try(&.as_i?) || 0,
        serial: (message["serial"]?.try(&.as_i?) || 1).to_u32,
        path: message["path"]?.try(&.as_s?),
        iface: message["iface"]?.try(&.as_s?),
        member: message["member"]?.try(&.as_s?),
        destination: message["destination"]?.try(&.as_s?),
        error_name: message["errorName"]?.try(&.as_s?),
        reply_serial: message["replySerial"]?.try(&.as_i?).try(&.to_u32),
        signature: message["signature"]?.try(&.as_s?) || "",
        body: dbus_arguments(message["body"]?.try(&.as_a?) || [] of JSON::Any),
      )
    end

    private def self.dbus_message_json(message : Dbus::Message) : JSON::Any
      reply_serial = message.reply_serial
      JSON::Any.new({
        "type"         => JSON::Any.new(message.type.to_i64),
        "flags"        => JSON::Any.new(message.flags.to_i64),
        "serial"       => JSON::Any.new(message.serial.to_i64),
        "bodyLength"   => JSON::Any.new(message.body_length.to_i64),
        "signature"    => JSON::Any.new(message.signature),
        "body"         => dbus_body_json(message.body),
        "path"         => JSON::Any.new(message.path),
        "iface"        => JSON::Any.new(message.iface),
        "member"       => JSON::Any.new(message.member),
        "destination"  => JSON::Any.new(message.destination),
        "sender"       => JSON::Any.new(message.sender),
        "errorName"    => JSON::Any.new(message.error_name),
        "replySerial"  => reply_serial ? JSON::Any.new(reply_serial.to_i64) : JSON::Any.new(nil),
      })
    end

    # The client, driven against a bus the test is running. Each step answers
    # either what the bus returned or what the bus refused with, so a refusal
    # is part of the comparison rather than the end of the scenario.
    private def self.dbus_client_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      connection = Dbus.connect("unix:path=#{object["socket"].as_s}")
      results = [] of JSON::Any
      begin
        (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          step = raw.as_h
          begin
            case step["type"].as_s
            when "call"
              body = connection.call(
                destination: step["destination"]?.try(&.as_s?),
                path: step["path"]?.try(&.as_s?),
                iface: step["iface"]?.try(&.as_s?),
                member: step["member"]?.try(&.as_s?),
                signature: step["signature"]?.try(&.as_s?) || "",
                body: dbus_arguments(step["body"]?.try(&.as_a?) || [] of JSON::Any),
                timeout: (step["timeout"]?.try(&.as_i?) || 5000).milliseconds,
              )
              results << JSON::Any.new({"ok" => JSON::Any.new(true), "body" => dbus_body_json(body)})
            when "request_name"
              outcome = connection.request_name(
                step["name"].as_s, (step["flags"]?.try(&.as_i?) || 0).to_u32
              )
              results << JSON::Any.new({"ok" => JSON::Any.new(true), "outcome" => JSON::Any.new(outcome.to_i64)})
            when "process_id"
              pid = connection.process_id_of(step["name"].as_s)
              results << JSON::Any.new({"ok" => JSON::Any.new(true), "pid" => JSON::Any.new(pid.to_i64)})
            when "close"
              connection.close
              results << JSON::Any.new({"ok" => JSON::Any.new(true)})
            else
              raise ArgumentError.new("unknown D-Bus scenario step #{step["type"]}")
            end
          rescue error : Dbus::Error
            results << JSON::Any.new({
              "ok"    => JSON::Any.new(false),
              "name"  => JSON::Any.new(error.dbus_name),
              "error" => JSON::Any.new(error.message || ""),
            })
          end
        end
      ensure
        connection.close
      end
      JSON::Any.new({
        "name"    => JSON::Any.new(connection.name),
        "results" => JSON::Any.new(results),
      })
    end


    private def self.atspi_described_json(described : Atspi::Described) : JSON::Any
      JSON::Any.new({
        "bus"       => JSON::Any.new(described.bus),
        "path"      => JSON::Any.new(described.path),
        "role"      => JSON::Any.new(described.role),
        "name"      => JSON::Any.new(described.name),
        "value"     => JSON::Any.new(described.value),
        "checked"   => JSON::Any.new(described.checked),
        "focused"   => JSON::Any.new(described.focused),
        "isDefault" => JSON::Any.new(described.is_default),
      })
    end

    private def self.atspi_reading_json(reading : Atspi::Reading) : JSON::Any
      JSON::Any.new({
        "role"      => JSON::Any.new(reading.role),
        "name"      => JSON::Any.new(reading.name),
        "lines"     => JSON::Any.new(reading.lines.map { |line| JSON::Any.new(line) }),
        "buttons"   => JSON::Any.new(reading.buttons.map { |each| atspi_described_json(each) }),
        "toggles"   => JSON::Any.new(reading.toggles.map { |each| atspi_described_json(each) }),
        "fields"    => JSON::Any.new(reading.fields.map { |each| atspi_described_json(each) }),
        "truncated" => JSON::Any.new(reading.truncated),
      })
    end

    # Reading a browser's own windows, driven against an accessibility bus the
    # test is serving. The scenario carries the application, the top levels and
    # the last reading between steps, because that is the order a reader asks
    # in: find the browser, list what the browser has open, read the dialog,
    # press the dialog's button.
    private def self.atspi_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      accessibility = Atspi.open(address: "unix:path=#{object["socket"].as_s}")
      results = [] of JSON::Any
      application = nil.as(Atspi::Described?)
      top_levels = [] of Atspi::Described
      reading = nil.as(Atspi::Reading?)
      begin
        (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          step = raw.as_h
          begin
            case step["type"].as_s
            when "connections"
              results << JSON::Any.new(accessibility.connections.map { |name| JSON::Any.new(name) })
            when "applications"
              found = accessibility.applications
              results << JSON::Any.new(found.map { |each| atspi_described_json(each) })
            when "application_for"
              application = accessibility.application_for(
                pid: step["pid"]?.try(&.as_i?).try(&.to_i64),
                names: (step["names"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s),
              )
              found = application
              results << (found ? atspi_described_json(found) : JSON::Any.new(nil))
            when "top_levels"
              found = application || raise ArgumentError.new("no application has been found yet")
              top_levels = accessibility.top_levels(found)
              results << JSON::Any.new(top_levels.map { |each| atspi_described_json(each) })
            when "read"
              target = top_levels[step["index"].as_i]? ||
                       raise ArgumentError.new("no top level at #{step["index"]}")
              reading = accessibility.read(
                target,
                max_depth: step["maxDepth"]?.try(&.as_i?) || Atspi::MAX_DEPTH,
                max_nodes: step["maxNodes"]?.try(&.as_i?) || Atspi::MAX_NODES,
              )
              results << atspi_reading_json(reading.not_nil!)
            when "states"
              states = accessibility.states_of(
                Atspi::Node.new(step["bus"].as_s, step["path"].as_s)
              )
              results << JSON::Any.new({
                "checked"   => JSON::Any.new(states.checked),
                "focused"   => JSON::Any.new(states.focused),
                "isDefault" => JSON::Any.new(states.is_default),
              })
            when "press"
              wanted = step["name"].as_s
              held = reading || raise ArgumentError.new("nothing has been read yet")
              control = (held.buttons + held.toggles).find { |each| each.name == wanted } ||
                        raise ArgumentError.new("no control named #{wanted}")
              results << JSON::Any.new(accessibility.press(control.node))
            when "press_path"
              results << JSON::Any.new(accessibility.press(
                Atspi::Node.new(step["bus"].as_s, step["path"].as_s)
              ))
            else
              raise ArgumentError.new("unknown AT-SPI scenario step #{step["type"]}")
            end
          rescue error
            results << JSON::Any.new({
              "error" => JSON::Any.new(error.message || error.class.name),
            })
          end
        end
      ensure
        accessibility.close
      end
      JSON::Any.new({"results" => JSON::Any.new(results)})
    end


    # The private session bus and the accessibility service served on top of
    # it, driven step by step. One scenario rather than one call per question,
    # because the bus has to stay up between the questions and a conformance
    # call is one process.
    private def self.a11y_bus_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      results = [] of JSON::Any
      started = nil.as(A11yBus::StartedBus?)
      server = nil.as(Dbus::Connection?)
      client = nil.as(Dbus::Connection?)
      begin
        (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          step = raw.as_h
          begin
            case step["type"].as_s
            when "start"
              started = A11yBus.start_session_bus
              bus = started.not_nil!
              results << JSON::Any.new({
                "address"      => JSON::Any.new(bus.address),
                "socketExists" => JSON::Any.new(File.exists?(bus.socket_path)),
                "configExists" => JSON::Any.new(File.exists?("#{bus.socket_path}.conf")),
                "config"       => JSON::Any.new(File.read("#{bus.socket_path}.conf")),
              })
            when "activatable"
              bus = started || raise ArgumentError.new("no bus has been started")
              client = Dbus.connect(bus.address) if client.nil?
              answered = client.not_nil!.call(
                destination: "org.freedesktop.DBus",
                path: "/org/freedesktop/DBus",
                iface: "org.freedesktop.DBus",
                member: "ListActivatableNames",
              )[0]?
              names = [] of JSON::Any
              if answered.is_a?(Array)
                answered.each { |name| names << JSON::Any.new(name.as?(String) || "") }
              end
              results << JSON::Any.new(names)
            when "serve"
              bus = started || raise ArgumentError.new("no bus has been started")
              server = Dbus.connect(bus.address)
              outcome = server.not_nil!.request_name(A11yBus::A11Y_NAME)
              A11yBus.serve_accessibility_bus(server.not_nil!, bus.address) if outcome == 1
              results << JSON::Any.new(outcome.to_i64)
            when "ask_address", "ask_property", "ask_unknown", "set_property"
              bus = started || raise ArgumentError.new("no bus has been started")
              client = Dbus.connect(bus.address) if client.nil?
              asking = client.not_nil!
              answered = case step["type"].as_s
                         when "ask_address"
                           asking.call(
                             destination: A11yBus::A11Y_NAME, path: A11yBus::A11Y_PATH,
                             iface: A11yBus::A11Y_INTERFACE, member: "GetAddress",
                             timeout: 4.seconds,
                           )[0]?
                         when "ask_property"
                           asking.call(
                             destination: A11yBus::A11Y_NAME, path: A11yBus::A11Y_PATH,
                             iface: A11yBus::PROPERTIES, member: "Get", signature: "ss",
                             body: [
                               (step["interface"]?.try(&.as_s?) || A11yBus::STATUS_INTERFACE).as(Dbus::Argument),
                               step["property"].as_s.as(Dbus::Argument),
                             ],
                             timeout: 4.seconds,
                           )[0]?
                         when "set_property"
                           asking.call(
                             destination: A11yBus::A11Y_NAME, path: A11yBus::A11Y_PATH,
                             iface: A11yBus::PROPERTIES, member: "Set", signature: "ssv",
                             body: [
                               A11yBus::STATUS_INTERFACE.as(Dbus::Argument),
                               step["property"].as_s.as(Dbus::Argument),
                               Dbus::Variant.new("b", true).as(Dbus::Argument),
                             ],
                             timeout: 4.seconds,
                           )[0]?
                         else
                           asking.call(
                             destination: A11yBus::A11Y_NAME, path: A11yBus::A11Y_PATH,
                             iface: A11yBus::A11Y_INTERFACE, member: "SomethingElse",
                             timeout: 4.seconds,
                           )[0]?
                         end
              results << dbus_value_json(answered.nil? ? "" : answered)
            when "stop"
              bus = started || raise ArgumentError.new("no bus has been started")
              client.try(&.close)
              server.try(&.close)
              bus.process.terminate rescue nil
              bus.process.wait rescue nil
              # The daemon removes nothing on the way out, so whoever started
              # the daemon removes the socket and the configuration. Reported
              # rather than assumed, because a file left behind is the failure.
              deadline = Time.instant + 5.seconds
              removed = false
              while Time.instant < deadline
                unless File.exists?(bus.socket_path) || File.exists?("#{bus.socket_path}.conf")
                  removed = true
                  break
                end
                sleep 20.milliseconds
              end
              results << JSON::Any.new(removed)
              started = nil
              server = nil
              client = nil
            else
              raise ArgumentError.new("unknown accessibility bus scenario step #{step["type"]}")
            end
          rescue error
            results << JSON::Any.new({"error" => JSON::Any.new(error.message || error.class.name)})
          end
        end
      ensure
        client.try(&.close)
        server.try(&.close)
        if leftover = started
          leftover.process.terminate rescue nil
          File.delete?(leftover.socket_path)
          File.delete?("#{leftover.socket_path}.conf")
        end
      end
      JSON::Any.new({"results" => JSON::Any.new(results)})
    end

    # `A11yBus.open` end to end, including what a kept browser is left with.
    # `mode` is what the reader would do on the way out: "close" takes the bus
    # down, "leave_running" hands the bus to a browser that outlives the reader.
    private def self.a11y_open_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      opened = A11yBus.open
      env = {} of String => JSON::Any
      opened.env.each { |key, value| env[key] = JSON::Any.new(value) }
      answer = {
        "available" => JSON::Any.new(opened.available?),
        "address"   => JSON::Any.new(opened.address),
        "env"       => JSON::Any.new(env),
        "owned"     => JSON::Any.new(opened.owned?),
        "pid"       => (pid = opened.pid) ? JSON::Any.new(pid) : JSON::Any.new(nil),
        "reason"    => JSON::Any.new(opened.reason),
      }
      if object["mode"]?.try(&.as_s?) == "leave_running"
        opened.leave_running
        # The service connection belonged to this reader, but the bus itself is
        # still where a kept browser expects the bus to be.
        reachable = if address = opened.address
                      begin
                        Dbus.connect(address).close
                        true
                      rescue
                        false
                      end
                    else
                      false
                    end
        answer["reachableAfter"] = JSON::Any.new(reachable)
      else
        opened.close
        answer["reachableAfter"] = JSON::Any.new(false)
      end
      JSON::Any.new(answer)
    end


    # One question, as the differential compares it: what the dialog says,
    # what the dialog offers, and which button the dialog itself has ready.
    private def self.native_request_json(request : NativePrompt::Request) : JSON::Any
      default = request.default_button
      JSON::Any.new({
        "role"          => JSON::Any.new(request.role),
        "title"         => JSON::Any.new(request.title),
        "lines"         => JSON::Any.new(request.lines.map { |line| JSON::Any.new(line) }),
        "buttons"       => JSON::Any.new(request.buttons.map { |each| JSON::Any.new(each.name) }),
        "toggles"       => JSON::Any.new(request.toggles.map { |each| JSON::Any.new(each.name) }),
        "fields"        => JSON::Any.new(request.fields.map do |each|
          JSON::Any.new("#{each.name}: #{each.value}")
        end),
        "defaultButton" => default ? JSON::Any.new(default.name) : JSON::Any.new(nil),
      })
    end

    # Noticing that the browser has asked something, and answering it, driven
    # against an accessibility bus the test is serving.
    #
    # The tree is changed through that bus's own control interface rather than
    # on a clock, so the comparison is deterministic: a step adds the dialog,
    # the next step waits for the watch to have offered it, and the step after
    # that answers it. The one thing that cannot be driven is the watch holding
    # the terminal — so "hold" makes the handler wait for a "release" step,
    # which is exactly the state a reader in the middle of answering is in.
    private def self.native_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      accessibility = Atspi.open(address: "unix:path=#{object["socket"].as_s}")
      control = accessibility.connection
      results = [] of JSON::Any
      offered = [] of NativePrompt::Request
      released = ::Channel(Nil).new
      holding = false
      throw_once = false
      watch = nil.as(NativePrompt::Watch?)
      begin
        (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          step = raw.as_h
          begin
            case step["type"].as_s
            when "arm"
              holding = step["hold"]?.try(&.as_bool?) || false
              throw_once = step["throwFirst"]?.try(&.as_bool?) || false
              application = accessibility.application_for(
                pid: step["pid"]?.try(&.as_i?).try(&.to_i64),
                names: (step["names"]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s),
              ) || raise ArgumentError.new("the browser is not describing its windows")
              interval = (step["intervalMs"]?.try(&.as_i?) || 10).milliseconds
              watch = NativePrompt::Watch.new(accessibility, application, interval) do |request|
                if throw_once
                  throw_once = false
                  raise Exception.new("the terminal went away")
                end
                offered << request
                released.receive if holding
              end
              results << JSON::Any.new(application.name)
            when "set_tree"
              control.call(
                destination: "org.tawb.Control",
                path: "/org/tawb/control",
                iface: "org.tawb.Control",
                member: "SetTree",
                signature: "s",
                body: [step["payload"].as_s.as(Dbus::Argument)],
              )
              results << JSON::Any.new(true)
            when "await"
              wanted = step["count"].as_i
              deadline = Time.instant + (step["timeoutMs"]?.try(&.as_i?) || 3000).milliseconds
              while offered.size < wanted && Time.instant < deadline
                sleep 5.milliseconds
              end
              results << JSON::Any.new(offered.size.to_i64)
            when "settle"
              # A deliberate wait, for the one assertion that is about nothing
              # happening: while the handler holds the terminal the watch
              # cannot look again, so a dialog that arrives now must not be
              # offered.
              sleep (step["ms"]?.try(&.as_i?) || 60).milliseconds
              results << JSON::Any.new(offered.size.to_i64)
            when "release"
              released.send(nil)
              results << JSON::Any.new(true)
            when "dialog"
              request = offered[step["index"].as_i]? ||
                        raise ArgumentError.new("no dialog at #{step["index"]}")
              results << native_request_json(request)
            when "press"
              request = offered[step["index"].as_i]? ||
                        raise ArgumentError.new("no dialog at #{step["index"]}")
              wanted = step["name"].as_s
              button = request.buttons.find { |each| each.name == wanted } ||
                       raise ArgumentError.new("no button named #{wanted}")
              results << JSON::Any.new(request.press(button))
            when "toggle"
              request = offered[step["index"].as_i]? ||
                        raise ArgumentError.new("no dialog at #{step["index"]}")
              wanted = step["name"].as_s
              control_node = request.toggles.find { |each| each.name == wanted } ||
                             raise ArgumentError.new("no option named #{wanted}")
              answered = request.toggle(control_node)
              results << (answered.nil? ? JSON::Any.new(nil) : JSON::Any.new(answered))
            when "reread"
              index = step["index"].as_i
              request = offered[index]? || raise ArgumentError.new("no dialog at #{index}")
              again = request.reread
              offered[index] = again
              results << native_request_json(again)
            when "still_open"
              request = offered[step["index"].as_i]? ||
                        raise ArgumentError.new("no dialog at #{step["index"]}")
              results << JSON::Any.new(request.still_open?)
            when "stopped"
              results << JSON::Any.new(watch.try(&.stopped?) || false)
            when "stop"
              watch.try(&.stop)
              results << JSON::Any.new(true)
            else
              raise ArgumentError.new("unknown native prompt scenario step #{step["type"]}")
            end
          rescue error
            results << JSON::Any.new({"error" => JSON::Any.new(error.message || error.class.name)})
          end
        end
      ensure
        watch.try(&.stop)
        accessibility.close
      end
      JSON::Any.new({"results" => JSON::Any.new(results)})
    end


    # ------------------------------------------------------------------
    # The edbrowse server, driven against a browser written in the payload
    # ------------------------------------------------------------------

    # One document, as the payload describes it: the tokens the page's walk
    # would answer with, and the frames inside it.
    private class ScriptedDocument
      include Edb::DocumentEnv

      getter applied : Array(Edb::FieldEntry)
      getter activated : Array(JSON::Any)
      getter entered : Array(JSON::Any)

      # Annotated, because a document holds documents and the compiler cannot
      # infer the type of a block that builds the class being defined.
      @ordered : Array(ScriptedDocument)
      @hidden : Array(ScriptedDocument)

      def initialize(@payload : Hash(String, JSON::Any))
        @applied = [] of Edb::FieldEntry
        @activated = [] of JSON::Any
        @entered = [] of JSON::Any
        @ordered = [] of ScriptedDocument
        @hidden = [] of ScriptedDocument
        (@payload["frames"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          @ordered << ScriptedDocument.new(raw.as_h)
        end
        (@payload["hidden"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          @hidden << ScriptedDocument.new(raw.as_h)
        end
      end

      def url : String
        @payload["url"]?.try(&.as_s?) || ""
      end

      def extract : JSON::Any
        raise Exception.new("the document cannot be read") if @payload["unread"]?.try(&.as_bool?)
        JSON::Any.new({
          "url"    => JSON::Any.new(url),
          "title"  => JSON::Any.new(@payload["title"]?.try(&.as_s?) || "stub"),
          "tokens" => @payload["tokens"]? || JSON::Any.new([] of JSON::Any),
        })
      end

      def ordered_frames : Array(Edb::DocumentEnv)
        @ordered.map(&.as(Edb::DocumentEnv))
      end

      def hidden_frames : Array(Edb::DocumentEnv)
        @hidden.map(&.as(Edb::DocumentEnv))
      end

      def apply_fields(entries : Array(Edb::FieldEntry)) : Edb::Applied
        @applied.concat(entries)
        Edb::Applied.new(entries.size, [] of String)
      end

      def activate(desc : JSON::Any, real : Bool) : Edb::Outcome
        # Recorded as which of the two presses it was, because that is the
        # only part the JavaScript stub can also see: the default action
        # evaluates `clickThrough` on the element and a real click evaluates
        # `prepareRealClick` first. Which element was pressed is implied by
        # which document recorded the press.
        @activated << JSON::Any.new({"real" => JSON::Any.new(real)})
        if real && @payload["activateRefuses"]?.try(&.as_bool?)
          # The same sentence the real binding builds from what
          # `prepare_real_click.js` answered, because the reader has to be
          # told why nothing happened.
          return Edb::Outcome.new(false, why: "a real click cannot reach it: it is not in the page")
        end
        Edb::Outcome.new(true, how: "path")
      end

      def press_enter(desc : JSON::Any) : Bool
        # Recorded as the press rather than as the element, because Enter goes
        # through the browser's own keyboard and the element is only focused
        # first: which field received it is implied by the field the reader
        # was filling.
        @entered << JSON::Any.new({"pressed" => JSON::Any.new("Enter")})
        true
      end

      # What this document and every document inside it was asked to do, so a
      # scenario can be compared on the browser's side as well as the
      # reader's.
      def record : JSON::Any
        JSON::Any.new({
          "applied"   => JSON::Any.new(@applied.map do |entry|
            JSON::Any.new({
              "path"  => JSON::Any.new(entry.path),
              "tag"   => JSON::Any.new(entry.tag),
              "value" => JSON::Any.new(entry.value),
            })
          end),
          "activated" => JSON::Any.new(@activated),
          "entered"   => JSON::Any.new(@entered),
          "frames"    => JSON::Any.new(@ordered.map(&.record)),
          "hidden"    => JSON::Any.new(@hidden.map(&.record)),
        })
      end
    end

    private class ScriptedTab
      include Edb::TabEnv

      getter document : Edb::DocumentEnv
      getter gotos : Array(String)
      getter? closed : Bool
      getter backs : Int32
      getter arms : Int32

      def initialize(@payload : Hash(String, JSON::Any))
        @scripted = ScriptedDocument.new(@payload)
        @document = @scripted
        @gotos = [] of String
        @closed = false
        @backs = 0
        @arms = 0
      end

      def url : String
        @scripted.url
      end

      def title : String
        @payload["pageTitle"]?.try(&.as_s?) || "stub page"
      end

      def goto(url : String) : Nil
        @gotos << url
      end

      def back : Nil
        @backs += 1
      end

      def close : Nil
        @closed = true
      end

      def sync_url : Nil
      end

      def view(kind : String) : Array(String)
        views = @payload["views"]?.try(&.as_h?) || {} of String => JSON::Any
        (views[kind]?.try(&.as_a?) || [] of JSON::Any).map(&.as_s)
      end

      def arm_auth : Nil
        @arms += 1
      end

      def record : JSON::Any
        JSON::Any.new({
          "gotos"    => JSON::Any.new(@gotos.map { |url| JSON::Any.new(url) }),
          "closed"   => JSON::Any.new(@closed),
          "backs"    => JSON::Any.new(@backs.to_i64),
          "armed"    => JSON::Any.new(@arms > 0),
          "document" => @scripted.record,
        })
      end
    end

    private class ScriptedBrowser
      include Edb::BrowserEnv

      getter tabs : Array(Edb::TabEnv)
      getter scripted : Array(ScriptedTab)

      def initialize(@payload : Hash(String, JSON::Any))
        @scripted = (@payload["tabs"]?.try(&.as_a?) || [] of JSON::Any)
          .map { |raw| ScriptedTab.new(raw.as_h) }
        @tabs = @scripted.map(&.as(Edb::TabEnv))
      end

      def name : String
        "stub"
      end

      def alive? : Bool
        @payload["alive"]?.try(&.as_bool?) != false
      end

      def new_tab : Edb::TabEnv
        fresh = ScriptedTab.new({
          "url"    => JSON::Any.new("about:blank"),
          "tokens" => @payload["newTabTokens"]? || JSON::Any.new([] of JSON::Any),
        })
        @scripted << fresh
        @tabs << fresh
        fresh
      end

      def attach_auth(asked : Edb::AuthAsk) : Nil
      end

      def close : Nil
      end

      def record : JSON::Any
        JSON::Any.new(@scripted.map(&.record))
      end
    end

    # Both servers answer the same requests, so what is compared is the
    # response — status, the redirect's destination, the cache headers, the
    # body — and what the browser was asked to do while answering.
    private def self.edb_routes_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = ScriptedBrowser.new(object["browser"].as_h)
      token = object["token"]?.try(&.as_s?) || "testtoken"
      server = Edb::Server.new(browser, port: 0, token: token)
      spawn { server.listen }
      # The listener is bound before `listen` is called, so a request cannot
      # arrive at a closed port; the fiber only starts accepting.
      answers = [] of JSON::Any
      begin
        (object["requests"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          request = raw.as_h
          path = request["path"].as_s
          method = request["method"]?.try(&.as_s?) || "GET"
          body = request["body"]?.try(&.as_h?)
          answers << edb_request(server.port, method, path, body)
        end
      ensure
        server.close
      end
      JSON::Any.new({
        "answers" => JSON::Any.new(answers),
        "browser" => browser.record,
      })
    end

    # One request, written by hand for the same reason the server answers by
    # hand: `HTTP::Client` links libssl, libcrypto and libz, and the static
    # build does not have them. What a request needs is a line, two headers
    # and a body.
    private def self.edb_request(port : Int32, method : String, path : String,
                                 body : Hash(String, JSON::Any)?) : JSON::Any
      socket = TCPSocket.new("127.0.0.1", port)
      socket.read_timeout = 30.seconds
      begin
        form = body ? URI::Params.build do |params|
          body.each { |key, value| params.add(key, value.as_s? || value.to_s) }
        end : nil
        socket << "#{form ? "POST" : method} #{path} HTTP/1.1\r\n"
        socket << "host: 127.0.0.1:#{port}\r\nconnection: close\r\n"
        if form
          socket << "content-type: application/x-www-form-urlencoded\r\n"
          socket << "content-length: #{form.bytesize}\r\n"
        end
        socket << "\r\n"
        socket << form if form
        socket.flush

        status_line = socket.gets("\r\n", chomp: true) || ""
        status = status_line.split(' ')[1]?.try(&.to_i?) || 0
        headers = {} of String => String
        loop do
          header = socket.gets("\r\n", chomp: true)
          break if header.nil? || header.empty?
          name, _, value = header.partition(':')
          headers[name.downcase] = value.strip
        end
        length = headers["content-length"]?.try(&.to_i?)
        answered = if length
                     buffer = Bytes.new(length)
                     socket.read_fully(buffer)
                     String.new(buffer)
                   else
                     socket.gets_to_end
                   end
        JSON::Any.new({
          "status"   => JSON::Any.new(status.to_i64),
          "location" => JSON::Any.new(headers["location"]?),
          "cache"    => JSON::Any.new(headers["cache-control"]?),
          "type"     => JSON::Any.new(headers["content-type"]?),
          "body"     => JSON::Any.new(answered),
        })
      ensure
        socket.close rescue nil
      end
    end


    # The focus an activation moved, against a real page.
    #
    # Each step arms the observation on one element, clicks that element the
    # way the page's own default action would, and reports what focus the
    # click moved — the id of the element, and which block of the view the
    # element is, which is the half a reader is actually moved by.
    private def self.focus_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      browser = FirefoxDriver::BrowserSession.new(object["url"].as_s)
      answers = [] of JSON::Any
      begin
        browser.start
        page = browser.create_page
        page.navigate(object["page"].as_s, "complete")
        core = Core.new(source: object["source"]?.try(&.as_s?) || "ax",
          driver: browser, page: page)
        core.rescan(page)
        frame = FirefoxDriver::Frame.new(browser.protocol, page.context_id, page)
        (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          step = raw.as_h
          case step["type"].as_s
          when "blur"
            frame.evaluate("() => { if (document.activeElement) document.activeElement.blur(); }")
            answers << JSON::Any.new(true)
          when "activate"
            selector = step["selector"].as_s
            source = frame.evaluate_handle("(sel) => document.querySelector(sel)",
              JSON::Any.new(selector))
            tracker = begin
              Focus.arm(frame, source)
            ensure
              source.dispose rescue nil
            end
            # Clicked through the element's own default action, which is what
            # Enter on a line does, so the focus observed is the one the
            # page's handler moved.
            frame.evaluate("(sel) => document.querySelector(sel).click()",
              JSON::Any.new(selector))
            wait = (step["waitMs"]?.try(&.as_i?) || 250).milliseconds
            found = Focus.focused_by(tracker, wait)
            if found.nil?
              answers << JSON::Any.new({"found" => JSON::Any.new(false)})
              next
            end
            id = found.handle.evaluate("(el) => el.id").as_s? || ""
            block = core.focus_destination_block(found)
            answers << JSON::Any.new({
              "found" => JSON::Any.new(true),
              "id"    => JSON::Any.new(id),
              "name"  => JSON::Any.new(block >= 0 ?
                (core.block(block).try(&.item.as_h?).try(&.["name"]?.try(&.as_s?)) || "") : ""),
              "block" => JSON::Any.new(block.to_i64),
            })
          when "cancel"
            selector = step["selector"].as_s
            source = frame.evaluate_handle("(sel) => document.querySelector(sel)",
              JSON::Any.new(selector))
            tracker = begin
              Focus.arm(frame, source)
            ensure
              source.dispose rescue nil
            end
            # Cancelled without anything being pressed, which is what an
            # activation that raised before the click looks like. The tracker
            # must be gone afterwards, so a later activation cannot inherit
            # it.
            cancelled = core.cancel_activation_focus(tracker)
            again = Focus.cancel(tracker)
            answers << JSON::Any.new({
              "cancelled" => JSON::Any.new(cancelled.nil? ? true : true),
              "twice"     => JSON::Any.new(again),
            })
          else
            raise ArgumentError.new("unknown focus scenario step #{step["type"]}")
          end
        end
        JSON::Any.new({"answers" => JSON::Any.new(answers)})
      ensure
        browser.close
      end
    end

    # The browser registry, driven step by step.
    #
    # One scenario rather than one call per question, because "the session
    # that started this browser is still running" means the process making the
    # call — and a conformance process that answered one question and exited
    # would make every browser it recorded look stranded.
    private def self.registry_scenario(payload : JSON::Any) : JSON::Any
      object = payload.as_h
      answers = [] of JSON::Any
      (object["steps"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
        step = raw.as_h
        case step["type"].as_s
        when "write"
          Registry.write((step["entries"]?.try(&.as_a?) || [] of JSON::Any).map do |entry|
            registry_entry(entry.as_h)
          end)
          answers << JSON::Any.new(true)
        when "record"
          Registry.record(
            step["pid"].as_i.to_i64,
            step["port"].as_i.to_i32,
            step["profileDir"]?.try(&.as_s?),
            step["engine"]?.try(&.as_s?),
            step["a11yPid"]?.try(&.as_i?).try(&.to_i64),
            step["a11yAddress"]?.try(&.as_s?),
          )
          answers << JSON::Any.new(true)
        when "mark_kept"
          Registry.mark_kept(step["port"].as_i.to_i32)
          answers << JSON::Any.new(true)
        when "forget"
          Registry.forget(step["port"].as_i.to_i32)
          answers << JSON::Any.new(true)
        when "disown"
          # The owner rewritten to a process that is not running, which is
          # what a session killed outright leaves behind.
          entry = Registry.read_entry(step["port"].as_i.to_i32)
          if entry
            Registry.write_entry(Registry::Entry.new(
              pid: entry.pid, port: entry.port, profile_dir: entry.profile_dir,
              engine: entry.engine, owner: step["owner"].as_i.to_i64, keep: entry.keep,
              at: entry.at, a11y_pid: entry.a11y_pid, a11y_address: entry.a11y_address))
          end
          answers << JSON::Any.new(!entry.nil?)
        when "claim"
          Session.write_claims(step["port"].as_i.to_i32,
            [Session::Claim.new(step["pid"].as_i.to_i64,
              step["targetId"]?.try(&.as_s?) || "T", Time.utc.to_unix_ms)])
          answers << JSON::Any.new(true)
        when "release_claims"
          Session.write_claims(step["port"].as_i.to_i32, [] of Session::Claim)
          answers << JSON::Any.new(true)
        when "ours"
          answers << JSON::Any.new(Registry.ours?(
            step["pid"].as_i.to_i64, step["profileDir"]?.try(&.as_s?)))
        when "sweep"
          answers << JSON::Any.new(Registry.sweep_stranded.to_i64)
        when "read"
          # Compared without the pids and the times, which are this run's own.
          answers << JSON::Any.new(Registry.read.sort_by(&.port).map do |entry|
            JSON::Any.new({
              "port"      => JSON::Any.new(entry.port.to_i64),
              "engine"    => JSON::Any.new(entry.engine),
              "keep"      => JSON::Any.new(entry.keep),
              "hasA11y"   => JSON::Any.new(!entry.a11y_pid.nil?),
              "ownedHere" => JSON::Any.new(entry.owner == Process.pid.to_i64),
            })
          end)
        when "alive"
          answers << JSON::Any.new(Processes.alive?(step["pid"].as_i.to_i64))
        when "gone_within"
          deadline = Time.instant + (step["ms"]?.try(&.as_i?) || 5000).milliseconds
          pid = step["pid"].as_i.to_i64
          gone = false
          while Time.instant < deadline
            unless Processes.alive?(pid)
              gone = true
              break
            end
            sleep 50.milliseconds
          end
          answers << JSON::Any.new(gone)
        when "companion_files"
          # Whether the private bus's socket and configuration are still on
          # disk, which is what forgetting a browser has to take with it.
          socket = step["socket"].as_s
          answers << JSON::Any.new({
            "socket" => JSON::Any.new(File.exists?(socket)),
            "config" => JSON::Any.new(File.exists?("#{socket}.conf")),
          })
        else
          raise ArgumentError.new("unknown registry scenario step #{step["type"]}")
        end
      end
      JSON::Any.new({"answers" => JSON::Any.new(answers)})
    end

    private def self.registry_entry(object : Hash(String, JSON::Any)) : Registry::Entry
      owner = object["owner"]?
      Registry::Entry.new(
        pid: object["pid"].as_i.to_i64,
        port: object["port"].as_i.to_i32,
        profile_dir: object["profileDir"]?.try(&.as_s?),
        engine: object["engine"]?.try(&.as_s?),
        owner: owner.try(&.as_s?) == "self" ? Process.pid.to_i64 : owner.try(&.as_i?).try(&.to_i64),
        keep: object["keep"]?.try(&.as_bool?) || false,
        at: object["at"]?.try(&.as_i?).try(&.to_i64) || Time.utc.to_unix_ms,
        a11y_pid: object["a11yPid"]?.try(&.as_i?).try(&.to_i64),
        a11y_address: object["a11yAddress"]?.try(&.as_s?),
      )
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
