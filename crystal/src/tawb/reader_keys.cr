require "json"
require "./reader"
require "./edit"
require "./quicknav"
require "./lynx_actions"
require "./keys"
require "./input"
require "./interfaces"
require "./library"
require "./auth"
require "./unicode_escape"

module Tawb
  # The reading loop's keyboard: what each mode does with one keystroke.
  #
  # The handlers here are the state machines. What they touch outside the
  # state — the page's address, the keyboard a key must reach — arrives as
  # arguments or through the host the loop hands in, so the same code runs
  # against the real browser, against the conformance harness's scripted
  # one, and in the tests. What they write goes through the Screen output
  # the loop owns, for the same reason.
  module ReaderKeys
    # The ordinary interface's defaults, asked for whenever no keymap has
    # loaded. JavaScript builds this once at module scope; a constant here
    # is the same once.
    FALLBACK_KEYMAP = Keys::Keymap.new

    ESC = "\e"

    def self.key_is(chunk : String, name : String, state : Reader::State) : Bool
      (state.keys || FALLBACK_KEYMAP).is_key(chunk, name)
    end

    def self.keymap_for(state : Reader::State) : Keys::Keymap
      state.keys || FALLBACK_KEYMAP
    end

    # The interface view the Lynx decisions read. Built per question, since
    # the reader state carries the interface and the keymap separately.
    def self.lynx_view(state : Reader::State) : LynxActions::State
      LynxActions::State.new(state.interface, state.keys).tap do |view|
        view.reader = state
      end
    end

    # ------------------------------------------------------------------
    # Finding text
    #
    # `/` searches forward, `?` backward, over the lines as they are
    # written — so a match lands the cursor on the matching text itself,
    # not merely on the line holding it, which is what a braille display
    # and a screen reader follow. Wrapped rows are searched like any other,
    # since each is navigable in its own right.
    #
    # Case follows what was typed: an all-lowercase search ignores case,
    # and one with a capital in it does not. It is the rule vi and less
    # use, and it means searching for "braille" finds the heading while
    # searching for "Braille" finds only the name.
    #
    # There is no `n` for the next match: `n` is non-link text in the JAWS
    # vocabulary this reader uses, and taking a jump key away to save two
    # keystrokes is a poor trade. `Ctrl+G` repeats the search — Firefox's
    # key for exactly this — and `/` or `?` with nothing typed repeats it
    # in that direction, which is how a search is reversed.
    # ------------------------------------------------------------------

    def self.find_text(state : Reader::State, needle : String,
                       direction : Int32) : NamedTuple(line: Int32, col: Int32, wrapped: Bool)?
      total = state.lines.size
      return nil if total == 0 || needle.empty?

      # Ordinary TAWB uses smart case. Lynx has an explicit Searching Type
      # option, so its choice is absolute and remains isolated to that
      # interface.
      displayed_needle = Reader.page_text(state, needle)
      search_case = lynx_view(state).search_case
      sensitive = search_case == "CASE_SENSITIVE" ||
                  (search_case != "CASE_INSENSITIVE" && displayed_needle.matches?(/[A-Z]/))
      want = sensitive ? displayed_needle : displayed_needle.downcase

      # One extra step so the line the search started on is examined again
      # from its own start after the wrap, rather than being the one place
      # a match could hide.
      (0..total).each do |step|
        index = ((state.cursor + direction * step) % total + total) % total
        text = Reader.line_text(state, index)
        text = sensitive ? text : text.downcase

        at = if step == 0
               # Start from just past the cursor, so repeating a search advances
               # within a long line instead of finding the same match again.
               if direction > 0
                 index_of(text, want, state.col + 1)
               else
                 state.col > 0 ? last_index_of(text, want, state.col - 1) : -1
               end
             else
               direction > 0 ? index_of(text, want, 0) : last_index_of(text, want, text.size - 1)
             end

        if at >= 0
          wrapped = step > 0 && (direction > 0 ? index <= state.cursor : index >= state.cursor)
          return {line: index, col: at, wrapped: wrapped}
        end
      end

      nil
    end

    # The first position at or after `from` where `want` begins, or -1.
    # Positions are the display line's own, counted the way the reader's
    # caret counts them.
    private def self.index_of(text : String, want : String, from : Int32) : Int32
      return -1 if want.empty? || from > text.size - want.size
      found = text.index(want, from)
      found || -1
    end

    # The last position at or before `from` where `want` begins, or -1.
    private def self.last_index_of(text : String, want : String, from : Int32) : Int32
      return -1 if want.empty?
      start = Math.min(from, text.size - want.size)
      while start >= 0
        return start if text[start, want.size] == want
        start -= 1
      end
      -1
    end

    def self.run_search(output : Screen::Output, state : Reader::State, page_url : String,
                        needle : String, direction : Int32) : Nil
      found = find_text(state, needle, direction)
      unless found
        Reader.set_status(output, state, page_url, "\"#{needle}\" not found.")
        return
      end
      Reader.move_selection(output, state, page_url, found[:line], found[:col])
      Reader.set_status(output, state, page_url,
        "\"#{needle}\" — line #{found[:line] + 1} of #{state.lines.size}" +
        (found[:wrapped] ? ", wrapped" : "") + ".")
    end

    # The keyboard a prompt borrows while the reading loop is stopped. The
    # claim/release protocol is the input reader's; a prompt that forgot to
    # release would take the reading loop's keys with it.
    module Keyboard
      abstract def claim : Input::Token
      abstract def next_key(token : Input::Token) : Input::Key
      abstract def release(token : Input::Token) : Nil

      # Wait for either a key or a pending navigation to finish. Unlike a
      # bare race with next_key, the losing side's wait is removed, so the
      # next key cannot disappear into an abandoned promise.
      abstract def next_or(operation : Channel(NavigateOutcome), token : Input::Token) : Input::OperationResult(NavigateOutcome) | Input::KeyResult
    end

    # How a navigation ended: on its own, or cancelled by a key.
    alias NavigateOutcome = NamedTuple(ok: Bool, fault: String?, cancelled: Bool)

    # What one key did to the auth prompt: nothing yet, or an answer.
    enum AuthStep
      Continue
    end

    # ------------------------------------------------------------------
    # The webpage keyboard
    #
    # Every other key goes to the page. This is how a reader reaches the
    # controls a page listens for on its own — Space to play or pause, m to
    # mute, the arrow keys a map listens for — without the reader's own map
    # standing in the way. One configurable chord comes back, and with it a
    # rescan when the reader pauses, because the page may have moved under
    # all those keys.
    # ------------------------------------------------------------------

    # Turn one complete terminal keystroke back into the name understood by
    # both browser drivers. Printable characters already are their own
    # names; terminfo sequences become ArrowUp, PageDown, and so on. The
    # only spelling difference is Ctrl (terminal convention) versus Control
    # (browser protocol convention).
    def self.browser_key_for_terminal_sequence(chunk : String,
                                               keys : Keys::Keymap) : String?
      name = keys.name_for_sequence(chunk)
      return nil if name.empty? || name.starts_with?("raw:")
      return " " if name == "Space"
      name.starts_with?("Ctrl+") ? "Control+#{name[5..]}" : name
    end

    def self.handle_page_key(output : Screen::Output, state : Reader::State,
                             page : Reader::PageEnv, chunk : String, now : Int64) : Nil
      state.core.mark_input
      keys = keymap_for(state)

      # The same configurable key enters and leaves this mode. Everything
      # else, including Escape, Ctrl+L, arrows and ordinary browse-mode
      # commands, is deliberately the webpage's rather than ours.
      if keys.action_for(chunk) == "page-keyboard"
        state.mode = "browse"
        state.page_keyboard_exit_until = now + 1500
        # Do not hold the keyboard while taking a potentially multi-second
        # snapshot. Besides making the exit feel broken, key repeat queued a
        # second toggle behind that wait and re-entered page mode as soon as
        # the snapshot ended. The ordinary live-refresh path already knows
        # how to rebuild without racing subsequent input, so ask it to do so
        # when the reader becomes idle.
        if live_object = state.core.live
          if hash = live_object.as_h?
            hash["dirty"] = JSON::Any.new(true)
            hash["lastPulseMs"] = JSON::Any.new(0_i64)
          end
        end
        Reader.draw_hint(output, state)
        enabled = state.core.live.try(&.as_h?).try(&.["enabled"]?.try(&.as_bool?)) || false
        Reader.set_status(output, state, page.url,
          enabled ? "Webpage keyboard off — the page will rescan when you pause." : "Webpage keyboard off — press r to rescan.")
        return
      end

      name = browser_key_for_terminal_sequence(chunk, keys)
      if name.nil?
        Reader.set_status(output, state, page.url,
          "That terminal key cannot be sent to the webpage.")
        return
      end

      begin
        page.keyboard_press(name)
      rescue err
        reason = err.message.try(&.lines.first?) || err.message || err.to_s
        Reader.set_status(output, state, page.url,
          "Could not send #{keys.name_for_sequence(chunk)} to the webpage: #{reason}")
      end
    end

    # ------------------------------------------------------------------
    # An open popup is a mode of its own
    #
    # A menu the page drew lives in the buffer like any other text, so the
    # browse map would read q as quit and leave the program while the reader
    # meant to shut the menu they are standing in. The mode takes the closing
    # keys before the browse map, and only those: movement and activation
    # still fall through, and Ctrl+C can never be swallowed.
    # ------------------------------------------------------------------

    # The interrupt that always leaves the program, popup or not.
    ALWAYS_QUIT = "\x03"

    # What a key means while that popup is open: close it, quit for real, or
    # fall through to the browse map. Lynx's popup cancels on its quit and
    # abort functions, so all three readings of "leave" close the menu; only
    # the terminal's own interrupt leaves the program. Escape closes it
    # whatever it is bound to, because a menu that could not be shut would
    # be a trap.
    def self.popup_key(action : String?, chunk : String, context_action : String?,
                       escape : Bool) : String?
      return "close" if escape || action == "close-popup"
      return "close" if context_action == "cancel"
      if action == "quit" || action == "confirm-quit" || action == "abort"
        return chunk == ALWAYS_QUIT ? "quit" : "close"
      end
      nil
    end

    # Put the reader on the control the popup belongs to, so the line they
    # leave is the line that opened it.
    def self.move_to_popup(output : Screen::Output, state : Reader::State,
                           page_url : String, item : JSON::Any?) : Nil
      item = nil unless Reader.present?(item)
      return unless item
      return unless (item.as_h?.try(&.["controls"]?)) && state.core.popup
      line = Reader.line_for_block(state, state.core.popup_at.to_i32)
      return if line < 0
      Reader.move_selection(output, state, page_url, line, 0)
      hint = LynxActions.new(NullHost.new).popup_close_hint(lynx_view(state))
      Reader.set_status(output, state, page_url,
        "\"#{item.as_h["name"]?.try(&.as_s?)}\" opened — #{hint} closes it.")
    end

    # Close an open popup the way a person would: by pressing the control
    # that opened it. Leaving it open and merely walking away would leave
    # the page in a state the reader cannot see and did not choose.
    def self.close_popup(output : Screen::Output, state : Reader::State,
                         page : Reader::PageEnv) : Nil
      popup = state.core.popup
      return unless popup
      controls = popup.as_h["controls"]?.try(&.as_s?)
      index = state.core.blocks.index do |block|
        item = block.as_h.try(&.["item"]?)
        item && item.as_h["controls"]?.try(&.as_s?) == controls
      end
      control = index ? state.core.blocks[index].as_h["item"]? : nil
      state.core.forget_popup
      if control.nil?
        Reader.refresh(state, page, false, state.core.anchor)
        Reader.render(output, state, page.url, force: true)
        return
      end
      begin
        state.core.activate(control)
      rescue
        # It may already be gone; the rebuild below is the truth either way.
      end
      Reader.refresh(state, page)
      after = state.core.blocks.index do |block|
        item = block.as_h.try(&.["item"]?)
        item && item.as_h["controls"]?.try(&.as_s?) == controls
      end
      line = after ? Reader.line_for_block(state, after.to_i32) : -1
      state.cursor = line if line >= 0
      Reader.clamp_col(state)
      Reader.clamp_scroll(state)
      Reader.render(output, state, page.url, force: true)
      Reader.set_status(output, state, page.url,
        "Closed \"#{control.as_h["name"]?.try(&.as_s?)}\".")
    end

    # A host that answers nothing, for the pure Lynx predicates the popup
    # status needs. The decisions it would deliver are the loop's own.
    private class NullHost
      include LynxActions::Host

      def fallback_keymap : Keys::Keymap
        FALLBACK_KEYMAP
      end

      def key_is(chunk : String, name : String, state : LynxActions::State) : Bool
        false
      end

      def set_status(state : LynxActions::State, message : String) : Nil
      end

      def current_item(state : LynxActions::State) : LynxActions::Item?
        nil
      end

      def is_field(role : String) : Bool
        false
      end

      def begin_typing(state : LynxActions::State, page, item : LynxActions::Item) : Bool
        false
      end

      def open_link_number_prompt(state : LynxActions::State, digits : String?) : Nil
      end

      def open_help(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def describe_current(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_main_menu(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_options(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_trace_log(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def toggle_trace(state : LynxActions::State) : Nil
      end
    end

    # ------------------------------------------------------------------
    # Signing in
    # ------------------------------------------------------------------

    # One key against the password prompt. Answers AuthStep::Continue while
    # the reader is still typing, nil when the prompt was declined, and the
    # credentials when both fields are done.
    def self.handle_auth_key(state : Reader::State, chunk : String) : AuthStep | JSON::Any?
      prompted = state.auth
      return nil unless prompted
      return nil if key_is(chunk, "Escape", state)

      if chunk == "\r" || chunk == "\n"
        if prompted.stage == "password"
          return JSON::Any.new({
            "username" => JSON::Any.new(prompted.user.text),
            "password" => JSON::Any.new(prompted.password.text),
          })
        end
        # An empty username is the other way out, for a reader who has
        # pressed Enter at a prompt they did not want.
        return nil if prompted.user.text.empty?
        prompted.stage = "password"
        return AuthStep::Continue
      end

      buffer = prompted.stage == "user" ? prompted.user : prompted.password
      editing = Edit.edit_action(chunk, keymap_for(state))
      if editing
        edit_buffer = Edit::Buffer.new(buffer.text, buffer.caret)
        Edit.apply_buffer_edit(edit_buffer, editing)
        buffer.text = edit_buffer.text
        buffer.caret = edit_buffer.caret
      elsif key_is(chunk, "Ctrl+L", state)
        buffer.text = ""
        buffer.caret = 0
      elsif !chunk.starts_with?(ESC) && chunk >= " "
        buffer.text = buffer.text[0, buffer.caret] + chunk + buffer.text[buffer.caret..]
        buffer.caret += chunk.size
      end
      AuthStep::Continue
    end

    # Asks, and does not return until it has an answer.
    #
    # This runs while the reading loop is stopped: the challenge was raised
    # inside a navigation the loop is awaiting, and that navigation cannot
    # finish until the browser is told what to do about the password. So the
    # prompt takes the keyboard for itself and hands it back afterwards.
    def self.ask_for_password(output : Screen::Output, state : Reader::State,
                              keyboard : Keyboard?, challenge : JSON::Any,
                              refused : Bool = false) : JSON::Any?
      return nil unless keyboard
      previous_mode = state.mode
      previous_status = state.status_msg
      state.mode = "auth"
      state.auth = Reader::Auth.new(challenge, refused)

      token = keyboard.claim
      Reader.draw_hint(output, state, force: true)
      Reader.draw_auth_prompt(output, state)
      answer = nil
      begin
        loop do
          chunk = keyboard.next_key(token)
          # The keyboard has gone while the prompt was up. Declining is the
          # only honest answer, and it is the safe one: the challenge is
          # cancelled rather than left holding a request the browser has
          # paused, so the 401's own body loads and the navigation the
          # reading loop is awaiting finishes. The loop is given the same
          # news a moment later.
          break if chunk.is_a?(Input::Eof)
          state.core.mark_input
          step = handle_auth_key(state, chunk.as(String))
          unless step.is_a?(AuthStep)
            answer = step.as?(JSON::Any)
            break
          end
          Reader.draw_auth_prompt(output, state)
        end
      ensure
        asked = state.auth.try(&.challenge)
        keyboard.release(token)
        state.mode = previous_mode
        state.auth = nil
        state.status_msg = previous_status
        Reader.draw_hint(output, state, force: true)
        if asked
          Reader.write_status_row(output, state,
            "Signing in to #{Reader.describe_challenge(asked)}…")
        end
      end
      answer
    end

    # ------------------------------------------------------------------
    # The find prompt
    # ------------------------------------------------------------------

    def self.handle_find_key(output : Screen::Output, state : Reader::State,
                             page_url : String, chunk : String) : Nil
      state.core.mark_input
      find = state.find
      return unless find

      if key_is(chunk, "Escape", state) || key_is(chunk, "Ctrl+C", state)
        state.mode = "browse"
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page_url, "Search cancelled.")
        return
      end

      if chunk == "\r" || chunk == "\n"
        # Nothing typed repeats the last search, in the direction this
        # prompt was opened with — which is the only way to search
        # backwards through what you just found without retyping it.
        needle = find.text.empty? ? (state.last_find.try(&.text) || "") : find.text
        state.mode = "browse"
        Reader.draw_hint(output, state)
        if needle.empty?
          Reader.set_status(output, state, page_url,
            "Nothing searched for yet — type what to find.")
          return
        end
        state.last_find = Reader::Find.new(find.direction, needle, 0)
        return run_search(output, state, page_url, needle, find.direction)
      end

      editing = Edit.edit_action(chunk, keymap_for(state))
      if editing
        buffer = Edit::Buffer.new(find.text, find.caret)
        Edit.apply_buffer_edit(buffer, editing)
        find.text = buffer.text
        find.caret = buffer.caret
      elsif !chunk.starts_with?(ESC) && chunk >= " "
        find.text = find.text[0, find.caret] + chunk + find.text[find.caret..]
        find.caret += chunk.size
      end

      Reader.draw_find(output, state)
    end

    # ------------------------------------------------------------------
    # Activating what the cursor is standing on
    #
    # Enter is the reading loop's one "press this" key, and what it does
    # depends entirely on what is under the cursor: a link navigates, a
    # slider takes the arrow keys, a file input wants paths, a native select
    # opens its own list, an editable field takes the typing mode, and a
    # button does whatever the page does with buttons. Every one of those is
    # the browser's act to carry out; what is here is the ordering, the
    # reporting, and the reader's place in the aftermath.
    # ------------------------------------------------------------------

    # The Lynx context-navigation reading of one chunk, when the profile is
    # Lynx's. The chooser and the file prompt accept the same vocabulary the
    # browse map does, because a reader in the middle of a dropdown should
    # not have to remember a second set of keys.
    private def self.context_action(chunk : String, state : Reader::State) : String?
      keys = state.keys
      Interfaces.context_navigation_action(chunk, state.interface,
        keys ? ->(c : String) { keys.not_nil!.action_for(c) } : nil)
    end

    # The name of the control the dropdown belongs to, as the mode's own
    # record holds it.
    private def self.chooser_control_name(state : Reader::State) : String
      state.chooser.try(&.as_h).try(&.["item"]?).try(&.as_h).try(&.["name"]?).try(&.as_s?) || ""
    end

    # Move only to an exact element represented in this view. Focus is the
    # page's explicit keyboard destination; guessing at a nearby line would
    # turn that useful signal into an unexplained jump. The element-handle
    # half — polling the page for where focus landed, then resolving it to a
    # block — is the core's; what is left here is the reader's own half:
    # putting the cursor on the line and saying what it was.
    def self.follow_activation_focus(output : Screen::Output, state : Reader::State,
                                     page_url : String, focused : JSON::Any?) : String?
      block = state.core.focus_destination_block(focused || JSON::Any.new(nil))
      return nil if block < 0
      line = Reader.line_for_block(state, block)
      return nil if line < 0
      item = state.core.blocks[block]?.try(&.as_h?).try(&.["item"]?)
      Reader.move_selection(output, state, page_url, line, 0)
      name = item.try(&.as_h).try(&.["name"]?).try(&.as_s?)
      name && !name.empty? ? name : (state.core.blocks[block]?.try(&.as_h).try(&.["text"]?).try(&.as_s?) || "")
    end

    # A skip link usually points at a container, and in a graphical browser
    # it scrolls there and moves focus. The buffer has no node identity, so
    # the target is located the way everything else here is, by its content:
    # ask the page what text sits at that fragment, and find that text in
    # the buffer.
    def self.jump_to_fragment(output : Screen::Output, state : Reader::State,
                              page : Reader::PageEnv, hash : String) : Bool
      block_index = state.core.block_at_fragment(hash)
      return false if block_index < 0
      line = state.lines.index { |entry| entry.block_index == block_index && !entry.continuation }
      return false unless line
      Reader.move_selection(output, state, page.url, line, 0)
      true
    end

    # Entering a field: focus it, read what is already in it, and show the
    # value on the reader's own line, caret and all. The core answers nil
    # for a control that cannot take typed text at all — which is how a
    # combobox role that is really a pressed widget is told apart from one
    # that is a text entry.
    def self.begin_typing(output : Screen::Output, state : Reader::State,
                          page : Reader::PageEnv, item : JSON::Any) : Bool
      info = state.core.field_for_typing(item)
      return false unless info
      info_object = info.as_h

      state.mode = "type"
      state.typing = Reader::Typing.new(
        item,
        info_object["text"]?.try(&.as_s?) || "",
        (info_object["caret"]?.try(&.as_i64?) || 0).to_i32)
      Reader.draw_hint(output, state)
      typing = state.typing.not_nil!
      typing.drawn = Reader.typing_text(state)[:text]
      Screen.write_line(output, Reader.line_row(state, state.cursor), typing.drawn.not_nil!)
      true
    end

    # What happened after something was pressed: a different page, a part of
    # this one rewritten, or nothing at all. Nothing here moves the reader
    # unless the page did — a rebuilt buffer keeps their place by content.
    def self.report_after_action(output : Screen::Output, state : Reader::State,
                                 page : Reader::PageEnv, previous_texts : Array(String),
                                 previous_url : String, anchor : JSON::Any?,
                                 screen : JSON::Any?, focused : JSON::Any?) : Bool
      navigated = page.url != previous_url
      if navigated
        Reader.refresh(state, page, true)
      else
        Reader.refresh(state, page, false, anchor)
      end

      # A handle belongs to the old document after navigation and cannot be a
      # destination in the new one. Disposal is still owed even though it
      # cannot be followed.
      focus_name = if navigated
                     state.core.drop_focus_destination(focused || JSON::Any.new(nil))
                     nil
                   else
                     follow_activation_focus(output, state, page.url, focused)
                   end
      regions = navigated ? [] of JSON::Any : state.core.note_changes(previous_texts)
      # A different page is a different screen, so there is nothing to compare
      # against and everything to draw. Staying on the same one usually
      # rewrites a line or two.
      if navigated
        Reader.render(output, state, page.url)
      else
        Reader.repaint_list(output, state, page.url, screen)
      end

      if navigated
        Reader.set_status(output, state, page.url, state.status_msg)
      elsif focus_name
        Reader.set_status(output, state, page.url,
          "#{state.status_msg} — focus moved to \"#{focus_name}\".")
      elsif !regions.empty?
        Reader.set_status(output, state, page.url,
          "#{state.status_msg} — #{regions.size} area#{regions.size == 1 ? "" : "s"} changed, press c to jump.")
      else
        Reader.set_status(output, state, page.url, "#{state.status_msg} — no visible change.")
      end
      !focus_name.nil?
    end

    # What to say afterwards, which is the browser's business as much as
    # ours: the page has had its change event by now.
    def self.attached_note(files : JSON::Any?, asking : String) : String
      list = files.try(&.as_a?) || [] of JSON::Any
      return "Nothing attached to \"#{asking}\"." if list.empty?
      if list.size == 1
        first = list[0].as_h
        name = first["name"]?.try(&.as_s?) || ""
        size = first["size"]?.try(&.as_i64?) || 0_i64
        return "Attached #{name} (#{file_size(size)}) to \"#{asking}\"."
      end
      "Attached #{list.size} files to \"#{asking}\": " +
        list.map { |file| file.as_h["name"]?.try(&.as_s?) || "" }.join(", ")
    end

    def self.activate_current(output : Screen::Output, state : Reader::State,
                              page : Reader::PageEnv, keyboard : Keyboard?) : Nil
      item = Reader.item_under_cursor(state)
      role = item.try(&.as_h).try(&.["role"]?).try(&.as_s?) || ""
      if item.nil? || role == "text"
        Reader.set_status(output, state, page.url, "Nothing to activate on this line.")
        return
      end
      name = item.not_nil!.as_h["name"]?.try(&.as_s?) || ""

      previous_texts = state.core.blocks.map do |block|
        block.as_h["text"]?.try(&.as_s?) || ""
      end
      previous_url = page.url
      # The JavaScript original also remembers the page-history place here
      # (rememberCurrentHistoryPlace), and would let a set of credentials it
      # is holding reconsider whether to ask again; the history traversal
      # helpers and the credentials store are ported with the history and
      # browser-auth work, and until then there is nothing here to remember
      # into.
      anchor = state.core.anchor
      screen = Reader.screen_before(state)
      fragment = Aria::LINK_ROLES.includes?(role) ? state.core.fragment_of(item.not_nil!) : nil
      fragment_hash = fragment.try(&.as_s?)
      # Lynx remembers the links followed during a session; VLINKS lists them.
      if Aria::LINK_ROLES.includes?(role)
        href = item.not_nil!.as_h["href"]?.try(&.as_s?)
        LynxSession.note_visited_link(state, item.not_nil!) if href && !href.empty?
      end
      focused : JSON::Any? = nil

      begin
        Reader.set_status(output, state, page.url, "Activating \"#{name}\"...")
        if role == "slider"
          # A slider is driven by keystrokes, so adjustment needs the control
          # focused first; a control the browser cannot focus cannot be
          # adjusted either, and that is worth saying in those words.
          unless state.core.focus_control(item.not_nil!)
            raise IO::Error.new("the browser could not focus that control")
          end
          state.mode = "control"
          state.controlling = JSON::Any.new({"item" => item.not_nil!})
          Reader.draw_hint(output, state)
          Reader.set_status(output, state, page.url,
            "Controlling \"#{name}\" — use arrows, Home or End; Esc to stop.")
          return
        end

        file_spec = item.not_nil!.as_h["file"]?
        file_hash = file_spec.try(&.as_h?)
        if file_hash
          # A file input is pressed by naming a file, not by pressing it.
          # Nothing is clicked here: a click would ask the desktop for a
          # chooser that neither the reader nor this program can reach.
          multiple = file_hash.not_nil!["multiple"]?.try(&.as_bool?) || false
          accept = file_hash.not_nil!["accept"]?.try(&.as_s?) || ""
          files = ask_for_file_paths(output, state, page.url, keyboard, name, multiple, accept)
          if files.nil? || files.as_a.empty?
            Reader.set_status(output, state, page.url, "Nothing attached to \"#{name}\".")
            return
          end
          paths = files.as_a.map { |file| file.as_h["path"]?.try(&.as_s?) || "" }
          state.core.attach_files(item.not_nil!, paths)
          Reader.refresh(state, page, false, anchor)
          Reader.repaint_list(output, state, page.url, screen)
          Reader.set_status(output, state, page.url, attached_note(files, name))
          return
        end

        if Aria::FIELD_ROLES.includes?(role) &&
           !(item.not_nil!.as_h["nativeControl"]?.try(&.as_bool?) || false)
          # A native select is a list of choices, not a field to type into. It
          # came through here as a combobox and landed the reader in typing
          # mode over a control that has no text in it.
          listing = state.core.options_for(item.not_nil!)
          if listing
            open_chooser(output, state, page, item.not_nil!, listing)
            return
          end

          # ARIA also calls select-only widgets comboboxes and listboxes. A
          # div or button carrying that role has no text caret to enter:
          # pressing it is how its choices open. Fall through to ordinary
          # activation rather than putting the reader in a typing mode that
          # can never change it.
          if begin_typing(output, state, page, item.not_nil!)
            Reader.set_status(output, state, page.url,
              "Typing into \"#{name}\" — Esc to stop, Enter to submit.")
            return
          end
        end

        focus_watch = state.core.watch_activation_focus(item.not_nil!) rescue nil
        begin
          done = state.core.activate(item.not_nil!)
        rescue err
          if focus_watch
            state.core.cancel_activation_focus(focus_watch) rescue nil
          end
          raise err
        end
        focused = focus_watch ? (state.core.activation_focus(focus_watch) rescue nil) : nil
        done_status = done.try(&.as_h?).try(&.["status"]?).try(&.as_s?)
        state.status_msg = done_status && !done_status.empty? ? done_status : "Activated: #{name}"
        # If this control says it opens something, follow it: the thing it
        # opens is very often rendered at the end of the document rather than
        # here.
        controls = item.not_nil!.as_h["controls"]?.try(&.as_s?)
        state.core.follow_popup(controls) if controls && !controls.empty?
      rescue err : Reader::ActionTimeout
        Reader.set_status(output, state, page.url,
          "Gave up activating \"#{name}\" after 6s — it may be inside a bot check or an unreachable frame.")
        return
      rescue err
        reason = (err.message || err.to_s).lines.first? || err.to_s
        Reader.set_status(output, state, page.url, "Error activating \"#{name}\": #{reason}")
        return
      end

      # A fragment link never left the document, whatever it did to the URL,
      # so the buffer still stands and the reader keeps their place — until
      # we move them deliberately, to where the link actually points.
      if fragment_hash
        Reader.refresh(state, page, false, anchor)
        Reader.repaint_list(output, state, page.url, screen)
        focus_name = follow_activation_focus(output, state, page.url, focused)
        jumped = focus_name || jump_to_fragment(output, state, page, fragment_hash.not_nil!)
        if focus_name
          Reader.set_status(output, state, page.url, "Focus moved to \"#{focus_name}\".")
        elsif jumped
          Reader.set_status(output, state, page.url, "Moved to #{fragment_hash}.")
        else
          Reader.set_status(output, state, page.url,
            "\"#{name}\" points at #{fragment_hash}, which is not in this view.")
        end
        return
      end

      followed = report_after_action(output, state, page, previous_texts,
        previous_url, anchor, screen, focused)
      move_to_popup(output, state, page.url, item) unless followed
    end

    # ------------------------------------------------------------------
    # Choosing from a dropdown
    #
    # The core splices the entries into the buffer under the control, so
    # they are ordinary lines and everything that works on lines works on
    # them. What this adds is a mode: movement that cannot wander out of the
    # list, typing that filters our own lines rather than being sent at a
    # control that may have no key handler at all, and Enter meaning "this
    # one".
    # ------------------------------------------------------------------

    # The first and last screen line the open dropdown occupies.
    def self.chooser_lines(state : Reader::State) : NamedTuple(first: Int32, last: Int32)?
      chooser = state.core.chooser
      return nil unless chooser
      object = chooser.as_h
      return nil unless (object["count"]?.try(&.as_i64?) || 0) > 0
      at = (object["at"]?.try(&.as_i64?) || 0).to_i32
      count = (object["count"]?.try(&.as_i64?) || 0).to_i32
      first = -1
      last = -1
      state.lines.each_with_index do |line, index|
        next if line.block_index < at || line.block_index >= at + count
        first = index if first < 0
        last = index
      end
      return nil if first < 0
      {first: first, last: last}
    end

    def self.open_chooser(output : Screen::Output, state : Reader::State,
                          page : Reader::PageEnv, item : JSON::Any, listing : JSON::Any) : Nil
      line = Reader.current_line(state)
      # A control in a table row shares its line with other cells, and the
      # chooser's entries are spliced into the block list after the control.
      # Put them after the whole row so they do not land between the row's
      # cells.
      at = if line && line.spans && !line.spans.not_nil!.empty?
             line.not_nil!.spans.not_nil!.last.block_index
           elsif line
             line.block_index
           else
             0
           end
      state.core.open_chooser(at, listing)
      # Hold off live rebuilds while the list is open: a refresh would
      # replace the block list and take the entries with it, mid-choice.
      if live_object = state.core.live
        if hash = live_object.as_h?
          hash["refreshing"] = JSON::Any.new(true)
        end
      end
      state.mode = "choose"
      state.chooser = JSON::Any.new({
        "item" => item,
        "from" => JSON::Any.new((line ? line.block_index : 0).to_i64),
      })

      Reader.relayout(state)
      range = chooser_lines(state)
      options = listing.as_h["options"]?.try(&.as_a?) || [] of JSON::Any
      chosen = options.index { |option| option.as_h?.try(&.["selected"]?).try(&.as_bool?) }
      shown = state.core.chooser.try(&.as_h).try(&.["shown"]?).try(&.as_a?) || [] of JSON::Any
      offset = if chosen
                 shown.index(JSON::Any.new(chosen.not_nil!.to_i64)) || 0
               else
                 0
               end
      state.cursor = range ? Math.min(range[:first] + Math.max(offset, 0), range[:last]) : state.cursor
      Reader.clamp_scroll(state)
      Reader.render(output, state, page.url, force: true)
      count = options.size
      Reader.set_status(output, state, page.url,
        "#{count} choice#{count == 1 ? "" : "s"} for \"#{item.as_h["name"]?.try(&.as_s?)}\" — " +
        "type to filter, Enter to choose, Esc to cancel.")
    end

    def self.close_chooser(output : Screen::Output, state : Reader::State,
                           page : Reader::PageEnv, note : String?) : Nil
      from = (state.chooser.try(&.as_h).try(&.["from"]?).try(&.as_i64?) || 0).to_i32
      state.core.close_chooser
      if live_object = state.core.live
        if hash = live_object.as_h?
          hash["refreshing"] = JSON::Any.new(false)
        end
      end
      state.mode = "browse"
      state.chooser = nil
      Reader.relayout(state)
      line = Reader.line_for_block(state, from)
      state.cursor = line if line >= 0
      Reader.clamp_col(state)
      Reader.clamp_scroll(state)
      Reader.render(output, state, page.url, force: true)
      Reader.set_status(output, state, page.url, note) if note
    end

    def self.handle_choose_key(output : Screen::Output, state : Reader::State,
                               page : Reader::PageEnv, chunk : String) : Nil
      state.core.mark_input
      chooser = state.core.chooser
      unless chooser
        state.mode = "browse"
        return
      end
      action = context_action(chunk, state)

      if key_is(chunk, "Escape", state) || action == "cancel"
        close_chooser(output, state, page,
          "Left \"#{chooser_control_name(state)}\" as it was.")
        return
      end

      if chunk == "\r" || chunk == "\n" || action == "accept"
        line = Reader.current_line(state)
        block_item = line.try do |entry|
          state.core.blocks[entry.block_index]?.try(&.as_h).try(&.["item"]?)
        end
        index = block_item.try(&.as_h).try(&.["chooserIndex"]?)
        if block_item.nil? || index.nil?
          Reader.set_status(output, state, page.url, "Move to a choice first.")
          return
        end
        chosen_item = block_item.not_nil!.as_h
        if chosen_item["disabled"]?.try(&.as_bool?)
          Reader.set_status(output, state, page.url,
            "\"#{chosen_item["name"]?.try(&.as_s?)}\" is not available.")
          return
        end
        control = state.chooser.try(&.as_h).try(&.["item"]?).not_nil!
        chosen = chosen_item["name"]?.try(&.as_s?) || ""
        begin
          outcome = state.core.choose_option(control, (index.not_nil!.as_i64? || 0).to_i32)
        rescue err
          reason = (err.message || err.to_s).lines.first? || err.to_s
          close_chooser(output, state, page,
            "Could not choose \"#{chosen}\": #{reason}")
          return
        end
        close_chooser(output, state, page, nil)
        # The page may have reacted to the choice — a region list reloading
        # is the ordinary case — so read it again before saying anything.
        Reader.refresh(state, page, false, state.core.anchor)
        Reader.render(output, state, page.url, force: true)
        changed = outcome.as_h["changed"]?.try(&.as_bool?) || false
        Reader.set_status(output, state, page.url,
          changed ? "Chose \"#{chosen}\"." : "\"#{chosen}\" was already chosen.")
        return
      end

      range = chooser_lines(state)
      if key_is(chunk, "ArrowDown", state) || action == "next"
        Reader.move_selection(output, state, page.url, Math.min(state.cursor + 1, range[:last]), 0) if range
        return
      end
      if key_is(chunk, "ArrowUp", state) || action == "previous"
        Reader.move_selection(output, state, page.url, Math.max(state.cursor - 1, range[:first]), 0) if range
        return
      end
      if key_is(chunk, "PageDown", state) || action == "page-next"
        if range
          Reader.move_selection(output, state, page.url,
            Math.min(state.cursor + Reader.viewport_height(state), range[:last]), 0)
        end
        return
      end
      if key_is(chunk, "PageUp", state) || action == "page-previous"
        if range
          Reader.move_selection(output, state, page.url,
            Math.max(state.cursor - Reader.viewport_height(state), range[:first]), 0)
        end
        return
      end
      if action == "first" && range
        Reader.move_selection(output, state, page.url, range[:first], 0)
        return
      end
      if action == "last" && range
        Reader.move_selection(output, state, page.url, range[:last], 0)
        return
      end

      filter = chooser.as_h["filter"]?.try(&.as_s?) || ""
      if key_is(chunk, "Backspace", state)
        refilter(output, state, page, filter.size > 0 ? filter[0, filter.size - 1] : "")
        return
      end
      return if chunk.starts_with?(ESC) # an escape sequence we do not use here
      refilter(output, state, page, filter + chunk) if chunk >= " "
    end

    def self.refilter(output : Screen::Output, state : Reader::State,
                      page : Reader::PageEnv, filter : String) : Nil
      shown = state.core.show_chooser(filter)
      Reader.relayout(state)
      range = chooser_lines(state)
      state.cursor = range[:first] if range
      Reader.clamp_col(state)
      Reader.clamp_scroll(state)
      Reader.render(output, state, page.url, force: true)
      if !filter.empty?
        total = state.core.chooser.try(&.as_h).try(&.["options"]?).try(&.as_a?).try(&.size) || 0
        Reader.set_status(output, state, page.url, "#{shown} of #{total} matching \"#{filter}\".")
      else
        Reader.set_status(output, state, page.url, "#{shown} choice#{shown == 1 ? "" : "s"}.")
      end
    end

    # ------------------------------------------------------------------
    # Naming a file for a file input
    #
    # A file input is pressed by naming a file: the reader types a path, the
    # browser is given exactly that file, and nothing asks the desktop for
    # anything. Tab completes the path as far as it can without guessing;
    # Enter attaches; Esc cancels. Like the password prompt, this takes the
    # keyboard for itself, because whatever asked for the file is waiting on
    # the answer.
    # ------------------------------------------------------------------

    # `~` is the reader's own shorthand and the shell would have expanded
    # it. Anything relative is relative to where tawb was started.
    private def self.expand_path(text : String) : String
      trimmed = text.strip
      return "" if trimmed.empty?
      home = Path.home.to_s
      return home if trimmed == "~"
      return File.expand_path(trimmed[2..], home) if trimmed.starts_with?("~/")
      File.expand_path(trimmed)
    end

    # What the reader has typed so far, completed as far as it can go
    # without guessing. A directory completes with its separator, so the
    # next Tab carries on inside it.
    def self.complete_path(text : String) : NamedTuple(text: String, note: String?)
      typed = text
      expanded = expand_path(typed.empty? ? "." : typed)
      ends_in_separator = typed.ends_with?("/")
      dir = ends_in_separator ? expanded : File.dirname(expanded)
      prefix = ends_in_separator ? "" : File.basename(expanded)

      entries = begin
        Dir.open(dir).children
      rescue
        return {text: typed, note: "#{dir} is not a directory anybody can read."}
      end
      # The completion listing is said in one order regardless of what the
      # filesystem hands back; the JavaScript original's directory read sorts
      # its entries, so the same names come out the same way here.
      matching = entries.sort.select(&.starts_with?(prefix)).map do |entry|
        File.directory?(File.join(dir, entry)) ? entry + "/" : entry
      end
      if matching.empty?
        return {text: typed, note: "Nothing in #{dir} starts with \"#{prefix}\"."}
      end

      # The longest prefix they all share, which is as far as completing can
      # go without choosing for the reader.
      common = matching.first
      matching[1..].each do |entry|
        at = 0
        while at < common.size && at < entry.size && common[at] == entry[at]
          at += 1
        end
        common = common[0, at]
      end
      base = typed[0, typed.size - prefix.size]
      completed = base + common
      if matching.size == 1
        return {text: completed, note: nil}
      end
      listing = matching[0, Math.min(6, matching.size)].join("  ")
      {
        text: completed,
        note: "#{matching.size} match: #{listing}#{matching.size > 6 ? " …" : ""}",
      }
    end

    # A path the browser can actually be given, or why not.
    def self.file_to_attach(text : String) : JSON::Any
      full = expand_path(text)
      if full.empty?
        return JSON::Any.new({"error" => JSON::Any.new("no file named")})
      end
      info = File.info?(full)
      unless info
        return JSON::Any.new({"error" => JSON::Any.new("there is no #{full}")})
      end
      if info.directory?
        return JSON::Any.new({"error" => JSON::Any.new("#{full} is a directory")})
      end
      unless File::Info.readable?(full)
        return JSON::Any.new({"error" => JSON::Any.new("#{full} cannot be read")})
      end
      JSON::Any.new({
        "path" => JSON::Any.new(full),
        "size" => JSON::Any.new(info.size.to_i64),
        "name" => JSON::Any.new(File.basename(full)),
      })
    end

    # Said the way a person would say it: one file by name and size, several
    # by name.
    def self.file_size(bytes : Int64) : String
      if bytes >= 1 << 20
        sprintf("%.1fMB", bytes / 1048576.0)
      elsif bytes >= 1 << 10
        sprintf("%.1fKB", bytes / 1024.0)
      else
        "#{bytes} bytes"
      end
    end

    def self.file_prompt_text(state : Reader::State) : NamedTuple(text: String, caret_col: Int32)
      files = state.files.not_nil!.as_h
      label = files["label"]?.try(&.as_s?) || "File"
      buffer = files["buffer"]?.try(&.as_h) || {} of String => JSON::Any
      text = buffer["text"]?.try(&.as_s?) || ""
      caret = (buffer["caret"]?.try(&.as_i64?) || 0).to_i32
      {text: "#{label}: #{text}", caret_col: label.size + 2 + caret + 1}
    end

    def self.draw_file_prompt(output : Screen::Output, state : Reader::State) : Nil
      prompt = file_prompt_text(state)
      Reader.write_status_row(output, state, prompt[:text])
      Screen.move_cursor(output, Reader.status_row(state), Math.min(prompt[:caret_col], state.cols))
    end

    # Asks for a path, and does not return until there is one or the reader
    # has said no. Enter on an empty line finishes a list of files, or
    # cancels when there is nothing in it yet.
    def self.ask_for_file_paths(output : Screen::Output, state : Reader::State,
                                page_url : String, keyboard : Keyboard?, asking : String,
                                multiple : Bool, accept : String) : JSON::Any?
      return nil unless keyboard
      previous_mode = state.mode
      previous_status = state.status_msg
      chosen = [] of JSON::Any
      state.mode = "files"
      state.files = JSON::Any.new({
        "asking"  => JSON::Any.new(asking),
        "multiple" => JSON::Any.new(multiple),
        "accept"  => JSON::Any.new(accept),
        "chosen"  => JSON::Any.new([] of JSON::Any),
        "label"   => JSON::Any.new("File"),
        "buffer"  => JSON::Any.new({"text" => JSON::Any.new(""), "caret" => JSON::Any.new(0_i64)}),
      })
      files_object = state.files.not_nil!.as_h

      token = keyboard.claim
      Reader.draw_hint(output, state, force: true)
      who = asking.empty? ? "This page" : asking
      question = if accept.empty?
                   "#{who} asks for a file. Tab completes, Esc cancels."
                 else
                   "#{who} asks for a file (#{accept}). Tab completes, Esc cancels."
                 end
      Reader.set_status(output, state, page_url, question)
      draw_file_prompt(output, state)

      answer = nil
      begin
        loop do
          chunk = keyboard.next_key(token)
          # No keyboard, no answer. The chooser is left unanswered, which is
          # a chooser cancelled — nothing is open anywhere to be left behind.
          if chunk.is_a?(Input::Eof)
            answer = chosen.empty? ? nil : JSON::Any.new(chosen)
            break
          end
          chunk = chunk.as(String)
          state.core.mark_input
          buffer = Edit::Buffer.new(
            files_object["buffer"].as_h["text"]?.try(&.as_s?) || "",
            (files_object["buffer"].as_h["caret"]?.try(&.as_i64?) || 0).to_i32)

          if key_is(chunk, "Escape", state)
            answer = chosen.empty? ? nil : JSON::Any.new(chosen)
            break
          end

          if chunk == "\t"
            completion = complete_path(buffer.text)
            buffer.text = completion[:text]
            buffer.caret = completion[:text].size
            if note = completion[:note]
              Reader.set_status(output, state, page_url, note)
            end
            write_buffer(files_object, buffer)
            draw_file_prompt(output, state)
            next
          end

          if chunk == "\r" || chunk == "\n"
            if buffer.text.strip.empty?
              answer = chosen.empty? ? nil : JSON::Any.new(chosen)
              break
            end
            file = file_to_attach(buffer.text)
            if error = file.as_h["error"]?
              Reader.set_status(output, state, page_url,
                "Not attached: #{error.as_s?}.")
              write_buffer(files_object, buffer)
              draw_file_prompt(output, state)
              next
            end
            chosen << file
            files_object["chosen"].as_a << file
            unless multiple
              answer = JSON::Any.new(chosen)
              break
            end
            buffer.text = ""
            buffer.caret = 0
            Reader.set_status(output, state, page_url,
              "#{chosen.size} file#{chosen.size == 1 ? "" : "s"} so far" +
              " — another path, or Enter on an empty line to finish.")
            write_buffer(files_object, buffer)
            draw_file_prompt(output, state)
            next
          end

          editing = Edit.edit_action(chunk, keymap_for(state))
          if editing
            Edit.apply_buffer_edit(buffer, editing)
          elsif key_is(chunk, "Ctrl+L", state)
            buffer.text = ""
            buffer.caret = 0
          elsif !chunk.starts_with?(ESC) && chunk >= " "
            buffer.text = buffer.text[0, buffer.caret] + chunk + buffer.text[buffer.caret..]
            buffer.caret += chunk.size
          end
          write_buffer(files_object, buffer)
          draw_file_prompt(output, state)
        end
      ensure
        keyboard.release(token)
        state.mode = previous_mode
        state.files = nil
        state.status_msg = previous_status
        Reader.draw_hint(output, state, force: true)
      end
      answer
    end

    private def self.write_buffer(files_object : Hash(String, JSON::Any), buffer : Edit::Buffer) : Nil
      files_object["buffer"].as_h["text"] = JSON::Any.new(buffer.text)
      files_object["buffer"].as_h["caret"] = JSON::Any.new(buffer.caret.to_i64)
    end

    # ------------------------------------------------------------------
    # Lynx's number prompt
    #
    # A count, an optional command, and an optional sign, in either order:
    # `12` follows link 12, `3p` goes to page 3, `2+p` two pages on, `4-g`
    # four links back without pressing. The arithmetic lives in LynxNumber;
    # what is here is the prompt itself and where each answer lands.
    # ------------------------------------------------------------------

    # The line a number was seen on, and the block it named. A composite
    # paragraph or table row can hold several numbers, so they come from its
    # spans rather than from the line.
    def self.open_link_number_prompt(output : Screen::Output, state : Reader::State,
                                     page_url : String, digits : String? = nil) : Nil
      targets = [] of JSON::Any
      entries = [] of JSON::Any
      remember = ->(number : JSON::Any?, block_index : Int32, line : Int32, col : Int32) do
        # What the JavaScript original skips: no number at all, a zero, an
        # empty marker, or a block the buffer does not hold.
        present = number && !number.raw.is_a?(Nil) && number.as_i64? != 0_i64 &&
                  number.as_s? != ""
        named = present && state.core.blocks[block_index]?
        taken = named && entries.any? { |entry| entry.as_h["number"] == number }
        unless taken
          entries << JSON::Any.new({
            "number"     => number || JSON::Any.new(nil),
            "blockIndex" => JSON::Any.new(block_index.to_i64),
          })
          targets << JSON::Any.new({
            "number" => number || JSON::Any.new(nil),
            "line"   => JSON::Any.new(line.to_i64),
            "col"    => JSON::Any.new(col.to_i64),
          })
        end
        block_index
      end
      state.lines.each_with_index do |line, line_index|
        if spans = line.spans
          spans.each do |span|
            remember.call(span.display_number, span.block_index, line_index, span.start)
          end
          next
        end
        next unless line.display_number
        remember.call(line.display_number, line.block_index, line_index, 0)
      end
      state.mode = "number"
      state.link_number = JSON::Any.new({
        "text"    => JSON::Any.new(digits == "0" ? "" : (digits || "")),
        "targets" => JSON::Any.new(targets),
        "entries" => JSON::Any.new(entries),
        "cursor"  => JSON::Any.new(state.cursor.to_i64),
        "col"     => JSON::Any.new(state.col.to_i64),
      })
      Reader.draw_hint(output, state)
      draw_link_number_prompt(output, state)
    end

    def self.draw_link_number_prompt(output : Screen::Output, state : Reader::State) : Nil
      prompt = state.link_number.not_nil!.as_h
      text = "Follow link (or goto link or page) number: #{prompt["text"]?.try(&.as_s?)}"
      Reader.write_status_row(output, state, text)
      Screen.move_cursor(output, Reader.status_row(state), Math.min(text.size + 1, state.cols))
    end

    def self.handle_number_key(output : Screen::Output, state : Reader::State,
                               page : Reader::PageEnv, keyboard : Keyboard?,
                               chunk : String) : Nil
      state.core.mark_input
      prompt = state.link_number
      unless prompt
        state.mode = "browse"
        return
      end
      prompt_object = prompt.as_h
      text = prompt_object["text"]?.try(&.as_s?) || ""

      if key_is(chunk, "Escape", state) || key_is(chunk, "Ctrl+C", state)
        state.mode = "browse"
        state.link_number = nil
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "Cancelled.")
        return
      end
      if key_is(chunk, "Backspace", state)
        prompt_object["text"] = JSON::Any.new(text.size > 0 ? text[0, text.size - 1] : "")
        draw_link_number_prompt(output, state)
        return
      end
      if chunk.matches?(/^\d+$/) || chunk.matches?(/^[pP+-]$/)
        prompt_object["text"] = JSON::Any.new(text + chunk)
        draw_link_number_prompt(output, state)
        return
      end
      typed_go = chunk == "g" || chunk == "G"
      return unless typed_go || chunk == "\r" || chunk == "\n"

      expression = LynxNumber.parse(text + (typed_go ? chunk : ""))
      state.mode = "browse"
      state.link_number = nil
      Reader.draw_hint(output, state)
      unless expression
        Reader.set_status(output, state, page.url,
          "Invalid link number: #{text.empty? ? "0" : text}.")
        return
      end
      answer = expression.not_nil!
      number = answer["number"].as_i64
      command = answer["command"].as_s
      relative = answer["relative"].as_i64

      if command == "page"
        height = Math.max(1, Reader.viewport_height(state))
        page_count = Math.max(1, (state.lines.size + height - 1) // height)
        current_page = (prompt_object["cursor"].as_i64 // height) + 1
        requested = relative == 0 ? number : current_page + (relative * number)
        page_number = Math.max(1, Math.min(requested == 0 ? 1 : requested, page_count)).to_i32
        Reader.move_selection(output, state, page.url,
          Math.min((page_number - 1) * height, state.lines.size - 1), 0)
        Reader.set_status(output, state, page.url, "Page #{page_number} of #{page_count}.")
        return
      end

      followed = relative == 0 ? number : LynxNumber.relative(prompt, number, relative)
      found = prompt_object["entries"].as_a.find do |one|
        one.as_h["number"] == JSON::Any.new(followed)
      end
      block_index = found ? found.as_h["blockIndex"].as_i64.to_i32 : -1
      position = block_index < 0 ? nil : Reader.position_for_block(state, block_index)
      unless position
        Reader.set_status(output, state, page.url,
          "No link #{followed} on this page.")
        return
      end
      Reader.move_selection(output, state, page.url, position[:line], position[:col])
      item = state.core.blocks[block_index]?.try(&.as_h).try(&.["item"]?)
      if command == "move" || item.nil? ||
         !Aria::LINK_ROLES.includes?(item.as_h["role"]?.try(&.as_s?) || "")
        Reader.set_status(output, state, page.url, "Link #{followed}.")
        return
      end
      activate_current(output, state, page, keyboard)
    end


    # ------------------------------------------------------------------
    # The modes that fill a form in
    #
    # Typing, adjusting a slider, Lynx's one-command escape, and forms mode
    # itself are four small state machines around the same actors: the
    # field being typed into, the control being adjusted, the quick-nav
    # walk that lands on the next control, and the activation that submits
    # or presses. They live here rather than in the loop so the loop only
    # picks the handler for the mode it is in.
    # ------------------------------------------------------------------

    # The Lynx decisions the mode handlers read. The host is the loop's:
    # the pieces it needs now are the reader's own key test, the status row
    # and the field entry; the screens it will open — help, options, the
    # trace log — arrive with the loop and the library work.
    private class ModeHost
      include LynxActions::Host

      def initialize(@output : Screen::Output, @page_url : String)
      end

      def fallback_keymap : Keys::Keymap
        FALLBACK_KEYMAP
      end

      def key_is(chunk : String, name : String, state : LynxActions::State) : Bool
        (state.keys || FALLBACK_KEYMAP).is_key(chunk, name)
      end

      def set_status(state : LynxActions::State, message : String) : Nil
        reader = state.reader
        Reader.set_status(@output, reader, @page_url, message) if reader
      end

      def current_item(state : LynxActions::State) : LynxActions::Item?
        reader = state.reader
        return nil unless reader
        item = Reader.current_block(reader).try(&.as_h).try(&.["item"]?)
        role = item.try(&.as_h).try(&.["role"]?).try(&.as_s?)
        role ? LynxActions::Item.new(role, item) : nil
      end

      def is_field(role : String) : Bool
        Aria::FIELD_ROLES.includes?(role)
      end

      def begin_typing(state : LynxActions::State, page : Reader::PageEnv?, item : LynxActions::Item) : Bool
        reader = state.reader
        return false unless reader && page && (json = item.json)
        ReaderKeys.begin_typing(@output, reader, page, json)
      end

      def open_link_number_prompt(state : LynxActions::State, digits : String?) : Nil
        reader = state.reader
        return unless reader
        ReaderKeys.open_link_number_prompt(@output, reader, @page_url, digits)
      end

      def open_help(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def describe_current(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_main_menu(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_options(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def open_trace_log(state : LynxActions::State, page : Reader::PageEnv?) : Nil
      end

      def toggle_trace(state : LynxActions::State) : Nil
      end
    end

    private def self.mode_actions(output : Screen::Output, page_url : String) : LynxActions
      LynxActions.new(ModeHost.new(output, page_url))
    end

    def self.handle_type_key(output : Screen::Output, state : Reader::State,
                             page : Reader::PageEnv, chunk : String) : Nil
      state.core.mark_input
      typing = state.typing
      unless typing
        state.mode = "browse"
        return
      end
      old_caret_col = Reader.typing_text(state)[:caret_col]
      output_generation = output.generation

      if key_is(chunk, "Escape", state)
        # Captured while the field is still drawn as it is on screen, so
        # the one row that changes — the field, back to its ordinary
        # form — is the one row repainted.
        screen = Reader.screen_before(state)
        anchor = state.core.anchor
        state.mode = "browse"
        state.typing = nil
        Reader.refresh(state, page, false, anchor)
        Reader.repaint_list(output, state, page.url, screen)
        field_name = typing.item.as_h["name"]?.try(&.as_s?) || ""
        Reader.set_status(output, state, page.url,
          "Stopped typing into \"#{field_name}\".")
        return
      end

      lynx_arrow = mode_actions(output, page.url).tab_arrow?(lynx_view(state), chunk)
      if key_is(chunk, "Tab", state) || key_is(chunk, "Shift+Tab", state) || lynx_arrow
        direction = key_is(chunk, "Shift+Tab", state) || key_is(chunk, "ArrowUp", state) ? -1 : 1
        screen = Reader.screen_before(state)
        anchor = state.core.anchor
        state.mode = "browse"
        state.typing = nil
        state.core.release_typing_field
        Reader.refresh(state, page, false, anchor)
        Reader.repaint_list(output, state, page.url, screen)

        action = direction > 0 ? "next-focusable" : "previous-focusable"
        found = QuickNav.find(state, action)
        unless found
          Reader.set_status(output, state, page.url,
            "No #{direction > 0 ? "next" : "previous"} control.")
          return
        end
        Reader.move_selection(output, state, page.url, found[:line], found[:col])
        block = Reader.current_block(state)
        item = block.try(&.as_h).try(&.["item"]?)
        name = item.try(&.as_h).try(&.["name"]?).try(&.as_s?) ||
               QuickNav.specification(action).try(&.label) || ""
        # Tab between editable fields stays in typing mode. Buttons, links
        # and select-only widgets stay in forms mode: they are not activated
        # merely by receiving focus, but Tab can continue through the form
        # from them.
        needs_activation = mode_actions(output, page.url).tab_needs_activation?(lynx_view(state))
        if !needs_activation && item &&
           Aria::FIELD_ROLES.includes?(item.as_h["role"]?.try(&.as_s?) || "") &&
           begin_typing(output, state, page, item.not_nil!)
          Reader.set_status(output, state, page.url,
            mode_actions(output, page.url).tab_typing_status(lynx_view(state), name))
          return
        end
        state.mode = mode_actions(output, page.url).tab_landed_mode(lynx_view(state))
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url,
          "#{direction > 0 ? "Next" : "Previous"} control: #{name}.")
        return
      end

      if chunk == "\r" || chunk == "\n"
        previous_url = page.url
        # The page-history place the JavaScript original remembers here is
        # ported with the history traversal helpers.
        screen = Reader.screen_before(state)
        anchor = state.core.anchor
        page.keyboard_press("Enter")
        page.wait_for_load
        state.mode = "browse"
        state.typing = nil

        # A submit that navigated is a new page and there is nothing to
        # keep. One that submitted in place is the same page with a
        # different list on it, and the reader is still standing in the form
        # they just filled in — resetting the cursor there threw them to the
        # top of the document for no reason they could see.
        navigated = page.url != previous_url
        if navigated
          Reader.refresh(state, page, true)
        else
          Reader.refresh(state, page, false, anchor)
        end
        if navigated
          Reader.render(output, state, page.url)
        else
          Reader.repaint_list(output, state, page.url, screen)
        end
        field_name = typing.item.as_h["name"]?.try(&.as_s?) || ""
        Reader.set_status(output, state, page.url, navigated ?
          "Submitted \"#{field_name}\" — loaded #{page.url}" :
          "Submitted \"#{field_name}\".")
        return
      end

      if mode_actions(output, page.url).type_command?(lynx_view(state), chunk)
        state.mode = "field-command"
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "Command:")
        return
      end

      editing = Edit.edit_action(chunk, keymap_for(state))
      if editing
        Edit.send_field_edit(->(key : String) { page.keyboard_press(key) }, editing)
      elsif chunk.starts_with?(ESC) || chunk < " "
        return
      else
        page.keyboard_press(chunk)
        typing.caret += chunk.size
      end

      info = state.core.read_typing_field
      return unless info
      info_object = info.as_h
      typing.text = info_object["text"]?.try(&.as_s?) || ""
      if info_object["native"]?.try(&.as_bool?)
        typing.caret = (info_object["caret"]?.try(&.as_i64?) || 0).to_i32
      else
        typing.caret = Math.min(Math.max(typing.caret, 0), typing.text.size)
      end
      shown = Reader.typing_text(state)
      row = Reader.line_row(state, state.cursor)
      Screen.patch_edited_line(output, row, typing.drawn, shown[:text],
        # Browser editing is asynchronous. Use the relative update when no
        # concurrent refresh touched the terminal, and an absolute start
        # when one did; either way the complete edit is one write.
        current_col: output.generation == output_generation ? old_caret_col : nil,
        final_col: shown[:caret_col])
      typing.drawn = shown[:text]
    end

    def self.handle_field_command_key(output : Screen::Output, state : Reader::State,
                                      page : Reader::PageEnv, chunk : String) : Nil
      state.core.mark_input
      typing = state.typing
      unless typing
        state.mode = "browse"
        return
      end
      if key_is(chunk, "Escape", state)
        state.mode = "type"
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "Command cancelled.")
        return
      end
      action = keymap_for(state).action_for(chunk)
      unless action
        state.mode = "type"
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "That is not a Lynx browse command.")
        return
      end

      # Complete the field before running the command, just as Lynx hands
      # the escaped key from its line editor back to the main keymap.
      # Refreshing first keeps the ordinary reading line synchronized with
      # the browser value. The command itself is one of the browse map's —
      # it is dispatched there when the loop and its browse dispatch exist;
      # until then the escaped key completes the field and stops.
      screen = Reader.screen_before(state)
      anchor = state.core.anchor
      state.mode = "browse"
      state.typing = nil
      state.core.release_typing_field
      Reader.refresh(state, page, false, anchor)
      Reader.repaint_list(output, state, page.url, screen)
      Reader.draw_hint(output, state)
    end

    def self.handle_forms_key(output : Screen::Output, state : Reader::State,
                              page : Reader::PageEnv, keyboard : Keyboard?,
                              chunk : String) : Nil
      state.core.mark_input
      action = context_action(chunk, state)
      if key_is(chunk, "Escape", state) || action == "cancel"
        state.mode = "browse"
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "Left forms mode.")
        return
      end
      if chunk == "\r" || chunk == "\n" || action == "accept"
        activate_current(output, state, page, keyboard)
        return
      end
      previous = key_is(chunk, "Shift+Tab", state) || action == "previous"
      next_key = key_is(chunk, "Tab", state) || action == "next"
      return unless previous || next_key

      direction = previous ? -1 : 1
      screen = Reader.screen_before(state)
      anchor = state.core.anchor
      Reader.refresh(state, page, false, anchor)
      Reader.repaint_list(output, state, page.url, screen)
      found = QuickNav.find(state, direction > 0 ? "next-focusable" : "previous-focusable")
      unless found
        Reader.set_status(output, state, page.url,
          "No #{direction > 0 ? "next" : "previous"} control.")
        return
      end
      Reader.move_selection(output, state, page.url, found[:line], found[:col])
      block = Reader.current_block(state)
      item = block.try(&.as_h).try(&.["item"]?)
      name = item.try(&.as_h).try(&.["name"]?).try(&.as_s?) ||
             QuickNav.specification(direction > 0 ? "next-focusable" : "previous-focusable").try(&.label) || ""
      if item && Aria::FIELD_ROLES.includes?(item.as_h["role"]?.try(&.as_s?) || "") &&
         begin_typing(output, state, page, item.not_nil!)
        Reader.set_status(output, state, page.url,
          "Typing into \"#{name}\" — Tab: next control, Esc: stop, Enter: submit.")
        return
      end
      state.mode = "forms"
      Reader.set_status(output, state, page.url,
        "#{direction > 0 ? "Next" : "Previous"} control: #{name}.")
    end

    def self.handle_control_key(output : Screen::Output, state : Reader::State,
                                page : Reader::PageEnv, chunk : String) : Nil
      state.core.mark_input
      controlling = state.controlling
      unless controlling
        state.mode = "browse"
        return
      end
      name = controlling.as_h["item"]?.try(&.as_h).try(&.["name"]?).try(&.as_s?) || ""

      if key_is(chunk, "Escape", state) || chunk == "\r" || chunk == "\n"
        state.mode = "browse"
        state.controlling = nil
        Reader.draw_hint(output, state)
        Reader.set_status(output, state, page.url, "Stopped controlling \"#{name}\".")
        return
      end

      keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]
      key = keys.find { |candidate| key_is(chunk, candidate, state) }
      return unless key

      begin
        adjusted = state.core.adjust_control(controlling.as_h["item"].not_nil!, key)
      rescue err
        reason = (err.message || err.to_s).lines.first? || err.to_s
        Reader.set_status(output, state, page.url,
          "Could not adjust \"#{name}\": #{reason}")
        return
      end
      screen = Reader.screen_before(state)
      Reader.refresh(state, page, false, state.core.anchor)
      Reader.repaint_list(output, state, page.url, screen)
      changed = adjusted.as_h["changed"]?.try(&.as_bool?) || false
      fallback = adjusted.as_h["fallback"]?.try(&.as_bool?) || false
      if !changed
        Reader.set_status(output, state, page.url,
          "The page ignored #{key} on \"#{name}\".")
      elsif fallback
        Reader.set_status(output, state, page.url,
          "Adjusted \"#{name}\" with its visual slider because it ignored #{key}.")
      else
        Reader.set_status(output, state, page.url,
          "Adjusted \"#{name}\" with #{key}.")
      end
    end

    # ------------------------------------------------------------------
    # Going somewhere
    #
    # The address bar takes an address when it is given one and searches
    # when it is not. The navigation itself must not own the keyboard for
    # an entire protocol timeout, so it runs while the reader keeps
    # typing, and Escape asks the engine to stop without waiting for that
    # request or the original command to answer.
    # ------------------------------------------------------------------

    # Go somewhere, and say what happened rather than throwing. The caller
    # reads the tab either way, because either way there is something in it.
    private def self.navigate(page : Reader::PageEnv, url : String) : NavigateOutcome
      page.goto(url)
      {ok: true, fault: nil, cancelled: false}
    rescue err
      {ok: false, fault: navigation_fault(err.message || err.to_s), cancelled: false}
    end

    # What to say a refusal was, which is the engine's business as much as
    # ours: Chromium's net::ERR_ codes, Firefox's NS_ERROR_ ones, and the
    # certificate codes buried inside a generic failure are the parts worth
    # repeating to a reader.
    private def self.navigation_fault(message : String?) : String
      text = (message || "").lines.first? || ""
      codes = text.scan(/\b(?:net::)?((?:ERR|NS_ERROR|MOZILLA_PKIX_ERROR|SEC_ERROR)_[A-Z0-9_]+)\b/)
        .map(&.[1])
      # Firefox wraps the diagnosis in a generic failure and a module name,
      # so the code that actually says what is wrong with the certificate
      # is preferred over whatever came first.
      specific = codes.find { |code| code.matches?(/^(ERR_CERT|MOZILLA_PKIX_ERROR|SEC_ERROR)/) }
      return specific.not_nil! if specific
      return codes.first.not_nil! unless codes.empty?
      text.gsub(/^page\.goto:\s*/, "").gsub(/^unknown error:\s*(Error:\s*)?/, "")[0, 120]
    end

    private def self.navigate_interruptibly(output : Screen::Output, state : Reader::State,
                                            page : Reader::PageEnv, keyboard : Keyboard?,
                                            url : String) : NavigateOutcome
      pending = Channel(NavigateOutcome).new
      spawn { pending.send(navigate(page, url)) }
      unless keyboard
        value = pending.receive
        return {ok: value[:ok], fault: value[:fault], cancelled: false}
      end

      token = keyboard.claim
      loop do
        answer = keyboard.next_or(pending, token)
        if answer.is_a?(Input::OperationResult(NavigateOutcome))
          keyboard.release(token)
          value = answer.value
          return {ok: value[:ok], fault: value[:fault], cancelled: false}
        end
        key = answer.key
        if key.is_a?(Input::Eof)
          begin
            page.stop_loading
          rescue
            # already gone
          end
          keyboard.release(token)
          return {ok: false, fault: nil, cancelled: true}
        end
        state.core.mark_input
        chunk = key.as(String)
        action = keymap_for(state).action_for(chunk)
        next unless key_is(chunk, "Escape", state) || action == "interrupt"
        begin
          page.stop_loading
        rescue
          # already gone
        end
        keyboard.release(token)
        return {ok: false, fault: nil, cancelled: true}
      end
    end

    # The error page arrives a moment after the navigation that failed: the
    # throw comes from the network layer, and the page that replaces the
    # document is rendered after it. So the buffer is read again until it
    # holds something, bounded, and the bound is not an error in itself.
    private def self.settle_after_fault(output : Screen::Output, state : Reader::State,
                                        page : Reader::PageEnv) : Bool
      deadline = Time.monotonic + 4.seconds
      loop do
        Reader.refresh(state, page, true)
        return true unless state.lines.empty?
        return false if Time.monotonic >= deadline
        sleep 150.milliseconds
      end
    end

    # Going somewhere, from wherever the address came from — the address
    # bar, or a line in one of the browser's own lists.
    def self.load_address(output : Screen::Output, state : Reader::State,
                          page : Reader::PageEnv, keyboard : Keyboard?, url : String) : NavigateOutcome
      # The page-history place the JavaScript original remembers here is
      # ported with the history traversal helpers.
      Reader.set_status(output, state, page.url, "Loading #{url} — Esc: stop.")
      state.credentials.try(&.reconsider)
      went = navigate_interruptibly(output, state, page, keyboard, url)
      if went[:cancelled]
        Reader.render(output, state, page.url, force: true)
        Reader.set_status(output, state, page.url, "Stopped loading #{url}.")
        return went
      end
      # Read the tab whether or not the navigation succeeded: a refusal
      # leaves the browser's own warning page in it, and that page is where
      # the reader finds out why and how to go on anyway.
      if went[:ok]
        Reader.refresh(state, page, true)
      else
        settle_after_fault(output, state, page)
      end
      Reader.render(output, state, page.url, force: true)
      Reader.set_status(output, state, page.url, went[:ok] ?
        "Loaded #{page.url}" :
        "#{url} was refused — #{went[:fault]}. The browser's own warning is on screen.")
      went
    end

    def self.focus_address_bar(output : Screen::Output, state : Reader::State,
                               page : Reader::PageEnv, text : String? = nil) : Nil
      address = text || page.url
      state.mode = "address"
      state.address = Reader::AddressBar.new(address, address.size, 0)
      Reader.draw_hint(output, state)
      Reader.draw_address(output, state, page.url, force: true)
    end

    def self.handle_address_key(output : Screen::Output, state : Reader::State,
                                page : Reader::PageEnv, keyboard : Keyboard?,
                                chunk : String) : Nil
      state.core.mark_input
      bar = state.address.not_nil!

      if key_is(chunk, "Escape", state)
        state.mode = "browse"
        Reader.draw_hint(output, state)
        Reader.draw_address(output, state, page.url, force: true)
        Reader.park_cursor(output, state, page.url)
        return
      end

      if chunk == "\r" || chunk == "\n"
        target = bar.text.strip
        state.mode = "browse"
        Reader.draw_hint(output, state)
        if target.empty?
          Reader.draw_address(output, state, page.url, force: true)
          Reader.park_cursor(output, state, page.url)
          return
        end
        # An address bar takes an address when it is given one and searches
        # when it is not — see address.cr for which is which. Words are not
        # an address with a scheme missing, and treating them as one is how
        # a browser sends you nowhere.
        resolved = Address.resolve(target, state.search || Address::DEFAULT_SEARCH)
        if resolved["error"]?
          Reader.draw_address(output, state, page.url, force: true)
          Reader.park_cursor(output, state, page.url)
          return
        end
        # https://user:password@host is deprecated for subresources in
        # Chrome and interrupted by a confirmation of its own in Firefox, so
        # the pair is taken out here and used to answer the challenge
        # instead. The session-only credentials store remembers it for the
        # challenge without leaving the password in browser history.
        credentials = Auth.split_credentials(resolved["url"].as_s)
        if username = credentials["username"].as_s?
          state.credentials.try(&.remember(credentials["url"].as_s, username,
            credentials["password"].as_s? || ""))
        end
        # Say that a search happened. A reader who typed a host name with a
        # typo in it is otherwise handed a results page with no account of
        # why.
        if resolved["searched"]?.try(&.as_bool?)
          Reader.set_status(output, state, page.url,
            "Searching for \"#{resolved["words"]?.try(&.as_s?)}\"…")
        end
        load_address(output, state, page, keyboard, credentials["url"].as_s)
        return
      end

      editing = Edit.edit_action(chunk, keymap_for(state))
      if editing
        buffer = Edit::Buffer.new(bar.text, bar.caret)
        Edit.apply_buffer_edit(buffer, editing)
        bar.text = buffer.text
        bar.caret = buffer.caret
      elsif key_is(chunk, "Ctrl+L", state)
        bar.text = ""
        bar.caret = 0
      elsif !chunk.starts_with?(ESC) && chunk >= " "
        bar.text = bar.text[0, bar.caret] + chunk + bar.text[bar.caret..]
        bar.caret += chunk.size
      end

      Reader.draw_address(output, state, page.url, false, true)
    end

    # ------------------------------------------------------------------
    # Page history
    # ------------------------------------------------------------------

    private def self.remember_history_place(state : Reader::State,
                                            page : Reader::PageEnv) : Nil
      state.credentials.try(&.reconsider)
      state.history_places[page.history_identity] = JSON::Any.new({
        "cursor" => JSON::Any.new(state.cursor.to_i64),
        "col" => JSON::Any.new(state.col.to_i64),
        "scroll" => JSON::Any.new(state.scroll.to_i64),
      })
    end

    def self.move_in_history(output : Screen::Output, state : Reader::State,
                             page : Reader::PageEnv, direction : Int32) : Nil
      verb = direction < 0 ? "back" : "forward"
      set_live_value(state, "refreshing", JSON::Any.new(true))
      begin
        remember_history_place(state, page)
        unless page.history_go(direction)
          Reader.set_status(output, state, page.url, "No page to go #{verb} to.")
          return
        end
        identity = page.history_identity
        Reader.refresh(state, page, true)
        if saved = state.history_places[identity]?
          place = saved.as_h
          state.cursor = Math.min(Math.max((place["cursor"]?.try(&.as_i64?) || 0).to_i32, 0),
            Math.max(state.lines.size - 1, 0))
          state.col = (place["col"]?.try(&.as_i64?) || 0).to_i32
          state.scroll = (place["scroll"]?.try(&.as_i64?) || 0).to_i32
          Reader.clamp_col(state)
          Reader.clamp_scroll(state)
        end
        set_live_value(state, "href", JSON::Any.new(page.url))
        set_live_value(state, "navigated", JSON::Any.new(false))
        Reader.render(output, state, page.url, true)
        Reader.set_status(output, state, page.url, "Went #{verb} to #{page.url}")
      rescue error
        reason = (error.message || error.to_s).lines.first? || error.to_s
        Reader.set_status(output, state, page.url, "Could not go #{verb}: #{reason}")
      ensure
        set_live_value(state, "refreshing", JSON::Any.new(false))
      end
    end

    # ------------------------------------------------------------------
    # Browser libraries
    # ------------------------------------------------------------------

    def self.show_library(output : Screen::Output, state : Reader::State,
                          page : Reader::PageEnv, filter : String) : Nil
      library = state.library || return
      object = library.as_h
      object["filter"] = JSON::Any.new(filter)
      rows = object["rows"].as_a.select do |row|
        Library.matches?(row.as_h["text"].as_s, filter)
      end
      object["blocks"] = JSON::Any.new(rows.map do |row|
        JSON::Any.new({"text" => row.as_h["text"],
                       "entry" => row.as_h["entry"]? || JSON::Any.new(nil)})
      end)
      state.cursor = 0
      state.col = 0
      state.scroll = 0
      Reader.relayout(state)
      Reader.render(output, state, page.url, true)
      if rows.empty?
        Reader.set_status(output, state, page.url,
          filter.empty? ? "No entries." : "No entries match \"#{filter}\".")
      end
    end

    def self.open_library(output : Screen::Output, state : Reader::State,
                          page : Reader::PageEnv, kind : String) : Nil
      provider = state.browser_library
      label = Library::KIND_LABELS[kind]? || kind
      unless provider
        Reader.set_status(output, state, page.url,
          "This Firefox has no library agent endpoint; restart it through tawb to read #{label.downcase}.")
        return
      end
      Reader.set_status(output, state, page.url, "Reading #{label.downcase}…")
      begin
        entries = provider.read(kind)
      rescue error
        reason = (error.message || error.to_s).lines.first? || error.to_s
        Reader.set_status(output, state, page.url,
          "Could not read #{label.downcase}: #{reason}")
        return
      end
      rows = entries.map do |entry|
        JSON::Any.new({"text" => JSON::Any.new(Library.entry_line(kind, entry)),
                       "entry" => entry})
      end
      state.library = JSON::Any.new({
        "kind" => JSON::Any.new(kind), "label" => JSON::Any.new(label),
        "filter" => JSON::Any.new(""), "rows" => JSON::Any.new(rows),
        "blocks" => JSON::Any.new([] of JSON::Any),
        "place" => JSON::Any.new({
          "cursor" => JSON::Any.new(state.cursor.to_i64), "col" => JSON::Any.new(state.col.to_i64),
          "scroll" => JSON::Any.new(state.scroll.to_i64), "title" => JSON::Any.new(state.title),
        }),
      })
      set_live_value(state, "refreshing", JSON::Any.new(true))
      state.mode = "library"
      state.title = "#{label} — #{entries.size}"
      show_library(output, state, page, "")
    end

    def self.close_library(output : Screen::Output, state : Reader::State,
                           page : Reader::PageEnv, note : String? = nil) : Nil
      library = state.library || return
      place = library.as_h["place"].as_h
      state.library = nil
      state.mode = "browse"
      set_live_value(state, "refreshing", JSON::Any.new(false))
      state.title = place["title"].as_s
      Reader.relayout(state)
      state.cursor = Math.min((place["cursor"]?.try(&.as_i64?) || 0).to_i32,
        Math.max(state.lines.size - 1, 0))
      state.col = (place["col"]?.try(&.as_i64?) || 0).to_i32
      state.scroll = (place["scroll"]?.try(&.as_i64?) || 0).to_i32
      Reader.clamp_col(state); Reader.clamp_scroll(state)
      Reader.render(output, state, page.url, true)
      Reader.set_status(output, state, page.url, note) if note
    end

    private def self.ask_bookmark_name(output : Screen::Output, state : Reader::State,
                                       page : Reader::PageEnv, keyboard : Keyboard?,
                                       initial : String) : String?
      return nil unless keyboard
      state.core.mark_input
      previous_mode = state.mode
      state.mode = "line"
      state.line_prompt = Reader::LinePrompt.new("Bookmark", Reader::Buffer.new(initial, initial.size))
      token = keyboard.claim
      Reader.draw_hint(output, state, true)
      Reader.draw_line_prompt(output, state)
      begin
        loop do
          key = keyboard.next_key(token)
          return nil if key.is_a?(Input::Eof)
          chunk = key.as(String)
          return nil if key_is(chunk, "Escape", state)
          return state.line_prompt.not_nil!.buffer.text if chunk == "\r" || chunk == "\n"
          buffer = state.line_prompt.not_nil!.buffer
          if editing = Edit.edit_action(chunk, keymap_for(state))
            edited = Edit::Buffer.new(buffer.text, buffer.caret)
            Edit.apply_buffer_edit(edited, editing)
            buffer.text = edited.text; buffer.caret = edited.caret
          elsif !chunk.starts_with?(ESC) && chunk >= " "
            buffer.text = buffer.text[0, buffer.caret] + chunk + buffer.text[buffer.caret..]
            buffer.caret += chunk.size
          end
          Reader.draw_line_prompt(output, state)
        end
      ensure
        keyboard.release(token)
        state.line_prompt = nil
        state.mode = previous_mode
        Reader.draw_hint(output, state, true)
      end
    end

    def self.bookmark_page(output : Screen::Output, state : Reader::State,
                           page : Reader::PageEnv, keyboard : Keyboard?) : Nil
      provider = state.browser_library
      unless provider
        Reader.set_status(output, state, page.url,
          "This Firefox has no library agent endpoint; restart it through tawb to add bookmarks.")
        return
      end
      if page.url.empty? || page.url.downcase == "about:blank"
        Reader.set_status(output, state, page.url, "There is no page here to bookmark.")
        return
      end
      suggested = state.title.strip
      suggested = page.url if suggested.empty?
      name = ask_bookmark_name(output, state, page, keyboard, suggested)
      unless name
        Reader.set_status(output, state, page.url, "Not bookmarked.")
        return
      end
      begin
        saved = provider.save(page.url, name.strip.empty? ? suggested : name.strip).as_h
        title = saved["title"]?.try(&.as_s?) || suggested
        folder = saved["folder"]?.try(&.as_s?)
        where = folder && !folder.empty? ? " in #{folder}" : ""
        Reader.set_status(output, state, page.url, saved["existed"]?.try(&.as_bool?) ?
          "Already bookmarked as \"#{title}\"#{where} — not filed again." :
          "Bookmarked \"#{title}\"#{where}.")
      rescue error
        Reader.set_status(output, state, page.url,
          "Could not bookmark it: #{(error.message || error.to_s).lines.first?}")
      end
    end

    def self.handle_library_key(output : Screen::Output, state : Reader::State,
                                page : Reader::PageEnv, keyboard : Keyboard?, chunk : String) : String?
      state.core.mark_input
      library = state.library
      unless library
        state.mode = "browse"
        return nil
      end
      object = library.as_h
      label = object["label"].as_s
      if key_is(chunk, "Escape", state)
        close_library(output, state, page, "Closed #{label.downcase}.")
        return nil
      end
      action = keymap_for(state).action_for(chunk)
      return "quit" if action == "quit" || action == "abort"
      last = state.lines.size - 1
      if key_is(chunk, "ArrowDown", state)
        Reader.move_selection(output, state, page.url, Math.min(state.cursor + 1, last)); return nil
      elsif key_is(chunk, "ArrowUp", state)
        Reader.move_selection(output, state, page.url, Math.max(state.cursor - 1, 0)); return nil
      elsif key_is(chunk, "PageDown", state)
        Reader.move_screen(output, state, 1, page.url); return nil
      elsif key_is(chunk, "PageUp", state)
        Reader.move_screen(output, state, -1, page.url); return nil
      end
      if (chunk == "\r" || chunk == "\n")
        entry = Reader.current_block(state).try(&.as_h).try(&.["entry"]?)
        url = entry.try(&.as_h?).try(&.["url"]?).try(&.as_s?)
        unless url && !url.empty?
          Reader.set_status(output, state, page.url, "Move to an entry first."); return nil
        end
        close_library(output, state, page)
        load_address(output, state, page, keyboard, url)
        return nil
      end
      if object["kind"].as_s == "bookmarks" && action == "delete-bookmark"
        entry = Reader.current_block(state).try(&.as_h).try(&.["entry"]?)
        unless entry
          Reader.set_status(output, state, page.url, "Move to a bookmark first."); return nil
        end
        if ask_yes_no(output, state, keyboard,
             "Remove bookmark \"#{entry.as_h["title"]?.try(&.as_s?) || entry.as_h["url"]?.try(&.as_s?)}\"?")
          state.browser_library.try(&.delete(entry))
          object["rows"].as_a.reject! { |row| row.as_h["entry"]? == entry }
          show_library(output, state, page, object["filter"].as_s)
          Reader.set_status(output, state, page.url, "Removed bookmark.")
        else
          Reader.set_status(output, state, page.url, "Bookmark not removed.")
        end
        return nil
      end
      filter = object["filter"].as_s
      if key_is(chunk, "Backspace", state)
        show_library(output, state, page, filter.empty? ? filter : filter[0, filter.size - 1])
      elsif !chunk.starts_with?(ESC) && chunk >= " "
        show_library(output, state, page, filter + chunk)
      end
      nil
    end

    # ------------------------------------------------------------------
    # Tabs
    #
    # A tab switch replaces the whole document the buffer describes, so it
    # resets rather than reanchors. The TabEnv owns the changing current page;
    # every later key asks it again through the loop/harness.
    # ------------------------------------------------------------------

    def self.switch_to_tab(output : Screen::Output, state : Reader::State,
                           tabs : Reader::TabEnv, page : Reader::PageEnv,
                           note : String = "") : Bool
      return false if page.same?(tabs.current_page)
      tabs.adopt_tab(page)
      Reader.refresh(state, page, true)
      Reader.render(output, state, page.url, true)
      position = tabs.tab_position(page)
      label = tabs.tab_label(page)
      message = "Tab #{position[:position]} of #{position[:of]}: #{label}"
      message = "#{note} — tab #{position[:position]} of #{position[:of]}: #{label}" unless note.empty?
      Reader.set_status(output, state, page.url, message)
      true
    end

    def self.cycle_tab(output : Screen::Output, state : Reader::State,
                       tabs : Reader::TabEnv, direction : Int32) : Nil
      page = tabs.next_tab(direction)
      unless page
        Reader.set_status(output, state, tabs.current_page.url, "Only one tab open.")
        return
      end
      switch_to_tab(output, state, tabs, page)
    end

    def self.open_new_tab(output : Screen::Output, state : Reader::State,
                          tabs : Reader::TabEnv) : Nil
      begin
        page = tabs.new_tab
        switch_to_tab(output, state, tabs, page, "Opened a new tab")
        focus_address_bar(output, state, page, "")
      rescue err
        reason = (err.message || err.to_s).lines.first? || err.to_s
        Reader.set_status(output, state, tabs.current_page.url,
          "Could not open a new tab: #{reason}")
      end
    end

    def self.close_current_tab(output : Screen::Output, state : Reader::State,
                               tabs : Reader::TabEnv) : Nil
      current = tabs.current_page
      following = tabs.tab_after(current)
      unless following
        Reader.set_status(output, state, current.url,
          "This is the only tab open — press q to quit.")
        return
      end
      label = tabs.tab_label(current)
      begin
        tabs.close_tab(current)
      rescue err
        reason = (err.message || err.to_s).lines.first? || err.to_s
        Reader.set_status(output, state, current.url,
          "Could not close this tab: #{reason}")
        return
      end
      switch_to_tab(output, state, tabs, following, "Closed \"#{label}\"")
    end

    # ------------------------------------------------------------------
    # The browse map
    #
    # One dispatch for everything reading does: quit, go somewhere, move,
    # toggle, refresh, and press what the cursor is standing on. What it
    # cannot do yet is the work of the pieces that are still
    # JavaScript-only: switching views by element (the element-handle half
    # of place.js), the history traversal, the browser's own lists, the
    # native dialogs, and the keyboard wizard's takeover of the screen.
    # Those actions are noted where they would go.
    # ------------------------------------------------------------------

    # Asking first: Lynx tells quitting apart from aborting. QUIT asks,
    # ABORT does not.
    def self.ask_yes_no(output : Screen::Output, state : Reader::State,
                        keyboard : Keyboard?, question : String,
                        default_yes : Bool = false) : Bool
      return false unless keyboard
      previous_mode = state.mode
      previous_status = state.status_msg
      state.mode = "confirm"
      token = keyboard.claim
      Reader.draw_hint(output, state, force: true)
      Reader.set_status(output, state, "", "#{question} (#{default_yes ? "y" : "y/n"})")
      Screen.move_cursor(output, Reader.status_row(state),
        Math.min(question.size + 8, state.cols))
      answer = false
      begin
        answer = loop do
          chunk = keyboard.next_key(token)
          break false if chunk.is_a?(Input::Eof)
          chunk = chunk.as(String)
          break false if key_is(chunk, "Escape", state)
          break false if chunk.matches?(/^[nN]$/)
          break true if chunk.matches?(/^[yY]$/)
          # Enter is the answer the prompt is showing as its default.
          break true if default_yes && (chunk == "\r" || chunk == "\n")
        end
      ensure
        keyboard.release(token)
        state.mode = previous_mode
        state.status_msg = previous_status
        Reader.draw_hint(output, state, force: true)
      end
    end

    private def self.reload_page(output : Screen::Output, state : Reader::State,
                                 page : Reader::PageEnv, ignore_cache : Bool) : Nil
      anchor = state.core.anchor
      screen = Reader.screen_before(state)
      Reader.set_status(output, state, page.url,
        "#{ignore_cache ? "Reloading without cache" : "Reloading"} #{page.url}…")
      begin
        page.reload(ignore_cache)
        Reader.refresh(state, page, false, anchor)
        Reader.repaint_list(output, state, page.url, screen)
        Reader.set_status(output, state, page.url,
          "#{ignore_cache ? "Reloaded without cache" : "Reloaded"} #{page.url}.")
      rescue err
        Reader.set_status(output, state, page.url,
          "Could not reload the page: #{(err.message || err.to_s).lines.first?}")
      end
    end

    private def self.interrupt_loading(output : Screen::Output, state : Reader::State,
                                       page : Reader::PageEnv) : Nil
      # Every page can be asked to stop; the refusal is the engine's.
      begin
        page.stop_loading
        Reader.set_status(output, state, page.url, "Stopped loading.")
      rescue err
        Reader.set_status(output, state, page.url,
          "Could not stop loading: #{(err.message || err.to_s).lines.first?}")
      end
    end

    private def self.at_end?(state : Reader::State) : Bool
      state.cursor >= state.lines.size - 1
    end

    # Moving past the last line is how the reader asks a feed for more.
    def self.load_more(output : Screen::Output, state : Reader::State,
                       page : Reader::PageEnv) : Nil
      return if state.loading_more

      # Already asked, already answered. The reader gets the truth
      # immediately instead of the same two and a half seconds of waiting
      # for it.
      if state.core.no_more_to_load
        Reader.set_status(output, state, page.url, "End of page.")
        return
      end

      state.loading_more = true
      # Hold off the live refresh: the page is about to mutate heavily, and
      # a rebuild landing in the middle of this one would fight with it.
      was_refreshing = live_value(state, "refreshing")
      set_live_value(state, "refreshing", JSON::Any.new(true))
      Reader.set_status(output, state, page.url, "Loading more…")

      lines_before = state.lines.size
      asked = begin
        state.core.ask_for_more
      rescue
        state.loading_more = false
        if was = was_refreshing
        set_live_value(state, "refreshing", was)
      end
        Reader.set_status(output, state, page.url, "Could not ask the page for more.")
        return
      end

      unless asked.as_h["grew"]?.try(&.as_bool?)
        # Nothing arrived, so there is nothing to rebuild — and a rebuild
        # here does not merely cost a snapshot for no gain, it can lose
        # content. The core has put the scroll back and remembered the
        # answer.
        state.loading_more = false
        if was = was_refreshing
          set_live_value(state, "refreshing", was)
        end
        Reader.set_status(output, state, page.url, "End of page.")
        return
      end

      previous_texts = state.core.blocks.map do |block|
        block.as_h["text"]?.try(&.as_s?) || ""
      end
      anchor = state.core.anchor
      screen = Reader.screen_before(state)

      begin
        Reader.refresh(state, page)
      rescue
        # The rebuild failed; the bookkeeping below still runs.
      end
      settled = state.core.reanchor_with_texts(anchor, previous_texts)
      line = Reader.line_for_block(state,
        (settled.as_h["block"]?.try(&.as_i64?) || -1).to_i32)
      state.cursor = line if line >= 0
      state.cursor = Math.min(Math.max(state.cursor, 0), Math.max(state.lines.size - 1, 0))
      Reader.clamp_col(state)
      Reader.clamp_scroll(state)

      added = state.lines.size - lines_before
      set_live_value(state, "lastPulseMs", JSON::Any.new(0_i64)) # the fingerprint is stale now
      if was = was_refreshing
        set_live_value(state, "refreshing", was)
      end
      state.loading_more = false

      Reader.repaint_list(output, state, page.url, screen)

      if added > 0
        # The reader asked to move down, so move down — onto the first of
        # what just arrived, which is where they were headed.
        Reader.move_selection(output, state, page.url, state.cursor + 1)
        Reader.set_status(output, state, page.url,
          "#{added} more line#{added == 1 ? "" : "s"}.")
      else
        # The page grew but said nothing worth reading: trackers, a spinner.
        Reader.set_status(output, state, page.url, "Nothing more to read.")
      end
    end

    private def self.live_value(state : Reader::State, key : String) : JSON::Any?
      live = state.core.live
      hash = live.try(&.as_h?)
      hash.try(&.[key]?)
    end

    private def self.set_live_value(state : Reader::State, key : String, value : JSON::Any) : Nil
      live = state.core.live
      hash = live.try(&.as_h?)
      return unless hash
      hash[key] = value
    end

    # ------------------------------------------------------------------
    # A click the browser treats as a person's, and the pointer put
    # somewhere, pressing nothing
    # ------------------------------------------------------------------

    def self.click_as_human(output : Screen::Output, state : Reader::State,
                            page : Reader::PageEnv) : Nil
      item = Reader.item_under_cursor(state)
      unless item
        Reader.set_status(output, state, page.url, "Nothing on this line to click.")
        return
      end
      unless state.core.can_real_click
        Reader.set_status(output, state, page.url,
          "The #{state.core.driver_name} driver cannot send a real click.")
        return
      end

      previous_texts = state.core.blocks.map do |block|
        block.as_h["text"]?.try(&.as_s?) || ""
      end
      previous_url = page.url
      # The page-history place the JavaScript original remembers here is
      # ported with the history traversal helpers.
      anchor = state.core.anchor
      screen = Reader.screen_before(state)

      Reader.set_status(output, state, page.url,
        "Clicking \"#{item.as_h["name"]?.try(&.as_s?)}\" as a person would...")
      clicked = state.core.real_click(item.not_nil!)
      unless clicked.as_h["ok"]?.try(&.as_bool?)
        reason = clicked.as_h["reason"]?.try(&.as_s?) || "could not be found"
        Reader.set_status(output, state, page.url,
          "Cannot click \"#{item.as_h["name"]?.try(&.as_s?)}\": it #{reason}." +
          " Enter activates it without a real click.")
        return
      end
      state.status_msg = "Clicked \"#{item.as_h["name"]?.try(&.as_s?)}\""

      report_after_action(output, state, page, previous_texts, previous_url,
        anchor, screen, nil)
    end

    # A menu that slides or fades open is not finished when the pointer
    # arrives, so the page is given a moment before it is read again.
    private HOVER_SETTLE_MS = 600

    def self.hover_as_human(output : Screen::Output, state : Reader::State,
                            page : Reader::PageEnv) : Nil
      item = Reader.item_under_cursor(state)
      unless item
        Reader.set_status(output, state, page.url, "Nothing on this line to hover.")
        return
      end
      unless state.core.can_hover
        Reader.set_status(output, state, page.url,
          "The #{state.core.driver_name} driver cannot move the pointer.")
        return
      end

      previous_texts = state.core.blocks.map do |block|
        block.as_h["text"]?.try(&.as_s?) || ""
      end
      previous_url = page.url
      anchor = state.core.anchor
      screen = Reader.screen_before(state)

      Reader.set_status(output, state, page.url,
        "Putting the pointer on \"#{item.as_h["name"]?.try(&.as_s?)}\"…")
      hovered = state.core.hover(item.not_nil!)
      unless hovered.as_h["ok"]?.try(&.as_bool?)
        reason = hovered.as_h["reason"]?.try(&.as_s?) || "could not be found"
        Reader.set_status(output, state, page.url,
          "Cannot hover \"#{item.as_h["name"]?.try(&.as_s?)}\": it #{reason}.")
        return
      end
      state.status_msg = "Pointer on \"#{item.as_h["name"]?.try(&.as_s?)}\""

      sleep HOVER_SETTLE_MS.milliseconds
      report_after_action(output, state, page, previous_texts, previous_url,
        anchor, screen, nil)
    end

    def self.download_current_link(output : Screen::Output, state : Reader::State,
                                   page : Reader::PageEnv) : Nil
      item = Reader.item_under_cursor(state)
      role = item.try(&.as_h).try(&.["role"]?).try(&.as_s?) || ""
      if item.nil? || !Aria::LINK_ROLES.includes?(role)
        Reader.set_status(output, state, page.url, "Move to a link before downloading.")
        return
      end
      name = item.not_nil!.as_h["name"]?.try(&.as_s?) || ""
      Reader.set_status(output, state, page.url, "Downloading \"#{name}\"…")
      begin
        result = state.core.download_link(item.not_nil!)
        unless result.as_h["ok"]?.try(&.as_bool?)
          reason = result.as_h["reason"]?.try(&.as_s?) || "could not be found"
          Reader.set_status(output, state, page.url,
            "Could not download \"#{name}\": #{reason}.")
          return
        end
        Reader.set_status(output, state, page.url, "Added \"#{name}\" to downloads.")
      rescue err
        reason = (err.message || err.to_s).lines.first? || err.to_s
        Reader.set_status(output, state, page.url,
          "Could not download \"#{name}\": #{reason}")
      end
    end

    def self.jump_to_change(output : Screen::Output, state : Reader::State,
                            page : Reader::PageEnv, direction : Int32) : Nil
      # Resolved against the buffer as it stands now, and in document order,
      # so repeated presses walk down the page rather than around the order
      # things happened to arrive in.
      targets = state.core.change_targets
      if targets.empty?
        Reader.set_status(output, state, page.url, "No recorded changes.")
        return
      end
      count = targets.size
      state.core.change_index = (state.core.change_index + direction + count) % count
      target = targets[state.core.change_index]
      line_index = Reader.line_for_block(state,
        (target.as_h["block"]?.try(&.as_i64?) || -1).to_i32)
      if line_index < 0
        Reader.set_status(output, state, page.url, "Changed area is no longer present.")
        return
      end
      Reader.move_selection(output, state, page.url, line_index, 0)
      size = (target.as_h["size"]?.try(&.as_i64?) || 0).to_i32
      Reader.set_status(output, state, page.url,
        "Change #{state.core.change_index + 1} of #{count} (#{size} line#{size == 1 ? "" : "s"}).")
    end

    # The cursor is parked at the bottom-right while nothing is being
    # chosen, the way a fixed screen leaves it.
    private def self.action_key_label(state : Reader::State, id : String,
                                      fallback : String) : String
      Reader.action_key_label(state, id, fallback)
    end

    def self.handle_browse_key(output : Screen::Output, state : Reader::State,
                               page : Reader::PageEnv, keyboard : Keyboard?,
                               chunk : String, now : Int64 = 0_i64) : String?
      state.core.mark_input
      actions = mode_actions(output, page.url)
      if actions.digit?(chunk, lynx_view(state))
        return nil
      end
      action = keymap_for(state).action_for(chunk)
      if Reader.popup_is_open(state)
        context_action = context_action(chunk, state)
        verdict = popup_key(action, chunk, context_action,
          key_is(chunk, "Escape", state))
        return "quit" if verdict == "quit"
        if verdict == "close"
          close_popup(output, state, page)
          return nil
        end
      end
      if action == "quit"
        return "quit"
      end
      if action == "abort"
        return "quit"
      end
      if action == "confirm-quit"
        return ask_yes_no(output, state, keyboard,
          "Are you sure you want to quit?", true) ? "quit" : nil
      end

      # The actions only Lynx has. link-number is handled here without the
      # interface gate because the action exists only in the Lynx map.
      if (candidate = action) && actions.action?(candidate, lynx_view(state), page)
        return nil
      end

      # A reader inside a menu must always have a way out that also shuts
      # it, rather than one that leaves it open and them somewhere else.
      if action == "close-popup" && state.core.popup
        close_popup(output, state, page)
        return nil
      end

      if action == "location-bar" || action == "goto" || action == "location-edit"
        focus_address_bar(output, state, page, action == "goto" ? "" : page.url)
        return nil
      end

      # ELGOTO: the link's own address, which is not the document's.
      if action == "link-address"
        item = Reader.item_under_cursor(state)
        href = item.try(&.as_h).try(&.["href"]?).try(&.as_s?)
        unless item && href && !href.empty?
          Reader.set_status(output, state, page.url,
            "Move to a link before editing its address.")
          return nil
        end
        focus_address_bar(output, state, page, href)
        return nil
      end

      # The keyboard wizard takes the screen over; it arrives with the loop
      # that owns the terminal.
      if action == "keyboard-wizard"
        return nil
      end

      if action == "refresh"
        previous = state.core.blocks.map do |block|
          block.as_h["text"]?.try(&.as_s?) || ""
        end
        anchor = state.core.anchor
        screen = Reader.screen_before(state)
        Reader.refresh(state, page, false, anchor)
        state.core.note_changes(previous)
        Reader.repaint_list(output, state, page.url, screen)
        Reader.set_status(output, state, page.url, "Rescanned.")
        return nil
      end

      if action == "reload-page"
        reload_page(output, state, page, false)
        return nil
      end
      if action == "reload-no-cache"
        reload_page(output, state, page, true)
        return nil
      end
      if action == "interrupt"
        interrupt_loading(output, state, page)
        return nil
      end

      # Switching views keeps the reader's place by element, and the
      # element-handle half of place.js is still JavaScript-only. Until it
      # is ported, a view switch is not offered here.
      if action == "cycle-view" || action == "source-view"
        return nil
      end

      if action == "next-line"
        if at_end?(state)
          load_more(output, state, page)
          return nil
        end
        Reader.move_selection(output, state, page.url, state.cursor + 1)
        return nil
      end
      if action == "previous-line"
        Reader.move_selection(output, state, page.url, state.cursor - 1)
        return nil
      end
      if action == "next-character"
        Reader.move_caret_right(output, state, page.url)
        return nil
      end
      if action == "previous-character"
        Reader.move_caret_left(output, state, page.url)
        return nil
      end
      if action == "next-screen"
        if at_end?(state)
          load_more(output, state, page)
          return nil
        end
        Reader.move_screen(output, state, 1, page.url)
        return nil
      end
      if action == "previous-screen"
        Reader.move_screen(output, state, -1, page.url)
        return nil
      end
      # Lynx moves half a page with '(' and ')'. The step is counted in
      # lines, where a screen's step is one line short of its height so
      # that the reader keeps a line of context across the join.
      if action == "next-half-screen"
        Reader.move_screen(output, state, 1, page.url,
          Reader.viewport_height(state),
          Math.max(1, Reader.viewport_height(state) // 2))
        return nil
      end
      if action == "previous-half-screen"
        Reader.move_screen(output, state, -1, page.url,
          Reader.viewport_height(state),
          Math.max(1, Reader.viewport_height(state) // 2))
        return nil
      end
      if action == "top"
        Reader.move_selection(output, state, page.url, 0)
        return nil
      end
      if action == "bottom"
        Reader.move_selection(output, state, page.url, state.lines.size - 1)
        return nil
      end
      if action == "line-start"
        Reader.move_selection(output, state, page.url, state.cursor, 0)
        return nil
      end
      if action == "line-end"
        line = Reader.current_line(state)
        Reader.move_selection(output, state, page.url, state.cursor,
          line ? line.text.size - 1 : 0)
        return nil
      end

      if action == "history-back" || action == "history-forward"
        move_in_history(output, state, page, action == "history-back" ? -1 : 1)
        return nil
      end

      if action == "bookmarks" || action == "history" || action == "downloads"
        open_library(output, state, page, action.not_nil!)
        return nil
      end
      if action == "add-bookmark"
        bookmark_page(output, state, page, keyboard)
        return nil
      end
      # Session lists, reference lists and document information use the same
      # library screen; their row producers are connected with the remaining
      # Lynx host-screen work.
      if action == "visited-links" || action == "session-history" ||
         action == "delete-bookmark" || action == "list-links" ||
         action == "list-addresses" || action == "document-info"
        return nil
      end

      if action == "download-link"
        download_current_link(output, state, page)
        return nil
      end

      if action == "new-tab" || action == "next-tab" ||
         action == "previous-tab" || action == "close-tab"
        if tabs = state.tabs
          case action
          when "new-tab"
            open_new_tab(output, state, tabs)
          when "next-tab"
            cycle_tab(output, state, tabs, 1)
          when "previous-tab"
            cycle_tab(output, state, tabs, -1)
          when "close-tab"
            close_current_tab(output, state, tabs)
          end
        end
        return nil
      end

      if action == "next-change"
        jump_to_change(output, state, page, 1)
        return nil
      end
      if action == "previous-change"
        jump_to_change(output, state, page, -1)
        return nil
      end

      if action == "where"
        block = Reader.current_block(state)
        total = state.lines.size
        role = block.try(&.as_h).try(&.["item"]?).try(&.as_h).try(&.["role"]?) || "nothing"
        Reader.set_status(output, state, page.url,
          "Line #{state.cursor + 1} of #{total}, column #{state.col + 1} — #{role}.")
        return nil
      end

      # A page that updates itself is not always welcome: a clock or a
      # ticker would keep marking changes while you are trying to read
      # something else.
      if action == "toggle-live"
        enabled = !(live_value(state, "enabled").try(&.as_bool?) || false)
        set_live_value(state, "enabled", JSON::Any.new(enabled))
        Reader.set_status(output, state, page.url, enabled ?
          "Live updates on." :
          "Live updates off — press r to refresh manually.")
        return nil
      end

      # A row that speaks is not always wanted. Turning it off leaves the
      # last message standing, which is what the row said before any of
      # this existed.
      if action == "toggle-link-address"
        state.link_address = !state.link_address
        Reader.set_status(output, state, page.url, state.link_address ?
          "Link addresses on." :
          "Link addresses off.")
        return nil
      end

      # The host is news only when it changes. Saying it on every link of a
      # site the reader is already reading is a sentence of nothing, over
      # and over.
      if action == "toggle-short-links"
        state.short_links = !state.short_links
        Reader.set_status(output, state, page.url, state.short_links ?
          "Short link addresses on — links on this site say their path alone." :
          "Short link addresses off — links say their full address.")
        return nil
      end

      if action == "real-click"
        click_as_human(output, state, page)
        return nil
      end

      if action == "hover-line"
        hover_as_human(output, state, page)
        return nil
      end

      if action == "page-keyboard"
        # Key repeat can leave another copy of the exit chord queued behind
        # the one that just left page mode. Without this short guard that
        # copy is handled in browse mode and immediately puts the reader
        # back in.
        if state.page_keyboard_exit_until > now
          return nil
        end
        state.mode = "page"
        Reader.draw_hint(output, state)
        exit = action_key_label(state, "page-keyboard", "Alt+K")
        Reader.set_status(output, state, page.url,
          "Webpage keyboard on — Space can play or pause and m can mute or unmute; #{exit} returns to reading.")
        return nil
      end

      if action == "find-forward" || action == "find-backward"
        state.mode = "find"
        state.find = Reader::Find.new(action == "find-forward" ? 1 : -1)
        Reader.draw_hint(output, state)
        Reader.draw_find(output, state)
        return nil
      end

      if action == "repeat-find" || action == "repeat-find-forward" || action == "repeat-find-backward"
        last = state.last_find
        unless last
          Reader.set_status(output, state, page.url,
            "Nothing searched for yet — press / to search.")
          return nil
        end
        direction = action == "repeat-find-backward" ? -1 :
                    action == "repeat-find-forward" ? 1 : last.direction
        last.direction = direction
        run_search(output, state, page.url, last.text, direction)
        return nil
      end

      if action == "first-focusable" || action == "last-focusable"
        direction = action == "first-focusable" ? 1 : -1
        found = Reader.focusable_edge(state, direction)
        unless found
          Reader.set_status(output, state, page.url,
            "No links or form controls in this document.")
          return nil
        end
        Reader.move_selection(output, state, page.url, found[:line], found[:col])
        return nil
      end

      if action == "next-paragraph" || action == "previous-paragraph"
        direction = action == "next-paragraph" ? 1 : -1
        QuickNav.jump_to(output, state, page.url,
          QuickNav.find_paragraph(state, direction), "paragraph", direction)
        return nil
      end

      if (candidate = action) && (spec = QuickNav.specification(candidate))
        found = QuickNav.find(state, candidate)
        QuickNav.jump_to(output, state, page.url, found, spec.label, spec.direction)
        mode_actions(output, page.url).after_quick_nav(!found.nil?, lynx_view(state), page)
        return nil
      end

      # The browser's own questions are answered by the native-dialog
      # support, which is a decision the project has not made yet.
      if action == "browser-question"
        return nil
      end

      if action == "activate"
        activate_current(output, state, page, keyboard)
        return nil
      end

      nil
    end
  end
end
