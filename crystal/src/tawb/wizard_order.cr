require "set"
require "./keys"

module Tawb
  # The order the keyboard screen reads in.
  #
  # This is a display order, not the order in keys.cr. ACTIONS is ordered so a
  # shared key resolves to the right action; moving a row there would change
  # which action a key reaches. The wizard follows this table instead,
  # grouping actions by what the reader is trying to do.
  #
  # An action that is not named here still appears: it goes into a trailing
  # "Other" section rather than vanishing, which is what keeps a newly added
  # action visible until somebody places it.
  module WizardOrder
    SECTIONS = [
      {
        key: "reading", title: "Reading and movement",
        actions: [
          "next-line", "previous-line",
          "next-character", "previous-character",
          "next-half-screen", "previous-half-screen",
          "next-screen", "previous-screen",
          "top", "bottom",
          "line-start", "line-end",
        ],
      },
      {
        key: "jump", title: "Jump to page content",
        actions: [
          "next-heading", "previous-heading",
          "next-link", "previous-link",
          "next-field", "previous-field",
          "next-button", "previous-button",
          "next-focusable", "previous-focusable",
          "fast-forward-link", "fast-backward-link",
          "down-link", "up-link",
          "first-focusable", "last-focusable",
          "next-text", "previous-text",
          "next-paragraph", "previous-paragraph",
        ],
      },
      {
        key: "find", title: "Find text",
        actions: [
          "find-forward", "find-backward",
          "repeat-find", "repeat-find-forward", "repeat-find-backward",
        ],
      },
      {
        key: "use", title: "Use the current item",
        actions: [
          "activate", "real-click", "hover-line", "close-popup",
          "download-link", "page-keyboard", "link-number",
        ],
      },
      {
        key: "browser", title: "Browser navigation",
        actions: [
          "location-bar", "goto", "location-edit", "link-address",
          "history-back", "history-forward", "main-menu",
          "new-tab", "next-tab", "previous-tab", "close-tab",
          "browser-question",
        ],
      },
      {
        key: "views", title: "Views and updates",
        actions: [
          "cycle-view", "source-view",
          "refresh", "reload-page", "reload-no-cache", "interrupt",
          "next-change", "previous-change",
          "toggle-live", "toggle-link-address", "toggle-short-links",
        ],
      },
      {
        key: "information", title: "Information and saved items",
        actions: [
          "where", "messages", "document-info",
          "list-links", "list-addresses",
          "bookmarks", "add-bookmark", "delete-bookmark",
          "history", "downloads",
          "visited-links", "session-history",
        ],
      },
      {
        key: "editing", title: "Text editing",
        actions: [
          "edit-previous-character", "edit-next-character",
          "edit-backspace", "edit-delete",
          "edit-previous-word", "edit-next-word",
          "edit-backspace-word", "edit-delete-word",
          "edit-kill-start", "edit-kill-end",
          "edit-line-start", "edit-line-end",
          "edit-command",
        ],
      },
      {
        key: "help", title: "Help and settings",
        actions: ["help", "context-help", "options", "keyboard-wizard"],
      },
      {
        key: "diagnostics", title: "Diagnostics",
        actions: [
          "toggle-trace", "trace-log",
          "layout-default", "layout-container", "layout-rectangle",
        ],
      },
      {
        key: "commands", title: "Commands and exit",
        actions: ["command", "quit", "confirm-quit", "abort"],
      },
    ]

    record Section, key : String, title : String, rows : Array(Keys::Action)

    # The actions this profile has, in the table's order, with any action the
    # table does not name collected into a final section. Empty sections are
    # dropped: a profile that has none of a section's actions does not need to
    # read its heading.
    def self.sections_for(actions : Array(Keys::Action)) : Array(Section)
      by_id = actions.to_h { |action| {action.id, action} }
      placed = Set(String).new
      sections = [] of Section
      SECTIONS.each do |definition|
        rows = [] of Keys::Action
        definition[:actions].each do |id|
          action = by_id[id]?
          next unless action
          next if placed.includes?(id)
          placed << id
          rows << action
        end
        sections << Section.new(definition[:key], definition[:title], rows) unless rows.empty?
      end
      other = actions.reject { |action| placed.includes?(action.id) }
      sections << Section.new("other", "Other", other) unless other.empty?
      sections
    end
  end
end
