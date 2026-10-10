require "./keys"

module Tawb
  # The keyboard wizard: the one screen where the bindings themselves are
  # edited.
  #
  # The list is driven by the same bindings as the rest of the browser, so it
  # stays usable while they change under it — a key whose action means nothing
  # to a list falls back to what the key itself does here, and a key being
  # captured for a binding is read raw, so the arrows and Enter can still be
  # assigned to anything.
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

      def initialize(@type : String, @action : Keys::Action? = nil, @label : String? = nil); end
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

    # Imported commands with no TAWB equivalent are listed so the screen is a
    # complete picture of what the reader's configuration asked for, and
    # headed so it is plain that they are an inventory rather than something
    # to bind.
    def self.wizard_rows(keymap : Keys::Keymap) : Array(Row)
      unsupported = keymap.unsupported
      labels = keymap.labels
      rows = keymap.actions.map { |action| Row.new("action", action) }.to_a
      unless unsupported.empty?
        rows << Row.new("heading", nil,
          labels["unsupportedHeading"]? || "Commands with no TAWB equivalent:")
      end
      unsupported.each do |name|
        rows << Row.new("unsupported", nil,
          "#{labels["unsupportedPrefix"]? || "Imported command"} #{name}, unsupported")
      end
      rows << Row.new("reset", nil, "Restore default bindings")
      rows << Row.new("exit", nil, "Exit keyboard wizard")
      rows
    end

    def self.row_text(row : Row, keymap : Keys::Keymap) : String
      return row.label.not_nil! unless row.type == "action"
      action = row.action.not_nil!
      bindings = if action.bindings.empty?
        "(unbound)"
      else
        action.bindings.map { |binding| keymap.display(binding) }.join(", ")
      end
      # In an interface that names its functions the row leads with the
      # function it acts on, so a reader can find their own entry by name.
      function_name = keymap.function_names[action.id]?
      name = function_name ? "#{function_name} — #{action.label}" : action.label
      "#{name}, #{bindings}"
    end

    # Runs the wizard to completion and answers whether it saved the
    # bindings. The reader and the terminal come in from outside, so the
    # differenced tests drive the same loop against recorded fakes, and the
    # terminal loop later supplies the real ones.
    def self.run(output : Output, keymap : Keys::Keymap, reader : KeySource,
                 alt_screen : Bool = true) : Bool
      original = keymap.actions.to_h { |action| {action.id, action.bindings.dup} }
      selected = 0
      scroll = 0
      status = "Enter replaces a binding; Alt+A adds one."
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

      render = ->(clear : Bool) do
        rows = wizard_rows(keymap)
        height = Math.max(1, output.rows - 4)
        scroll = selected if selected < scroll
        scroll = selected - height + 1 if selected >= scroll + height
        scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.size - height)))

        if clear
          output.write("\e[2J")
          drawn.heading = nil
          drawn.hint = nil
          drawn.status = nil
          drawn.list = [] of String?
        end

        heading = keymap.labels["keyboardTitle"]? || "Keyboard bindings"
        if drawn.heading != heading
          draw_line(output, 1, heading, output.columns)
          drawn.heading = heading
        end

        hint = if capturing
          "#{capturing == "add" ? "Adding to" : "Replacing"} " \
            "#{rows[selected].action.not_nil!.label}: press one key; Esc cancels."
        else
          "#{key_label.call("previous-line", "Up")}/#{key_label.call("next-line", "Down")}: move" \
            "  #{key_label.call("activate", "Enter")}: replace  Alt+A: add" \
            "  #{key_label.call("quit", "Escape")}: exit"
        end
        if drawn.hint != hint
          draw_line(output, 2, hint, output.columns)
          drawn.hint = hint
        end

        (0...height).each do |i|
          index = scroll + i
          text = index < rows.size ? row_text(rows[index], keymap) : ""
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
          output.write("\e[#{3 + selected - scroll};1H")
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
        rows = wizard_rows(keymap)
        row = rows[selected]

        if capturing
          if key == ESC
            capturing = nil
            status = "Binding unchanged."
          elsif capturing == "replace" && BACKSPACE.includes?(key)
            keymap.unbind(row.action.not_nil!.id)
            capturing = nil
            status = "#{row.action.not_nil!.label} is unbound."
          else
            add = capturing == "add"
            binding = keymap.name_for_sequence(key)
            clashes = keymap.conflicts(row.action.not_nil!.id, binding)
            capturing = nil
            if clashes.empty?
              result = keymap.assign(row.action.not_nil!.id, key, add)
              status = "#{result.not_nil![:binding]} assigned to #{row.action.not_nil!.label}."
            else
              # Taking a key from something else is the one edit here the
              # reader cannot see coming, so it is named and asked about
              # rather than reported once it has already happened.
              pending = {id: row.action.not_nil!.id, label: row.action.not_nil!.label,
                         key: key, add: add}
              status = "#{keymap.display(binding)} is assigned to " \
                "#{clashes.map(&.label).join(" and ")}; " \
                "rebind to #{row.action.not_nil!.label}? y/n"
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
          elsif key == "n" || key == "N" || key == ESC
            status = "Binding unchanged."
          else
            next
          end
          pending = nil
          render.call(false)
          next
        end

        # Adding a binding is the wizard's own control rather than a browsing
        # command, so it is read before the keymap gets a look at the key.
        if ALT_A.includes?(key) && row.type == "action"
          capturing = "add"
          status = "Press the key to add to #{row.action.not_nil!.label}."
          render.call(false)
          next
        end

        # Everything else goes through the same bindings the page view uses,
        # so whatever moves the reader down a line, to the top, or out of the
        # browser does the same thing to this list.
        action = wizard_action(keymap, key)
        screen = Math.max(1, output.rows - 4)

        case action
        when "next-line"
          selected = Math.min(selected + 1, rows.size - 1)
        when "previous-line"
          selected = Math.max(selected - 1, 0)
        when "next-screen"
          selected = Math.min(selected + screen, rows.size - 1)
        when "previous-screen"
          selected = Math.max(selected - screen, 0)
        when "top", "line-start"
          # A list row is a single item with nowhere to go across it, so the
          # start and end keys move within the list like the top and bottom
          # keys rather than doing nothing at all.
          selected = 0
        when "bottom", "line-end"
          selected = rows.size - 1
        when "where"
          status = "Item #{selected + 1} of #{rows.size} — #{row_text(row, keymap)}."
        when "activate"
          case row.type
          when "action"
            capturing = "replace"
            status = "Press the replacement for #{row.action.not_nil!.label}; Backspace unbinds it."
          when "reset"
            keymap.reset
            status = "Default bindings restored. They are not saved yet."
          when "unsupported"
            status = "#{row.label}."
          when "heading"
            status = "These have no TAWB equivalent, so there is nothing to bind them to."
          else
            leave.call
          end
        when "quit", "close-popup"
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
