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
require "./input"
require "./interfaces"
require "./keys"
require "./layout"
require "./lynx_config"
require "./lynx_display"
require "./lynx_keymap"
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
      when "lynx_keymap.table"
        string_table(LynxKeymap::FUNCTION_ACTIONS)
      when "lynx_keymap.action_names"
        string_table(LynxKeymap::ACTION_FUNCTIONS)
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
        object["preferences"]?.try(&.as_h?) || {} of String => JSON::Any,
      ))
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
