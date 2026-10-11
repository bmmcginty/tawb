require "json"
require "./actions"
require "./address"
require "./aria"
require "./blocks"
require "./bidi"
require "./core"
require "./key_wizard"
require "./edit"
require "./remap"
require "./broker"
require "./dump"
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
require "./live"
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
require "./options"
require "./reader"
require "./reader_keys"
require "./quicknav"
require "./place"
require "./session"
require "./screen"
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
      when "firefox.handle_scenario"
        firefox_handle_scenario(payload)
      when "firefox.fields_scenario"
        firefox_fields_scenario(payload)
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
    end

    # The page the scenario describes: an address, a title, and a keyboard
    # that records what was sent to it — and can refuse.
    private class ScriptedPage
      include Reader::PageEnv

      getter presses : Array(String)
      property fail_press : Bool

      def initialize(@url : String, @title : String, @fail_press = false)
        @presses = [] of String
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
      results = [] of JSON::Any
      (object["actions"]?.try(&.as_a?) || [] of JSON::Any).each do |step_value|
        action = step_value.as_h
        output = RecordingScreen.new
        value = reader_action(output, state, action, page_url, page)
        entry = {"writes" => JSON::Any.new(output.writes)} of String => JSON::Any
        entry["value"] = value unless value.nil?
        results << JSON::Any.new(entry)
      end
      JSON::Any.new({
        "results" => JSON::Any.new(results),
        "state"   => reader_state_json(state),
      })
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
      state.short_links = object["shortLinks"]?.try(&.as_bool?) || false
      state.link_address = object["linkAddress"]?.try(&.as_bool?) != false
      state.status_msg = object["statusMsg"]?.try(&.as_s?) || ""
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
          line_object["displaySuffix"]?.try(&.as_s?) || "")
      end
      if drawn = object["drawn"]?.try(&.as_h?)
        state.drawn.title = drawn["title"]?.try(&.as_s?)
        state.drawn.address = drawn["address"]?.try(&.as_s?)
        state.drawn.address_caret_col = drawn["addressCaretCol"]?.try(&.as_i64?).try(&.to_i32)
        state.drawn.hint = drawn["hint"]?.try(&.as_s?)
        state.drawn.status = drawn["status"]?.try(&.as_s?)
      end
      if core = object["core"]?.try(&.as_h?)
        state.core = Reader::CoreState.new(
          core["source"]?.try(&.as_s?) || "ax",
          core["blocks"]?.try(&.as_a?) || [] of JSON::Any,
          core["popup"]?,
          core["popupAt"]?.try(&.as_i64?) || -1_i64)
        scripted = state.core.as(Reader::CoreState)
        scripted.rescan_blocks = core["rescanBlocks"]?.try(&.as_a?)
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
      end
      if keys = object["keys"]?
        state.keys = build_keymap(keys)
      end
      if typing = object["typing"]?.try(&.as_h?)
        item = typing["item"]?
        if item
          state.typing = Reader::Typing.new(
            item,
            typing["text"]?.try(&.as_s?) || "",
            (typing["caret"]?.try(&.as_i64?) || 0).to_i32)
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
      state.files = object["files"]?
      state.library = object["library"]?
      state.dialog = object["dialog"]?
      state.options = object["options"]?
      state.controlling = object["controlling"]?
      state.chooser = object["chooser"]?
      state
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
      JSON::Any.new(lines.map do |line|
        entry = {
          "text"          => JSON::Any.new(line.text),
          "blockIndex"    => JSON::Any.new(line.block_index.to_i64),
          "continuation"  => JSON::Any.new(line.continuation),
          "displayNumber" => line.display_number || JSON::Any.new(nil),
          "displayIndent" => JSON::Any.new(line.display_indent.to_i64),
          "displayPrefix" => JSON::Any.new(line.display_prefix),
          "displaySuffix" => JSON::Any.new(line.display_suffix),
        } of String => JSON::Any
        if spans = line.spans
          entry["spans"] = JSON::Any.new(spans.map do |span|
            JSON::Any.new({
              "start"         => JSON::Any.new(span.start.to_i64),
              "end"           => JSON::Any.new(span.finish.to_i64),
              "blockIndex"    => JSON::Any.new(span.block_index.to_i64),
              "displayNumber" => span.display_number || JSON::Any.new(nil),
            })
          end)
        end
        JSON::Any.new(entry)
      end)
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
      JSON::Any.new({
        "mode"         => JSON::Any.new(state.mode),
        "title"        => JSON::Any.new(state.title),
        "popup"        => state.core.popup || JSON::Any.new(nil),
        "live"         => state.core.live || JSON::Any.new(nil),
        "chooser"      => state.core.chooser || JSON::Any.new(nil),
        "attachments"  => JSON::Any.new(state.core.attached_calls),
        "activated"    => JSON::Any.new(state.core.activated),
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
        "inputMarks" => JSON::Any.new(state.core.input_marks.to_i64),
        "atCalls"    => JSON::Any.new(state.core.at_calls.map { |call| JSON::Any.new(call) }),
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
        sleep 1.5
        parse_batches = watcher.collect(page)
        page.evaluate(mutation)
        sleep 0.8
        mutation_batches = watcher.collect(page)
        live = Live.create_state
        first = watcher.pulse(page, live)
        sleep 1.1
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
        core.tabs.find { |page| page.context_id == id } ||
        raise ArgumentError.new("no tab #{id}")
      end
      begin
        object["script"].as_a.each do |step_value|
          step = step_value.as_h
          case step["op"].as_s
          when "tabs"
            observations.push(JSON::Any.new(core.tabs.map { |page| JSON::Any.new(page.context_id) }))
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
            observations.push(JSON::Any.new(page.try(&.context_id)))
          when "after"
            page = core.tab_after(find_page.call(step["id"].as_s))
            observations.push(JSON::Any.new(page.try(&.context_id)))
          when "label"
            observations.push(JSON::Any.new(core.tab_label(find_page.call(step["id"].as_s))))
          when "foreground"
            observations.push(JSON::Any.new(core.foreground?(find_page.call(step["id"].as_s))))
          when "new"
            observations.push(JSON::Any.new(core.new_tab.context_id))
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
      )
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
      observations = [] of JSON::Any
      object["script"].as_a.each do |step_value|
        step = step_value.as_h
        case step["op"].as_s
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
            observations.push JSON::Any.new(nil)
          when "url"
            observations.push JSON::Any.new(current.not_nil!.url)
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
            observations.push(JSON::Any.new(acting.not_nil!.set_files(handle.not_nil!, paths)))
          when "real_click"
            observations.push(Actions.real_click(
              session, current.not_nil!.context_id, handle.not_nil!))
          when "hover"
            observations.push(Actions.hover(
              session, current.not_nil!.context_id, handle.not_nil!))
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
            Actions.click_slider(session, current.not_nil!.context_id, handle.not_nil!,
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
            when "focus_control"
              answers.push(Actions.focus_control(held))
            when "submits_autofilled"
              answers.push(Actions.submits_autofilled(held))
            when "real_click"
              answers.push(Actions.real_click(frame.session, frame.context_id, held))
            when "hover"
              answers.push(Actions.hover(frame.session, frame.context_id, held))
            when "adjust_control"
              keyboard = FirefoxDriver::Keyboard.new(browser.protocol, page.context_id)
              answers.push(Actions.adjust_control(
                keyboard, frame.context_id, target["role"]?.try(&.as_s?), held,
                target["key"].as_s))
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
          clicked = Actions.real_click(frame.session, frame.context_id, button)
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
