require "./lynx_keymap"

module Tawb
  # Which interface a reader is using, and what each interface owns.
  #
  # A compatibility interface owns defaults, not implementation. Handlers
  # still receive semantic action names, so Lynx keys use the same
  # browser-backed history, activation, download and editing paths as the
  # ordinary interface. An empty entry is deliberate: it keeps a TAWB reading
  # command from leaking into Lynx merely because nobody supplied a Lynx
  # equivalent for it.
  module Interfaces
    INTERFACES           = Set.new(%w(default lynx))
    DEFAULT_PROFILE_NAME = "default"

    LYNX_BINDINGS = {
      "quit"                    => [] of String,
      "confirm-quit"            => ["q"],
      "abort"                   => ["Q", "Ctrl+D"],
      "location-bar"            => [] of String,
      "goto"                    => ["g"],
      "location-edit"           => ["G"],
      "link-address"            => ["E"],
      "history-back"            => ["ArrowLeft", "u"],
      "history-forward"         => ["Ctrl+U"],
      "activate"                => ["Enter", "ArrowRight"],
      "next-line"               => ["Ctrl+N"],
      "previous-line"           => ["Ctrl+P"],
      "next-character"          => [] of String,
      "previous-character"      => [] of String,
      "next-screen"             => ["Space", "+", "Ctrl+F", "PageDown"],
      "previous-screen"         => ["b", "-", "Ctrl+B", "PageUp"],
      "top"                     => ["Ctrl+A"],
      "bottom"                  => ["Ctrl+E"],
      "line-start"              => ["Home"],
      "line-end"                => ["End"],
      "edit-line-start"         => ["Ctrl+A", "Home"],
      "edit-line-end"           => ["Ctrl+E", "End"],
      "edit-previous-character" => ["ArrowLeft"],
      "edit-next-character"     => ["ArrowRight"],
      "edit-backspace"          => ["Backspace", "Ctrl+H"],
      "edit-delete"             => ["Ctrl+D", "Ctrl+R", "Delete"],
      "edit-previous-word"      => ["Ctrl+P"],
      "edit-next-word"          => ["Ctrl+N"],
      "edit-backspace-word"     => ["Ctrl+B"],
      "edit-delete-word"        => ["Ctrl+F"],
      "edit-kill-start"         => ["Ctrl+U"],
      "edit-kill-end"           => ["Ctrl+_"],
      "edit-command"            => ["Ctrl+V"],
      "new-tab"                 => [] of String,
      "bookmarks"               => ["v"],
      "add-bookmark"            => ["a"],
      "delete-bookmark"         => ["r", "R"],
      "visited-links"           => ["V"],
      "session-history"         => ["Backspace", "Ctrl+H"],
      "downloads"               => [] of String,
      "list-links"              => ["l"],
      "list-addresses"          => ["A"],
      "download-link"           => ["d"],
      "browser-question"        => ["Ctrl+_"],
      "next-tab"                => [] of String,
      "previous-tab"            => [] of String,
      "close-tab"               => [] of String,
      "next-change"             => [] of String,
      "previous-change"         => [] of String,
      "where"                   => [] of String,
      "document-info"           => ["="],
      "options"                 => ["o", "O"],
      "link-number"             => ["0"],
      "toggle-live"             => [] of String,
      "toggle-link-address"     => [] of String,
      "toggle-short-links"      => [] of String,
      "real-click"              => ["Ctrl+Y"],
      "hover-line"              => ["Ctrl+]"],
      "page-keyboard"           => ["Ctrl+\\"],
      "find-forward"            => ["/"],
      "find-backward"           => [] of String,
      "repeat-find"             => [] of String,
      "repeat-find-forward"     => ["n"],
      "repeat-find-backward"    => ["N"],
      "refresh"                 => ["Ctrl+L", "Ctrl+W"],
      "reload-page"             => ["Ctrl+R"],
      "reload-no-cache"         => ["x", "X"],
      "interrupt"               => ["z", "Z"],
      "toggle-trace"            => ["Ctrl+T"],
      "trace-log"               => [";"],
      "cycle-view"              => ["Ctrl+O"],
      "source-view"             => ["\\"],
      "help"                    => ["h", "H", "?"],
      "context-help"            => ["F1"],
      "keyboard-wizard"         => ["k", "K"],
      "main-menu"               => ["m", "M"],
      "next-heading"            => [] of String,
      "previous-heading"        => [] of String,
      "next-link"               => [] of String,
      "previous-link"           => [] of String,
      "next-field"              => [] of String,
      "previous-field"          => [] of String,
      "next-button"             => [] of String,
      "previous-button"         => [] of String,
      "next-focusable"          => ["ArrowDown"],
      "previous-focusable"      => ["ArrowUp"],
      "fast-forward-link"       => ["Tab"],
      "fast-backward-link"      => ["Shift+Tab"],
      "down-link"               => [">"],
      "up-link"                 => ["<"],
      "next-half-screen"        => [")"],
      "previous-half-screen"    => ["("],
      "first-focusable"         => ["^"],
      "last-focusable"          => ["$"],
      "next-text"               => [] of String,
      "previous-text"           => [] of String,
      "next-paragraph"          => [] of String,
      "previous-paragraph"      => [] of String,
      "close-popup"             => [] of String,
    }

    # Function keys beyond F5 are named only for the Lynx profile, because
    # nothing in TAWB's own bindings uses them. Importing an effective Lynx
    # map is the one caller that can: upstream binds F1 to context help and a
    # customized map can put any function key on any command. Keeping them out
    # of the shared table means a reader who has not asked for the Lynx
    # interface gets exactly the startup they had before, with no extra
    # terminfo lookups and no page key that suddenly has a name.
    LYNX_KEY_DEFINITIONS = {
      "F1"  => {cap: "kf1", sequences: ["\eOP", "\e[11~", "\e[[A"]},
      "F2"  => {cap: "kf2", sequences: ["\eOQ", "\e[12~", "\e[[B"]},
      "F3"  => {cap: "kf3", sequences: ["\eOR", "\e[13~", "\e[[C"]},
      "F4"  => {cap: "kf4", sequences: ["\eOS", "\e[14~", "\e[[D"]},
      "F6"  => {cap: "kf6", sequences: ["\e[17~"]},
      "F7"  => {cap: "kf7", sequences: ["\e[18~"]},
      "F8"  => {cap: "kf8", sequences: ["\e[19~"]},
      "F9"  => {cap: "kf9", sequences: ["\e[20~"]},
      "F10" => {cap: "kf10", sequences: ["\e[21~"]},
      "F11" => {cap: "kf11", sequences: ["\e[23~"]},
      "F12" => {cap: "kf12", sequences: ["\e[24~"]},
    }

    # Which interface an action belongs to.
    #
    # Most actions exist in both: the two interfaces are the same browser
    # behind different keys, and an action with no Lynx function of its own is
    # still reachable from either map. The exceptions are the two sets below.
    #
    # A Lynx-only action is one the Lynx interface added — a Lynx function
    # TAWB had no action for, or a browser facility the compatibility work
    # needed. The default interface keeps exactly the keystrokes it had before
    # that work, so these stay out of its map and out of its keyboard screen
    # until somebody pulls one across deliberately.
    LYNX_ONLY_ACTIONS = Set.new([
      "goto", "location-edit", "edit-command", "delete-bookmark", "list-links",
      "list-addresses", "document-info", "options", "link-number",
      "repeat-find-forward", "repeat-find-backward", "reload-no-cache",
      "interrupt", "toggle-trace", "trace-log", "source-view", "help",
      "main-menu", "first-focusable", "last-focusable",
      "fast-forward-link", "fast-backward-link", "down-link", "up-link",
      "next-half-screen", "previous-half-screen",
      "confirm-quit", "abort", "link-address", "context-help",
      "visited-links", "session-history",
    ])

    # A default-only action is one the Lynx interface deliberately leaves out,
    # so that a reader who knows Lynx is never shadowed by a TAWB reading
    # command on a letter Lynx uses. Quick navigation is the bulk of it: Lynx
    # handles moving through a page with numbers and pages, and a reader who
    # wants h/l/f/b/n/p uses the ordinary interface for it.
    DEFAULT_ONLY_ACTIONS = Set.new([
      "quit", "history",
      "location-bar", "next-character", "previous-character", "line-start", "line-end",
      "next-change", "previous-change", "where", "toggle-live", "toggle-link-address",
      "toggle-short-links", "find-backward", "repeat-find", "downloads",
      "next-heading", "previous-heading", "next-link", "previous-link",
      "next-field", "previous-field", "next-button", "previous-button",
      "next-text", "previous-text", "next-paragraph", "previous-paragraph",
    ])

    DEFAULT_LABELS = {
      keyboardTitle: "Keyboard bindings",
    }

    LYNX_LABELS = {
      keyboardTitle:      "Lynx keyboard bindings",
      unsupportedHeading: "Lynx commands with no TAWB equivalent (cannot be bound):",
      unsupportedPrefix:  "Imported Lynx command",
    }

    # What a Lynx key means while a transient page the browser drew is open.
    # The popup, chooser and native-dialog handlers understand these semantic
    # names rather than raw keys, so an imported Lynx map drives them the same
    # way it drives the browse map. The gate is the interface, not the keymap:
    # a Lynx map on a default-interface session derives nothing from these
    # keys.
    LYNX_CONTEXT_ACTIONS = {
      "activate"           => "accept",
      "history-back"       => "cancel",
      "close-popup"        => "cancel",
      "next-focusable"     => "next",
      "next-line"          => "next",
      "previous-focusable" => "previous",
      "previous-line"      => "previous",
      "next-screen"        => "page-next",
      "previous-screen"    => "page-previous",
      "top"                => "first",
      "bottom"             => "last",
    }

    def self.interface_name(value : String?) : String
      name = value.nil? || value.empty? ? DEFAULT_PROFILE_NAME : value.downcase
      unless INTERFACES.includes?(name)
        raise Error.new("Unknown interface #{value}; use default or lynx")
      end
      name
    end

    def self.profiles_for(id : String) : Array(String)
      if LYNX_ONLY_ACTIONS.includes?(id)
        ["lynx"]
      elsif DEFAULT_ONLY_ACTIONS.includes?(id)
        ["default"]
      else
        ["default", "lynx"]
      end
    end

    # Whether an interface needs the extractor's inline-flow and table-cell
    # placement metadata. Only the Lynx display lays a page out with it, so
    # only that profile asks the extractor to compute it. See Core's `layout`.
    def self.needs_layout_metadata(profile : String) : Bool
      interface_name(profile) == "lynx"
    end

    # The parts of key handling an interface owns: terminal keys only it
    # names (the Lynx function keys), the key-file format it reads and
    # writes, and the words its keyboard screen uses. The ordinary interface
    # has no extra keys and no file format, which is what leaves Keymap
    # generic.
    def self.key_policy(profile : String = DEFAULT_PROFILE_NAME)
      unless interface_name(profile) == "lynx"
        return {
          key_definitions: nil,
          key_file:        nil,
          labels:          DEFAULT_LABELS,
        }
      end
      {
        key_definitions: LYNX_KEY_DEFINITIONS,
        key_file:        {
          parse:          ->(text : String) { LynxKeymap.parse_key_file(text) },
          serialise:      ->(entries : Array(NamedTuple(id: String, bindings: Array(String)))) { LynxKeymap.serialise_key_file(entries) },
          function_names: ->(ids : Array(String)) { LynxKeymap.function_names(ids) },
        },
        labels: LYNX_LABELS,
      }
    end

    def self.bindings_for(id : String, defaults : Array(String), profile : String = DEFAULT_PROFILE_NAME) : Array(String)
      if interface_name(profile) == "lynx"
        LYNX_BINDINGS[id]? || [] of String
      else
        defaults
      end
    end

    def self.context_navigation_action(
      chunk : String,
      interface : String,
      action_for : (Proc(String, String?) | Nil) = nil,
    ) : String?
      return nil unless interface_name(interface) == "lynx"
      action = action_for.try(&.call(chunk))
      action ? LYNX_CONTEXT_ACTIONS[action]? : nil
    end

    # Whether the Lynx profile asks for the cursor to be hidden rather than
    # parked on the current item. Lynx's SHOW_CURSOR is documented for speech
    # and braille interfaces; with it off, Lynx leaves the cursor at the
    # bottom-right and marks the current link with reverse video instead.
    # Absent means Lynx's own default, which is to hide it.
    def self.lynx_hides_cursor(interface : String, show_cursor : Bool? = nil) : Bool
      return false unless interface_name(interface) == "lynx"
      !show_cursor
    end

    class Error < Exception
    end
  end
end
