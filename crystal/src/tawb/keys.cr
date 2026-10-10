module Tawb
  # The keymap: which keys mean which action, on whichever keyboard is in
  # use, for whichever interface the reader chose.
  #
  # One class answers every question the reader, the wizard and the screens
  # ask about keys: what a press means while reading, what it means while a
  # field is being edited, what a binding is called, what it would displace.
  # The two interfaces are two default sets over the same mechanics — the
  # Lynx policy supplies its bindings, its function keys and its key-file
  # format, and nothing here knows which interface is in charge beyond what
  # the policy said.
  module Keys
    # The key definitions both interfaces share. A definition names a key so
    # bindings and help can speak of ArrowDown rather than of bytes, and
    # carries the portable fallback sequences plus the terminfo capability
    # whose answer, when the terminal has one, is tried first. Tab is a
    # control character rather than an escape sequence, so it is named here
    # only to be displayed as Tab instead of Ctrl+I; Shift+Tab has no such
    # luck, and terminals disagree, so terminfo's back-tab is asked for
    # first.
    KEY_DEFINITIONS = {
      "Escape"         => {cap: nil, sequences: ["\e"]},
      "Enter"          => {cap: nil, sequences: ["\r", "\n"]},
      "Backspace"      => {cap: nil, sequences: ["\x7f", "\x08"]},
      "Space"          => {cap: nil, sequences: [" "]},
      "Delete"         => {cap: "kdch1", sequences: ["\e[3~"]},
      "ArrowUp"        => {cap: "kcuu1", sequences: ["\e[A", "\eOA"]},
      "ArrowDown"      => {cap: "kcud1", sequences: ["\e[B", "\eOB"]},
      "ArrowLeft"      => {cap: "kcub1", sequences: ["\e[D", "\eOD"]},
      "ArrowRight"     => {cap: "kcuf1", sequences: ["\e[C", "\eOC"]},
      "Alt+ArrowLeft"  => {cap: "kLFT3", sequences: ["\e[1;3D", "\e[3D"]},
      "Alt+ArrowRight" => {cap: "kRIT3", sequences: ["\e[1;3C", "\e[3C"]},
      "PageUp"         => {cap: "kpp", sequences: ["\e[5~"]},
      "PageDown"       => {cap: "knp", sequences: ["\e[6~"]},
      "Home"           => {cap: "khome", sequences: ["\e[H", "\eOH", "\e[1~"]},
      "End"            => {cap: "kend", sequences: ["\e[F", "\eOF", "\e[4~"]},
      "F5"             => {cap: "kf5", sequences: ["\e[15~", "\e[[E"]},
      "Shift+F4"       => {cap: "kf16", sequences: ["\e[1;2S", "\eO2S", "\e[14;2~", "\e[26~"]},
      "Tab"            => {cap: nil, sequences: ["\t"]},
      "Shift+Tab"      => {cap: "kcbt", sequences: ["\e[Z"]},
    }

    # Function keys beyond F5 are named only for the Lynx profile and live
    # with the rest of that interface's policy in interfaces.cr.

    # Every action the reader can be told to do, with the words it is named
    # by and the keys it starts with on the ordinary interface. The order is
    # the order the keyboard screen lists them in, and the order a shared key
    # resolves in: when two actions on one keyboard would take the same
    # sequence, the later one wins, which is why the movements the wizard
    # relies on come late.
    ACTIONS = [
      {id: "quit", label: "Quit", defaults: ["Ctrl+C", "q"]},
      {id: "confirm-quit", label: "Quit, asking first", defaults: [] of String},
      {id: "abort", label: "Quit without asking", defaults: [] of String},
      {id: "location-bar", label: "Location bar", defaults: ["Ctrl+L"]},
      {id: "goto", label: "Enter a new address", defaults: [] of String},
      {id: "location-edit", label: "Edit the current address", defaults: [] of String},
      {id: "link-address", label: "Edit the current link's address", defaults: [] of String},
      {id: "history-back", label: "Back in page history", defaults: ["Alt+-"]},
      {id: "history-forward", label: "Forward in page history", defaults: ["Alt++"]},
      {id: "activate", label: "Activate", defaults: ["Enter"]},
      {id: "next-line", label: "Next line", defaults: ["ArrowDown", "j"]},
      {id: "previous-line", label: "Previous line", defaults: ["ArrowUp", "k"]},
      {id: "next-character", label: "Next character", defaults: ["ArrowRight"]},
      {id: "previous-character", label: "Previous character", defaults: ["ArrowLeft"]},
      {id: "next-screen", label: "Next screen", defaults: ["PageDown"]},
      {id: "previous-screen", label: "Previous screen", defaults: ["PageUp"]},
      {id: "top", label: "Top of page", defaults: ["g"]},
      {id: "bottom", label: "Bottom of page", defaults: ["G"]},
      {id: "line-start", label: "Start of line", defaults: ["Home"]},
      {id: "line-end", label: "End of line", defaults: ["End"]},
      {id: "edit-line-start", label: "Start of field while editing", defaults: ["Ctrl+A"]},
      {id: "edit-line-end", label: "End of field while editing", defaults: ["Ctrl+E"]},
      {id: "edit-previous-character", label: "Previous character while editing", defaults: ["Ctrl+B"]},
      {id: "edit-next-character", label: "Next character while editing", defaults: ["Ctrl+F"]},
      {id: "edit-backspace", label: "Delete previous character while editing", defaults: ["Backspace", "Ctrl+H"]},
      {id: "edit-delete", label: "Delete next character while editing", defaults: ["Delete", "Ctrl+D"]},
      {id: "edit-previous-word", label: "Previous word while editing", defaults: ["Alt+B"]},
      {id: "edit-next-word", label: "Next word while editing", defaults: ["Alt+F"]},
      {id: "edit-backspace-word", label: "Delete previous word while editing", defaults: ["Ctrl+W"]},
      {id: "edit-delete-word", label: "Delete next word while editing", defaults: ["Alt+D"]},
      {id: "edit-kill-start", label: "Delete to start while editing", defaults: ["Ctrl+U"]},
      {id: "edit-kill-end", label: "Delete to end while editing", defaults: ["Ctrl+K"]},
      {id: "edit-command", label: "Run one browse command while editing", defaults: [] of String},
      {id: "new-tab", label: "New tab", defaults: ["Ctrl+T"]},
      {id: "bookmarks", label: "Bookmarks", defaults: ["Ctrl+O"]},
      {id: "add-bookmark", label: "Bookmark this page", defaults: ["Ctrl+D"]},
      {id: "delete-bookmark", label: "Delete the selected bookmark", defaults: [] of String},
      {id: "visited-links", label: "Links visited in this session", defaults: [] of String},
      {id: "session-history", label: "Documents held in this session", defaults: [] of String},
      {id: "history", label: "History", defaults: ["Alt+H"]},
      {id: "downloads", label: "Downloads", defaults: ["Alt+J"]},
      {id: "list-links", label: "List page links", defaults: [] of String},
      {id: "list-addresses", label: "List page link addresses", defaults: [] of String},
      {id: "download-link", label: "Download link under the cursor", defaults: ["Alt+D"]},
      {id: "browser-question", label: "Answer the browser again", defaults: ["Alt+Q"]},
      {id: "next-tab", label: "Next tab", defaults: [">"]},
      {id: "previous-tab", label: "Previous tab", defaults: ["<"]},
      {id: "close-tab", label: "Close tab", defaults: ["Shift+F4"]},
      {id: "next-change", label: "Next changed area", defaults: ["c"]},
      {id: "previous-change", label: "Previous changed area", defaults: ["C"]},
      {id: "where", label: "Report position", defaults: ["="]},
      {id: "document-info", label: "Information about current document", defaults: [] of String},
      {id: "options", label: "Options", defaults: [] of String},
      {id: "link-number", label: "Follow a link or page number", defaults: [] of String},
      {id: "toggle-live", label: "Toggle live updates", defaults: ["L"]},
      {id: "toggle-link-address", label: "Toggle link addresses", defaults: ["u"]},
      {id: "toggle-short-links", label: "Toggle short link addresses", defaults: ["U"]},
      {id: "real-click", label: "Real click", defaults: ["m"]},
      {id: "hover-line", label: "Hover the line under the cursor", defaults: ["Alt+M"]},
      {id: "page-keyboard", label: "Send keys to the webpage", defaults: ["Alt+K", "Ctrl+\\"]},
      {id: "find-forward", label: "Find forward", defaults: ["/"]},
      {id: "find-backward", label: "Find backward", defaults: ["?"]},
      {id: "repeat-find", label: "Repeat find", defaults: ["Ctrl+G"]},
      {id: "repeat-find-forward", label: "Repeat find forward", defaults: [] of String},
      {id: "repeat-find-backward", label: "Repeat find backward", defaults: [] of String},
      {id: "refresh", label: "Rescan page view", defaults: ["r"]},
      {id: "reload-page", label: "Reload page", defaults: ["F5"]},
      {id: "reload-no-cache", label: "Reload page without cache", defaults: [] of String},
      {id: "interrupt", label: "Stop loading", defaults: [] of String},
      {id: "toggle-trace", label: "Toggle trace logging", defaults: [] of String},
      {id: "trace-log", label: "View trace log", defaults: [] of String},
      {id: "cycle-view", label: "Cycle view", defaults: ["\\"]},
      {id: "source-view", label: "Toggle source and presentation", defaults: [] of String},
      {id: "help", label: "Help", defaults: [] of String},
      {id: "context-help", label: "Help for the current control", defaults: [] of String},
      {id: "keyboard-wizard", label: "Keyboard wizard", defaults: ["Alt+?"]},
      {id: "main-menu", label: "Go to the main screen", defaults: [] of String},
      {id: "next-heading", label: "Next heading", defaults: ["h"]},
      {id: "previous-heading", label: "Previous heading", defaults: ["H"]},
      {id: "next-link", label: "Next link", defaults: ["l"]},
      {id: "previous-link", label: "Previous link", defaults: [] of String},
      {id: "next-field", label: "Next form field", defaults: ["f"]},
      {id: "previous-field", label: "Previous form field", defaults: ["F"]},
      {id: "next-button", label: "Next button", defaults: ["b"]},
      {id: "previous-button", label: "Previous button", defaults: ["B"]},
      {id: "next-focusable", label: "Next link, button or form field", defaults: ["Tab"]},
      {id: "previous-focusable", label: "Previous link, button or form field", defaults: ["Shift+Tab"]},
      {id: "fast-forward-link", label: "Next link or button", defaults: [] of String},
      {id: "fast-backward-link", label: "Previous link or button", defaults: [] of String},
      {id: "down-link", label: "Link on the next row", defaults: [] of String},
      {id: "up-link", label: "Link on the previous row", defaults: [] of String},
      {id: "next-half-screen", label: "Down half a screen", defaults: [] of String},
      {id: "previous-half-screen", label: "Up half a screen", defaults: [] of String},
      {id: "first-focusable", label: "First link, button or form field", defaults: [] of String},
      {id: "last-focusable", label: "Last link, button or form field", defaults: [] of String},
      {id: "next-text", label: "Next non-link text", defaults: ["n"]},
      {id: "previous-text", label: "Previous non-link text", defaults: ["N"]},
      {id: "next-paragraph", label: "Next paragraph", defaults: ["p"]},
      {id: "previous-paragraph", label: "Previous paragraph", defaults: ["P"]},
      {id: "close-popup", label: "Close open popup", defaults: ["Escape"]},
    ]

    # Which actions mean anything while a field is being edited.
    #
    # Editing and browsing are different keyboards on the same keys, and
    # Ctrl+D is where that stops being a detail: browsers file a bookmark
    # with it, readline deletes the character under the cursor with it, and
    # both are right. One flat sequence-to-action map cannot hold both, and
    # whichever was listed last would silently take the key from the other —
    # which is the thing this file exists to prevent.
    #
    # So a second map is built over these ids alone, and it is the one
    # consulted while typing. The four that are not `edit-` prefixed are the
    # browse movements editing shares on purpose: Home and the arrows do the
    # same thing in a field as on a line, and rebinding them once should move
    # both.
    EDITING_ACTIONS = Set.new(
      ["line-start", "line-end", "previous-character", "next-character"] +
      ACTIONS.select { |action| action[:id].starts_with?("edit-") }.map { |action| action[:id] }
    )

    def self.actions_for(profile : String) : Array(NamedTuple(id: String, label: String, defaults: Array(String)))
      ACTIONS.select { |action| Interfaces.profiles_for(action[:id]).includes?(profile) }
    end

    # The ordinary key file, read the way it has always been: a version-1
    # document whose `actions` object is keyed by TAWB action id. The values
    # are returned exactly as they were written; the keymap validates them,
    # and anything it cannot use is dropped there.
    def self.plain_actions(text : String) : Hash(String, JSON::Any)?
      parsed = JSON.parse(text).as_h?
      return nil unless parsed
      parsed["actions"]?.try(&.as_h?)
    rescue JSON::ParseException
      nil
    end

    # The ordinary key file, written the way it has always been: version 1,
    # keyed by TAWB action id, in the shape JavaScript's JSON.stringify
    # writes, so a reader's file does not change shape across runtimes.
    def self.serialise_actions(actions : Array(Action)) : String
      String.build do |io|
        io << "{\n  \"version\": 1,\n  \"actions\": "
        if actions.empty?
          io << "{}\n}\n"
          next
        end
        io << "{"
        actions.each_with_index do |action, index|
          io << (index.zero? ? "\n" : ",\n")
          io << "    \"" << LynxKeymap.json_escape(action.id) << "\": "
          if action.bindings.empty?
            io << "[]"
          else
            io << "["
            action.bindings.each_with_index do |binding, position|
              io << (position.zero? ? "\n" : ",\n")
              io << "      \"" << LynxKeymap.json_escape(binding) << "\""
            end
            io << "\n    ]"
          end
        end
        io << "\n  }\n}\n"
      end
    end

    def self.keyboards_for(id : String) : Array(String)
      keyboards = [] of String
      keyboards << "browse" unless id.starts_with?("edit-")
      keyboards << "edit" if EDITING_ACTIONS.includes?(id)
      keyboards
    end

    # Sharing a key across the two keyboards is not a clash and must not be
    # reported as one. Ctrl+D files a bookmark while reading and deletes a
    # character while typing; Alt+D downloads a link while reading and
    # deletes the next word while typing. Neither pair can be pressed in the
    # other's mode, so neither pair takes anything from the other.
    def self.shares_keyboard?(id : String, other_id : String) : Bool
      keyboards = keyboards_for(other_id)
      keyboards_for(id).any? { |keyboard| keyboards.includes?(keyboard) }
    end

    def self.config_path(xdg_config_home : String? = ENV["XDG_CONFIG_HOME"]?,
                         home : String = Path.home.to_s, profile : String = "default") : String
      base = xdg_config_home || File.join(home, ".config")
      name = Interfaces.interface_name(profile) == "default" ? "keys.json" : "keys-#{profile}.json"
      File.join(base, "tawb", name)
    end

    # The terminal's own answers for the capabilities the definitions name.
    # A definition without a capability is never asked for, and a capability
    # the terminal cannot answer is simply absent: the portable fallbacks
    # carry the key on their own.
    def self.read_terminfo(definitions = KEY_DEFINITIONS, term : String? = nil) : Hash(String, String)
      found = {} of String => String
      return found if term.nil? && !ENV["TERM"]?
      run_env = term ? ENV.to_h.merge({"TERM" => term}) : nil
      definitions.each do |name, definition|
        cap = definition[:cap] || next
        answer = IO::Memory.new
        result = Process.run("tput", [cap], input: Process::Redirect::Close,
          output: answer, error: Process::Redirect::Close, env: run_env)
        found[name] = answer.to_s if result.success? && !answer.empty?
      end
      found
    end

    def self.ctrl_sequence(letter : String) : String?
      code = letter.upcase[0].ord
      code >= 64 && code <= 95 ? (code - 64).chr.to_s : nil
    end

    def self.raw_spec(sequence : String) : String
      "raw:" + Base64.strict_encode(sequence)
    end

    # One action of the keyboard: what it is called, what it does, and which
    # keys currently reach it. Bindings move; the identity does not.
    class Action
      getter id : String
      getter label : String
      getter defaults : Array(String)
      property bindings : Array(String)

      def initialize(@id, @label, @bindings, @defaults = bindings.dup)
      end
    end

    class Keymap
      getter profile : String
      getter file : String
      getter terminfo : Hash(String, String)
      getter actions : Array(Action)
      getter by_id : Hash(String, Action)
      getter function_names : Hash(String, String)
      getter unsupported : Array(String)
      property preferences : Hash(String, JSON::Any)
      getter labels : Hash(String, String)
      @default_bindings : Hash(String, Array(String))
      @by_id : Hash(String, Action)
      @named_sequences : Hash(String, Array(String))
      @sequence_names : Hash(String, String)
      @sequence_actions : Hash(String, String)
      @editing_actions : Hash(String, String)
      getter key_file : NamedTuple(
        parse: Proc(String, Hash(String, JSON::Any)?),
        serialise: Proc(Array(NamedTuple(id: String, bindings: Array(String))), String),
        function_names: Proc(Array(String), Hash(String, String)),
      ) | Nil
      getter key_definitions : Hash(String, NamedTuple(cap: String?, sequences: Array(String)))

      def initialize(
        terminfo : Hash(String, String)? = nil,
        profile : String = "default",
        file : String? = nil,
        read_file : Bool = true,
        bindings : Hash(String, Array(String)) = {} of String => Array(String),
        unsupported : Array(String) = [] of String,
        preferences : Hash(String, JSON::Any) = {} of String => JSON::Any,
      )
        @profile = Interfaces.interface_name(profile)
        @file = file || Keys.config_path(profile: @profile)
        policy = Interfaces.key_policy(@profile)
        labels = {} of String => String
        policy[:labels].each { |key, value| labels[key.to_s] = value }
        @labels = labels
        @key_file = policy[:key_file]
        # A compatibility profile may name terminal keys TAWB itself never
        # binds. They are added to this profile's vocabulary only, so the
        # shared table and the default profile's terminfo lookups are
        # unchanged.
        @key_definitions = merge_definitions(policy[:key_definitions])
        @terminfo = terminfo || Keys.read_terminfo(@key_definitions)
        @unsupported = unsupported.dup
        @preferences = preferences.dup
        # Only this interface's actions. A key file that names an action
        # belonging to the other one is left alone rather than deleted, so
        # switching interfaces never rewrites the file it is not reading.
        default_actions = Keys.actions_for(@profile)
        @default_bindings = default_actions.to_h do |action|
          {action[:id], bindings[action[:id]]?.try(&.dup) || Interfaces.bindings_for(
            action[:id], action[:defaults], @profile
          )}
        end
        @actions = default_actions.map do |action|
          Action.new(action[:id], action[:label], @default_bindings[action[:id]].dup, action[:defaults])
        end
        @by_id = @actions.to_h { |action| {action.id, action} }
        # What the keyboard screen calls each action in this interface. Lynx
        # names its functions, so the screen does too; the ordinary interface
        # has no such vocabulary and its rows are just the action labels.
        @function_names = @key_file ? LynxKeymap.function_names(@actions.map(&.id)) : {} of String => String
        @named_sequences = {} of String => Array(String)
        @sequence_names = {} of String => String
        @sequence_actions = {} of String => String
        @editing_actions = {} of String => String
        build_names
        displace_unspecified_bindings(Set.new(bindings.keys))
        @actions.each { |action| @default_bindings[action.id] = action.bindings.dup }
        self.load if read_file
        rebuild
      end

      private def merge_definitions(lynx_definitions) : Hash(String, NamedTuple(cap: String?, sequences: Array(String)))
        merged = {} of String => NamedTuple(cap: String?, sequences: Array(String))
        Keys::KEY_DEFINITIONS.each { |name, definition| merged[name] = definition }
        lynx_definitions.try do |definitions|
          definitions.each { |name, definition| merged[name] = {cap: definition[:cap], sequences: definition[:sequences]} }
        end
        merged
      end

      private def build_names : Nil
        @key_definitions.each do |name, definition|
          sequences = definition[:sequences].dup
          if (answer = @terminfo[name]?)
            sequences.unshift(answer)
          end
          @named_sequences[name] = sequences.uniq
          sequences.each { |sequence| @sequence_names[sequence] ||= name }
        end
      end

      def sequences_for(spec : String) : Array(String)
        return @named_sequences[spec] if @named_sequences[spec]?
        if spec.starts_with?("raw:")
          begin
            return [Base64.decode_string(spec[4..])]
          rescue
            return [] of String
          end
        end
        if (ctrl = spec.match(/^Ctrl\+(.+)$/i)) && ctrl[1].size == 1
          sequence = Keys.ctrl_sequence(ctrl[1])
          return sequence ? [sequence] : [] of String
        end
        if (alt_shift = spec.match(/^Alt\+Shift\+(.+)$/i)) && alt_shift[1].size == 1
          return ["\e#{alt_shift[1].upcase}"]
        end
        if (alt = spec.match(/^Alt\+(.+)$/i)) && alt[1].size == 1
          return ["\e#{alt[1].downcase}"]
        end
        spec.size == 1 ? [spec] : [] of String
      end

      def name_for_sequence(sequence : String) : String
        return @sequence_names[sequence] if @sequence_names[sequence]?
        if sequence.size == 1
          code = sequence[0].ord
          return "Ctrl+#{(64 + code).chr}" if code >= 1 && code <= 26
          return "Ctrl+@" if code == 0
          return sequence if code >= 32
        end
        if sequence.size >= 2 && sequence.starts_with?("\e") && sequence[1..].size == 1
          character = sequence[1..]
          return "Alt+Shift+#{character}" if character.matches?(/^[A-Z]$/)
          return "Alt+#{character.upcase}"
        end
        Keys.raw_spec(sequence)
      end

      def display(spec : String) : String
        spec.starts_with?("raw:") ? "sequence #{sequences_for(spec)[0]?.to_s.inspect}" : spec
      end

      # An explicit imported or saved binding wins over a built-in binding
      # added in a later release. Old version-one files do not contain newly
      # introduced actions, so merely adding one on a familiar key must not
      # steal that key from the action the reader explicitly put there years
      # ago.
      def displace_unspecified_bindings(explicit : Set(String)) : Nil
        claimed = Set(String).new
        @actions.each do |action|
          next unless explicit.includes?(action.id)
          action.bindings.each do |binding|
            sequences_for(binding).each { |sequence| claimed << sequence }
          end
        end
        @actions.each do |action|
          next if explicit.includes?(action.id)
          action.bindings = action.bindings.reject do |binding|
            sequences_for(binding).any? { |sequence| claimed.includes?(sequence) }
          end
        end
      end

      def load : Nil
        text = File.read(@file)
        parsed = @key_file ? LynxKeymap.parse_key_file(text) : Keys.plain_actions(text)
        return unless parsed
        explicit = Set(String).new
        parsed.each do |id, bindings_value|
          action = @by_id[id]?
          list = bindings_value.as_a?
          next unless action && list && list.all?(&.as_s?)
          action.bindings = list.map(&.as_s.not_nil!)
            .select { |item| !sequences_for(item).empty? }
            .uniq
          explicit << id
        end
        displace_unspecified_bindings(explicit)
      rescue File::NotFoundError
      end

      # Each action is written into the map of every keyboard it belongs to,
      # and into no other. An `edit-` action never reaches the browsing map,
      # so a key it shares with a browsing action resolves to the browsing
      # action while reading and to the `edit-` action while typing, whichever
      # order the two happen to appear in ACTIONS.
      def rebuild : Nil
        @sequence_actions = {} of String => String
        @editing_actions = {} of String => String
        @actions.each do |action|
          keyboards = Keys.keyboards_for(action.id)
          action.bindings.each do |binding|
            sequences_for(binding).each do |sequence|
              @sequence_actions[sequence] = action.id if keyboards.includes?("browse")
              @editing_actions[sequence] = action.id if keyboards.includes?("edit")
            end
          end
        end
      end

      # The sequence maps an action can be found in, which are the maps to
      # search when asking what else already holds one of its keys.
      def maps_for(id : String) : Array(Hash(String, String))
        keyboards = Keys.keyboards_for(id)
        maps = [] of Hash(String, String)
        maps << @sequence_actions if keyboards.includes?("browse")
        maps << @editing_actions if keyboards.includes?("edit")
        maps
      end

      def action_for(sequence : String) : String?
        @sequence_actions[sequence]?
      end

      # The same question asked from inside a field. See EDITING_ACTIONS.
      def editing_action_for(sequence : String) : String?
        @editing_actions[sequence]?
      end

      def is_key(sequence : String, name : String) : Bool
        sequences_for(name).includes?(sequence)
      end

      def by_id(id : String) : Action?
        @by_id[id]?
      end

      # Which other actions would lose a binding if this one took the key.
      # The wizard asks before taking a key away from something the reader is
      # still using, so it has to know what it would be taking it from.
      #
      # Only the keyboards this action belongs to are searched. An action that
      # is reachable solely while editing loses nothing to a browsing action
      # taking the same key, so it is not named as a clash and the reader is
      # not asked about it.
      def conflicts(id : String, spec : String) : Array(Action)
        owners = Set(String).new
        maps = maps_for(id)
        sequences_for(spec).each do |sequence|
          maps.each do |map|
            owner = map[sequence]?
            owners << owner if owner && owner != id
          end
        end
        owners.map { |owner| @by_id[owner] }
      end

      def assign(id : String, sequence : String, add : Bool = false) : NamedTuple(binding: String, displaced: Action?)?
        action = @by_id[id]? || return nil
        binding = name_for_sequence(sequence)
        sequences = Set.new(sequences_for(binding))
        displaced = nil
        @actions.each do |other|
          next if other.id == action.id
          # A key is only taken from an action that shares a keyboard with
          # this one. Alt+D given to a browsing action leaves the editing
          # action that also answers Alt+D exactly where it was.
          next unless Keys.shares_keyboard?(action.id, other.id)
          kept = other.bindings.reject do |item|
            sequences_for(item).any? { |candidate| sequences.includes?(candidate) }
          end
          displaced = other if kept.size != other.bindings.size
          other.bindings = kept
        end
        action.bindings = add ? (action.bindings + [binding]).uniq : [binding]
        rebuild
        {binding: binding, displaced: displaced}
      end

      def unbind(id : String) : Nil
        action = @by_id[id]? || return
        action.bindings = [] of String
        rebuild
      end

      def reset : Nil
        @actions.each { |action| action.bindings = @default_bindings[action.id].dup }
        rebuild
      end

      def save : Nil
        Dir.mkdir_p(File.dirname(@file))
        contents = if @key_file
                     LynxKeymap.serialise_key_file(@actions.map { |action| {id: action.id, bindings: action.bindings} })
                   else
                     Keys.serialise_actions(@actions)
                   end
        temporary = "#{@file}.#{Process.pid}.tmp"
        File.write(temporary, contents, perm: File::Permissions.new(0o600))
        File.rename(temporary, @file)
      end
    end
  end
end
