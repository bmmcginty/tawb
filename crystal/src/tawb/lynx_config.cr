module Tawb
  # The Lynx function vocabulary the compatibility interface acts on.
  #
  # These are the tables the Lynx adapter (still to be ported: reading a
  # lynxrc, importing an effective keymap) shares with the key-file format in
  # lynx_keymap.cr. In JavaScript they live in lynx_config.js next to the
  # importer; here they lead the way so the file format port has its source
  # tables under the same name.
  #
  # An empty entry is deliberate: it keeps a TAWB reading command from leaking
  # into Lynx merely because nobody supplied a Lynx equivalent for it.
  module LynxConfig
    BROWSE_FUNCTIONS = {
      "QUIT" => "confirm-quit", "ABORT" => "abort",
      "GOTO" => "goto", "ELGOTO" => "link-address", "ECGOTO" => "location-edit",
      "PREV_DOC" => "history-back", "NEXT_DOC" => "history-forward",
      "ACTIVATE" => "activate",
      "DOWN_TWO" => "next-line", "UP_TWO" => "previous-line",
      "NEXT_PAGE" => "next-screen",
      # JavaScript reads a repeated key in an object literal as its last
      # entry, so DOWN_HALF and UP_HALF name the half-screen movements; the
      # whole-page movements are named by NEXT_PAGE and PREV_PAGE alone.
      "PREV_PAGE" => "previous-screen",
      "HOME" => "top", "END" => "bottom",
      "ADD_BOOKMARK" => "add-bookmark", "DEL_BOOKMARK" => "delete-bookmark", "VIEW_BOOKMARK" => "bookmarks",
      "VLINKS" => "visited-links", "HISTORY" => "session-history", "DOWNLOAD" => "download-link",
      "LIST" => "list-links", "ADDRLIST" => "list-addresses",
      "INFO" => "document-info", "OPTIONS" => "options", "F_LINK_NUM" => "link-number",
      "WHEREIS" => "find-forward", "NEXT" => "repeat-find-forward", "PREV" => "repeat-find-backward",
      "REFRESH" => "refresh", "RELOAD" => "reload-page", "NOCACHE" => "reload-no-cache", "INTERRUPT" => "interrupt",
      "TRACE_TOGGLE" => "toggle-trace", "TRACE_LOG" => "trace-log",
      "SOURCE" => "source-view", "KEYMAP" => "keyboard-wizard", "HELP" => "help", "DWIMHELP" => "context-help",
      "MAIN_MENU" => "main-menu",
      "NEXT_LINK" => "next-focusable", "FASTFORW_LINK" => "fast-forward-link", "DOWN_LINK" => "down-link",
      "PREV_LINK" => "previous-focusable", "FASTBACKW_LINK" => "fast-backward-link", "UP_LINK" => "up-link",
      "DOWN_HALF" => "next-half-screen", "UP_HALF" => "previous-half-screen",
      "FIRST_LINK" => "first-focusable", "LAST_LINK" => "last-focusable",
    }

    EDIT_FUNCTIONS = {
      "BOL" => "edit-line-start", "EOL" => "edit-line-end",
      "BACK" => "edit-previous-character", "FORW" => "edit-next-character",
      "DELP" => "edit-backspace", "DELN" => "edit-delete",
      "BACKW" => "edit-previous-word", "FORWW" => "edit-next-word",
      "DELPW" => "edit-backspace-word", "DELNW" => "edit-delete-word",
      "ERASE" => "edit-kill-start", "DELEL" => "edit-kill-end", "LKCMD" => "edit-command",
    }
  end
end
