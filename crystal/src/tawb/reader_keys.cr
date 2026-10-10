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
