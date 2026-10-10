require "json"
require "./reader"
require "./edit"
require "./quicknav"
require "./lynx_actions"
require "./keys"
require "./input"
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
      LynxActions::State.new(state.interface, state.keys)
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
    end

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
          enabled ? "Webpage keyboard off — the page will rescan when you pause."
                  : "Webpage keyboard off — press r to rescan.")
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

      def open_help(state : LynxActions::State, page) : Nil
      end

      def describe_current(state : LynxActions::State, page) : Nil
      end

      def open_main_menu(state : LynxActions::State, page) : Nil
      end

      def open_options(state : LynxActions::State, page) : Nil
      end

      def open_trace_log(state : LynxActions::State, page) : Nil
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
  end
end
