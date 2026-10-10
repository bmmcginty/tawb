require "./keys"

module Tawb
  # What the Lynx interface does about a key, once the ordinary browse path
  # has been passed over.
  #
  # Nothing here draws a page or reads a buffer on its own: every operation it
  # needs comes from the host the terminal loop hands in. What lives here is
  # the Lynx decision — which action opens a Lynx screen, when a digit starts
  # the number prompt, when Tab between fields enters typing, when a list
  # keeps the browse map rather than filtering, and the words the reader hears
  # for each.
  #
  # The gate is always the interface, never the keymap. A Lynx keymap loaded
  # on a default-interface state derives nothing from these keys, which is
  # the isolation the interface promises.
  class LynxActions
    # The state the reader loop hands in with every question: which interface
    # is in charge and which keymap it loaded. The reader keeps the rest of
    # its state — buffers, modes, pages — to itself.
    class State
      property interface : String
      property keys : Keys::Keymap?

      def initialize(interface : String = "default")
        @interface = interface
        @keys = nil
      end

      def initialize(@keys : Keys::Keymap?)
        @interface = "default"
      end

      def initialize(@interface : String, @keys : Keys::Keymap?); end

      # The one gate every other decision in this class begins with. Kept as
      # a named predicate so the string itself lives only here and in the
      # interface policy.
      def active? : Bool
        @interface == "lynx"
      end

      # What the Searching Type option says, when the Lynx interface is in
      # charge. A pure question of the interface and the loaded preferences,
      # so the search code can ask it without a host.
      def search_case : String?
        return nil unless active?
        @keys.try(&.preferences).try(&.["searchCase"]?).try(&.as_s?)
      end
    end

    # The item under the cursor, as far as these decisions see it: they only
    # ever ask what role it plays, and hand it back to the host that knows
    # the rest.
    class Item
      getter role : String

      def initialize(@role : String); end
    end

    # The host the terminal loop hands in. The JavaScript original took a
    # plain object of functions; here the loop subclasses this module, and
    # the two screens-and-promises calls it opened asynchronously are
    # ordinary calls, since the loop owns its own scheduling.
    module Host
      abstract def fallback_keymap : Keys::Keymap
      abstract def key_is(chunk : String, name : String, state : State) : Bool
      abstract def set_status(state : State, message : String) : Nil
      abstract def current_item(state : State) : Item?
      abstract def is_field(role : String) : Bool
      abstract def begin_typing(state : State, page, item : Item) : Bool
      abstract def open_link_number_prompt(state : State, digits : String?) : Nil
      abstract def open_help(state : State, page) : Nil
      abstract def describe_current(state : State, page) : Nil
      abstract def open_main_menu(state : State, page) : Nil
      abstract def open_options(state : State, page) : Nil
      abstract def open_trace_log(state : State, page) : Nil
      abstract def toggle_trace(state : State) : Nil
    end

    @host : Host

    def initialize(@host : Host); end

    # The one gate every other decision in this class begins with. Kept as a
    # named predicate so the string itself lives only here and in the
    # interface policy.
    def active?(state : State) : Bool
      state.active?
    end

    # A digit starts a number prompt when the profile numbers links or
    # fields. Digits are not bound by the default Lynx map, so this catches
    # them before the unchanged key resolves to nothing.
    def digit?(chunk : String, state : State) : Bool
      return false unless active?(state)
      preferences = state.keys.try(&.preferences)
      return false unless flag?(preferences, "numberLinks") ||
                          flag?(preferences, "numberFields")
      return false unless chunk.matches?(/^\d+$/)
      @host.open_link_number_prompt(state, chunk)
      true
    end

    # The browse actions that only Lynx has. Returns true when it handled
    # one, so the ordinary dispatcher can stop. `link-number` is here without
    # the interface gate because that is how it has always behaved: the
    # action exists only in the Lynx map, and reaching it opened the prompt.
    def action?(action : String, state : State, page) : Bool
      if action == "link-number"
        @host.open_link_number_prompt(state, nil)
        return true
      end
      return false unless active?(state)
      case action
      when "help"
        @host.open_help(state, page)
        true
      when "context-help"
        @host.describe_current(state, page)
        true
      when "main-menu"
        @host.open_main_menu(state, page)
        true
      when "toggle-trace"
        @host.toggle_trace(state)
        true
      when "trace-log"
        @host.open_trace_log(state, page)
        true
      when "options"
        @host.open_options(state, page)
        true
      else
        false
      end
    end

    # Lynx enters a text field as soon as a movement lands on it, unless the
    # profile asks for TEXTFIELDS_NEED_ACTIVATION.
    def after_quick_nav(found : Bool, state : State, page) : Nil
      return unless active?(state) && found
      preferences = state.keys.try(&.preferences)
      return if flag?(preferences, "textfieldsNeedActivation")
      item = @host.current_item(state)
      return unless item && @host.is_field(item.role) &&
                    @host.begin_typing(state, page, item)
      @host.set_status(state, "Enter text. Use arrows or Tab to move off of field.")
    end

    # The status line says which key shuts the popup that just opened.
    def popup_close_hint(state : State) : String
      active?(state) ? "q or Left" : "q or Esc"
    end

    # Searching follows the profile's explicit Searching Type option rather
    # than TAWB's smart case. Nil outside the interface, which leaves the
    # ordinary rule in charge.
    def search_case(state : State) : String?
      state.search_case
    end

    # Which action, if any, this list key names. Read through the browse map
    # as well, because a Lynx internal page is navigated with it.
    def library_action(state : State, chunk : String) : String?
      return nil unless active?(state)
      (state.keys || @host.fallback_keymap).action_for(chunk)
    end

    # A Lynx internal page keeps the browse map, so printable commands must
    # not become TAWB's list filter.
    def library_keeps_browse_map?(state : State) : Bool
      active?(state)
    end

    # Up and Down move off a field in Lynx, where the ordinary interface
    # leaves them to the terminal.
    def tab_arrow?(state : State, chunk : String) : Bool
      active?(state) && (@host.key_is(chunk, "ArrowUp", state) ||
        @host.key_is(chunk, "ArrowDown", state))
    end

    # TEXTFIELDS_NEED_ACTIVATION keeps Tab from landing the reader in an
    # editable field.
    def tab_needs_activation?(state : State) : Bool
      return false unless active?(state)
      flag?(state.keys.try(&.preferences), "textfieldsNeedActivation")
    end

    # What the status line says after Tab lands on an editable field.
    def tab_typing_status(state : State, name : String) : String
      if active?(state)
        "Enter text. Use arrows or Tab to move off of field."
      else
        "Typing into \"#{name}\" — Tab: next control, Esc: stop, Enter: submit."
      end
    end

    # The mode to be in after Tab lands on a non-editable control. Lynx stays
    # in the browse map; the ordinary interface uses its forms map.
    def tab_landed_mode(state : State) : String
      active?(state) ? "browse" : "forms"
    end

    # Lynx's one-command line-editor escape: a key bound to `edit-command`
    # hands the keyboard back to the browse map for exactly one command.
    def type_command?(state : State, chunk : String) : Bool
      return false unless active?(state)
      (state.keys || @host.fallback_keymap).editing_action_for(chunk) == "edit-command"
    end

    # Interaction preferences arrive as JSON from the profile import and the
    # settings file; absent means no, exactly as in Lynx.
    private def flag?(preferences : Hash(String, JSON::Any)?, name : String) : Bool
      value = preferences.try(&.[name]?)
      value.try(&.as_bool?) == true
    end
  end
end
