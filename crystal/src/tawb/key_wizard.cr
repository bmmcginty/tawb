require "./keys"
require "./list_model"
require "./wizard_order"

module Tawb
  # The keyboard wizard: the one screen where the bindings themselves are
  # edited.
  #
  # The list is driven by the same bindings as the rest of the browser, so it
  # stays usable while they change under it — a non-printing key whose action
  # means nothing to a list falls back to what the key itself does here, and a
  # key being captured for a binding is read raw, so the arrows and Enter can
  # still be assigned to anything. Printable keys are filter text first, which
  # is why the list's movement is the arrows and paging keys.
  module KeyWizard
    ESC       = "\e"
    BACKSPACE = Set.new(["\x7f", "\x08"])
    ALT_A     = Set.new(["\ea", "\eA"])

    # What this list can be told to do. Any other action — refresh, next tab,
    # find — has no meaning against a list of bindings.
    WIZARD_ACTIONS = Set.new([
      "next-line", "previous-line", "next-screen", "previous-screen",
      "top", "bottom", "line-start", "line-end", "where", "activate",
      "quit", "close-popup",
    ])

    MOVE_ACTIONS = {
      "next-line"       => "next",
      "previous-line"   => "previous",
      "next-screen"     => "page-next",
      "previous-screen" => "page-previous",
      "top"             => "first",
      "line-start"      => "first",
      "bottom"          => "last",
      "line-end"        => "last",
    }

    # The terminal the wizard draws on: byte-level writes, a size, and a
    # resize event. The JavaScript original used process.stdout.
    module Output
      abstract def write(text : String) : Nil
      abstract def rows : Int32
      abstract def columns : Int32
      abstract def on_resize(handler : Proc(Nil)) : Nil
      abstract def off_resize(handler : Proc(Nil)) : Nil
    end

    # The keyboard the wizard reads from. Nil from next_key means the keyboard
    # is gone; nothing typed by then has been written, so the wizard leaves
    # the keymap as it found it.
    module KeySource
      abstract def next_key : String?
      abstract def close : Nil
    end

    class Row
      getter type : String
      getter action : Keys::Action?
      getter label : String?
      getter key : String
      getter text : String
      getter search : String

      def initialize(@type : String, @action : Keys::Action? = nil,
                     @label : String? = nil, @key : String = "",
                     @text : String = "", @search : String = "")
      end
    end

    private class Drawn
      property heading : String?
      property hint : String?
      property status : String?
      property list : Array(String?)

      def initialize
        @heading = nil
        @hint = nil
        @status = nil
        @list = [] of String?
      end
    end

    # What a row says. The bindings are part of the search text as well as the
    # visible line, so a reader who remembers a key can find the action holding
    # it, and a reader who remembers part of the name does not need the key.
    def self.action_text(action : Keys::Action, keymap : Keys::Keymap) : String
      bindings = if action.bindings.empty?
        "no key assigned"
      else
        action.bindings.map { |binding| keymap.display(binding) }.join(", ")
      end
      # In an interface that names its functions the row leads with the
      # function it acts on, so a reader can find their own entry by name.
      function_name = keymap.function_names[action.id]?
      name = function_name ? "#{function_name} — #{action.label}" : action.label
      "#{name}, #{bindings}"
    end

    def self.action_row(action : Keys::Action, keymap : Keys::Keymap) : Row
      text = action_text(action, keymap)
      function_name = keymap.function_names[action.id]? || ""
      Row.new("action", action, nil, "action:#{action.id}", text,
        [text, action.id, function_name].reject(&.empty?).join("\n"))
    end

    def self.pinned_rows : Array(Row)
      [
        Row.new("heading", nil, "Keyboard wizard actions", "cmd:heading",
          "Keyboard wizard actions", "Keyboard wizard actions"),
        Row.new("reset", nil, "Restore default bindings", "cmd:reset",
          "Restore default bindings", "Restore default bindings"),
        Row.new("exit", nil, "Exit keyboard wizard", "cmd:exit",
          "Exit keyboard wizard", "Exit keyboard wizard"),
      ]
    end

    # Imported commands with no TAWB equivalent are listed so the screen is a
    # complete picture of what the reader's configuration asked for, and headed
    # so it is plain that they are an inventory rather than something to bind.
    def self.unsupported_section(keymap : Keys::Keymap) : ListModel::Section(Row)?
      unsupported = keymap.unsupported
      return nil if unsupported.empty?
      labels = keymap.labels
      rows = unsupported.map do |name|
        label = "#{labels["unsupportedPrefix"]? || "Imported command"} #{name}, unsupported"
        Row.new("unsupported", nil, label, "unsupported:#{name}", label, label)
      end
      ListModel::Section(Row).new("unsupported",
        labels["unsupportedHeading"]? || "Commands with no TAWB equivalent:", rows)
    end

    def self.wizard_sections(keymap : Keys::Keymap) : Array(ListModel::Section(Row))
      sections = WizardOrder.sections_for(keymap.actions).map do |section|
        rows = section.rows.map { |action| action_row(action, keymap) }
        ListModel::Section(Row).new(section.key, section.title, rows)
      end
      if unsupported = unsupported_section(keymap)
        sections << unsupported
      end
      sections
    end

    def self.wizard_entries(keymap : Keys::Keymap, filter : String) : Array(ListModel::Entry(Row))
      ListModel.visible_entries(wizard_sections(keymap), pinned_rows, filter)
    end

    # The flat view the tests and the conformance surface read. The screen
    # itself uses wizard_entries, which also carries the section each row came
    # from.
    def self.wizard_rows(keymap : Keys::Keymap, filter : String = "") : Array(Row)
      wizard_entries(keymap, filter).map do |entry|
        if entry.kind == "heading"
          title = entry.title || ""
          Row.new("heading", nil, title, entry.key, title, title)
        else
          entry.row.not_nil!
        end
      end
    end

    def self.row_text(row : Row, keymap : Keys::Keymap) : String
      return row.text unless row.text.empty?
      return row.label || "" unless row.type == "action"
      action_text(row.action.not_nil!, keymap)
    end

    def self.entry_text(entry : ListModel::Entry(Row)?, keymap : Keys::Keymap) : String
      return "" unless entry
      return entry.title || "" if entry.kind == "heading"
      row_text(entry.row.not_nil!, keymap)
    end

    # A printable character belongs to the filter before it belongs to any
    # binding. Del is a control character the terminal encodes above space and
    # is this screen's Backspace, so it is excluded explicitly.
    def self.filter_character?(chunk : String) : Bool
      !chunk.starts_with?(ESC) && chunk != "\x7f" && chunk >= " "
    end

    def self.filter_status(keymap : Keys::Keymap, filter : String) : String
      sections = wizard_sections(keymap)
      total = 0
      sections.each { |section| total += section.rows.size }
      shown = ListModel.visible_entries(sections, [] of Row, filter)
        .count { |entry| entry.kind == "row" }
      return "#{total} rows." if filter.empty?
      shown > 0 ? "#{shown} of #{total} rows matching \"#{filter}\"." :
        "Nothing matching \"#{filter}\"."
    end

    # Runs the wizard to completion and answers whether it saved the
    # bindings. The reader and the terminal come in from outside, so the
    # differenced tests drive the same loop against recorded fakes, and the
    # terminal loop later supplies the real ones.
    def self.run(output : Output, keymap : Keys::Keymap, reader : KeySource,
                 alt_screen : Bool = true) : Bool
      original = keymap.actions.to_h { |action| {action.id, action.bindings.dup} }
      selected_key : String? = nil
      filter = ""
      scroll = 0
      status = "Enter replaces a binding; Alt+A adds one. Type to filter."
      capturing : String? = nil
      pending : NamedTuple(id: String, label: String, key: String, add: Bool)? = nil
      saving = false
      done = false
      saved = false
      left_screen = false
      drawn = Drawn.new

      leave_screen = ->() do
        unless left_screen
          left_screen = true
          # The alternate screen is taken only when this wizard owns the
          # screen. Left standalone it saves the shell exactly as it was;
          # opened from the browser it draws on whichever screen that session
          # is already using, so there is nothing to save or restore around
          # it.
          output.write("\e[?1049l") if alt_screen
        end
      end

      # Leaving the screen when the process is torn down, as the JavaScript
      # original did with prepended signal listeners. Crystal has no handler
      # stack, so the previous handlers are not restorable here — the loop
      # that opened the wizard re-registers its own after this one returns.
      {Signal::INT, Signal::TERM, Signal::HUP}.each do |signal|
        signal.trap { leave_screen.call }
      end

      if alt_screen
        output.write("\e[?1049h")
      end
      output.write("\e[r")

      # The hint has to name whatever the bindings currently are — including a
      # change the reader has just made a few rows further up this very list.
      key_label = ->(id : String, fallback : String) do
        action = keymap.by_id(id)
        binding = action.try(&.bindings.first?)
        binding ? keymap.display(binding) : fallback
      end

      # A binding has changed. The row the reader was on is the one they
      # should still be on, and a filter that hid part of the screen is no
      # longer the question they are asking.
      refocus = ->(key : String) do
        filter = ""
        selected_key = key
      end

      render = ->(clear : Bool) do
        entries = wizard_entries(keymap, filter)
        selected_key = ListModel.selection_key(entries, selected_key)
        selected = ListModel.selection_index(entries, selected_key)
        height = Math.max(1, output.rows - 4)
        scroll = selected if selected < scroll
        scroll = selected - height + 1 if selected >= scroll + height
        scroll = Math.max(0, Math.min(scroll, Math.max(0, entries.size - height)))

        if clear
          output.write("\e[2J")
          drawn.heading = nil
          drawn.hint = nil
          drawn.status = nil
          drawn.list = [] of String?
        end

        heading = keymap.labels["keyboardTitle"]? || "Keyboard shortcuts"
        if drawn.heading != heading
          draw_line(output, 1, heading, output.columns)
          drawn.heading = heading
        end

        selected_entry = selected >= 0 ? entries[selected] : nil
        selected_row = selected_entry.try(&.row)
        selected_label = selected_row.try(&.action).try(&.label) ||
          selected_row.try(&.label) || ""
        hint = if capturing
          "#{capturing == "add" ? "Adding to" : "Replacing"} " \
            "#{selected_label}: press one key; Esc cancels."
        elsif filter.empty?
          "#{key_label.call("previous-line", "Up")}/#{key_label.call("next-line", "Down")}: move" \
            "  #{key_label.call("activate", "Enter")}: replace  Alt+A: add" \
            "  type: filter  #{key_label.call("quit", "Escape")}: exit"
        else
          "Filter: #{filter}  Backspace: erase  #{key_label.call("quit", "Escape")}: exit"
        end
        if drawn.hint != hint
          draw_line(output, 2, hint, output.columns)
          drawn.hint = hint
        end

        (0...height).each do |i|
          index = scroll + i
          text = index < entries.size ? entry_text(entries[index], keymap) : ""
          if i < drawn.list.size
            next if drawn.list[i] == text
            drawn.list[i] = text
          else
            drawn.list << text
          end
          draw_line(output, 3 + i, text, output.columns)
        end
        # A resize can shorten the list area. Forget rows which no longer
        # have a physical list row, so growing it again does not mistake
        # stale text for something still on screen.
        while drawn.list.size > height
          drawn.list.pop
        end

        if drawn.status != status
          draw_line(output, output.rows, status, output.columns)
          drawn.status = status
        end

        # The cursor marks the place the next key will affect. Ordinarily
        # that is the selected row. While a question is waiting for one key
        # or a y/n answer, it is the answer position at the end of that
        # prompt instead — otherwise a screen reader keeps reporting the list
        # item while input is being consumed somewhere else entirely. This
        # must be the final write.
        if capturing || pending || saving
          output.write("\e[#{output.rows};#{Math.min(status.size + 1, output.columns)}H")
        else
          output.write("\e[#{3 + Math.max(selected, 0) - scroll};1H")
        end
      end

      # Leaving without saving: the wizard's changes live in memory until it
      # is done with them, so putting the originals back is all there is to
      # it.
      restore = ->() do
        keymap.actions.each do |action|
          action.bindings = original[action.id].dup
        end
        keymap.rebuild
        done = true
      end

      # Leaving asks about saving, because the changes made here are held in
      # memory until the wizard is done with them.
      leave = ->() do
        saving = true
        status = "Save keyboard changes? y/n"
        render.call(false)
        loop do
          answer = reader.next_key
          # A question asked of a keyboard that is no longer there is not
          # answered "yes". Bindings are held in memory until this point, so
          # putting the originals back is what leaving without saving means —
          # and without this the loop would spin on an answer that never
          # comes.
          if answer.nil?
            restore.call
            return
          end
          if answer == "y" || answer == "Y"
            keymap.save
            saved = true
            done = true
            return
          end
          if answer == "n" || answer == "N"
            restore.call
            return
          end
        end
      end

      on_resize = ->() { render.call(true) }
      output.on_resize(on_resize)
      render.call(true)

      until done
        key = reader.next_key
        # The keyboard has gone. Nothing typed here has been written yet, so
        # the wizard leaves the keymap as it found it.
        if key.nil?
          restore.call
          break
        end
        entries = wizard_entries(keymap, filter)
        selected_key = ListModel.selection_key(entries, selected_key)
        selected = ListModel.selection_index(entries, selected_key)
        entry = selected >= 0 ? entries[selected] : nil
        row = entry.try(&.row)

        if capturing
          if key == ESC
            capturing = nil
            status = "Binding unchanged."
          elsif capturing == "replace" && BACKSPACE.includes?(key)
            keymap.unbind(row.not_nil!.action.not_nil!.id)
            capturing = nil
            refocus.call(row.not_nil!.key)
            status = "#{row.not_nil!.action.not_nil!.label} is unbound."
          else
            add = capturing == "add"
            binding = keymap.name_for_sequence(key)
            clashes = keymap.conflicts(row.not_nil!.action.not_nil!.id, binding)
            capturing = nil
            if clashes.empty?
              result = keymap.assign(row.not_nil!.action.not_nil!.id, key, add)
              status = "#{result.not_nil![:binding]} assigned to #{row.not_nil!.action.not_nil!.label}."
              refocus.call(row.not_nil!.key)
            else
              # Taking a key from something else is the one edit here the
              # reader cannot see coming, so it is named and asked about
              # rather than reported once it has already happened.
              pending = {id: row.not_nil!.action.not_nil!.id,
                         label: row.not_nil!.action.not_nil!.label,
                         key: key, add: add}
              status = "#{keymap.display(binding)} is assigned to " \
                "#{clashes.map(&.label).join(" and ")}; " \
                "rebind to #{row.not_nil!.action.not_nil!.label}? y/n"
            end
          end
          render.call(false)
          next
        end

        if waiting = pending
          if key == "y" || key == "Y"
            result = keymap.assign(waiting[:id], waiting[:key], waiting[:add])
            status = "#{result.not_nil![:binding]} assigned to #{waiting[:label]}." +
              (result.not_nil![:displaced] ? " Removed from #{result.not_nil![:displaced].not_nil!.label}." : "")
            refocus.call("action:#{waiting[:id]}")
          elsif key == "n" || key == "N" || key == ESC
            status = "Binding unchanged."
          else
            next
          end
          pending = nil
          render.call(false)
          next
        end

        # A list is a filter box first. Printable input is text for the
        # filter, even where the same key is a command out on the page; Del is
        # a control character the terminal encodes above space and stays
        # Backspace.
        if filter_character?(key)
          filter = ListModel.append_filter(filter, key)
          selected_key = ListModel.selection_key(wizard_entries(keymap, filter), selected_key)
          status = filter_status(keymap, filter)
          render.call(false)
          next
        end
        if BACKSPACE.includes?(key)
          if filter.empty?
            status = "The filter is empty."
          else
            filter = ListModel.backspace_filter(filter)
            selected_key = ListModel.selection_key(wizard_entries(keymap, filter), selected_key)
            status = filter_status(keymap, filter)
          end
          render.call(false)
          next
        end

        # Adding a binding is the wizard's own control rather than a browsing
        # command, so it is read before the keymap gets a look at the key.
        if ALT_A.includes?(key)
          if row && row.type == "action"
            capturing = "add"
            status = "Press the key to add to #{row.action.not_nil!.label}."
          else
            status = "Move to an action row to add a binding."
          end
          render.call(false)
          next
        end

        # Everything else goes through the same bindings the page view uses,
        # so whatever moves the reader down a line, to the top, or out of the
        # browser does the same thing to this list.
        action = wizard_action(keymap, key)
        screen = Math.max(1, output.rows - 4)
        movement = MOVE_ACTIONS[action]?

        if movement
          selected_key = ListModel.move_key(entries, selected_key, movement, screen)
        elsif action == "where"
          status = "Item #{selected + 1} of #{entries.size} — #{entry_text(entry, keymap)}."
        elsif action == "activate"
          if entry && entry.kind == "heading"
            status = entry.title || ""
          elsif row && row.type == "heading"
            status = row.label || ""
          elsif row && row.type == "action"
            capturing = "replace"
            status = "Press the replacement for #{row.action.not_nil!.label}; Backspace unbinds it."
          elsif row && row.type == "reset"
            keymap.reset
            status = "Default bindings restored. They are not saved yet."
          elsif row && row.type == "unsupported"
            status = "#{row.label}."
          elsif row && row.type == "exit"
            leave.call
          else
            status = "Nothing here to activate."
          end
        elsif action == "quit" || action == "close-popup"
          # Quitting leaves the wizard rather than the browser, and closing a
          # popup is what Escape means everywhere else in the browser.
          leave.call
        end
        render.call(false) unless done
      end

      output.off_resize(on_resize)
      {Signal::INT, Signal::TERM, Signal::HUP}.each(&.reset)
      reader.close
      leave_screen.call
      saved
    end

    # A key whose action means nothing to this list falls back to what the
    # key itself does here: the arrows always move, Enter always activates
    # and Escape always leaves, however they happen to be bound. Nothing is
    # taken away by this — a key being captured for a binding is read raw, so
    # the arrows and Enter can still be assigned to anything.
    private def self.wizard_action(keymap : Keys::Keymap, key : String) : String?
      action = keymap.action_for(key)
      return action if action && WIZARD_ACTIONS.includes?(action)
      return "next-line" if keymap.is_key(key, "ArrowDown")
      return "previous-line" if keymap.is_key(key, "ArrowUp")
      return "activate" if keymap.is_key(key, "Enter")
      return "quit" if key == ESC
      action
    end

    private def self.draw_line(output : Output, row : Int32, text : String, columns : Int32) : Nil
      output.write("\e[#{row};1H")
      output.write("\e[2K#{text[0, Math.min(text.size, columns)]}")
    end
  end
end
