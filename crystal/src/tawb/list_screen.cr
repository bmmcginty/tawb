require "./list_model"

module Tawb
  # The shared policy half of a list screen: whether a printable key is filter
  # text or a command, how one filter edit is applied, and what the screen
  # says about the rows the filter admits. The row/selection/heading rules
  # themselves live in list_model.cr.
  module ListScreen
    TYPEAHEAD = "typeahead"
    EXPLICIT  = "explicit"
    CLEAR_FILTER = "\x15"

    # The shape a filter edit answers with. `handled` is whether this key
    # belonged to the filter at all; `ended` is the explicit input mode
    # closing while its narrowed results stay on screen.
    record Edit, handled : Bool, changed : Bool, ended : Bool, filter : String,
      filtering : Bool

    # Once / has opened the filter, every printable character belongs to it.
    # Del is a control character the terminal encodes above space and is this
    # screen's Backspace, so it is excluded explicitly.
    def self.printable?(chunk : String) : Bool
      !chunk.starts_with?("\e") && chunk != "\x7f" && chunk >= " "
    end

    # One filter edit. `policy` decides whether a typeahead list consumes
    # printable keys while browsing, or an explicit list only consumes them
    # once its filter input has been opened. The caller supplies the key
    # classification because Enter and Backspace are named through the keymap.
    def self.filter_key(policy : String, filtering : Bool, filter : String, chunk : String,
                        character : Bool, backspace : Bool, clear : Bool,
                        enter : Bool, escape : Bool) : Edit
      explicit = policy == EXPLICIT
      if explicit && !filtering
        return Edit.new(false, false, false, filter, filtering)
      end
      # Ctrl+U is always the filter's clear. A page keymap may also call that
      # control chord a command — Lynx has several — but a reader inside the
      # filter input means the edit, not the command.
      if clear
        return Edit.new(true, filter != "", false, "", filtering)
      end
      if explicit && (enter || escape)
        return Edit.new(true, false, true, filter, false)
      end
      if backspace
        return Edit.new(true, !filter.empty?, false, ListModel.backspace_filter(filter), filtering)
      end
      if character
        return Edit.new(true, true, false, ListModel.append_filter(filter, chunk), filtering)
      end
      Edit.new(false, false, false, filter, filtering)
    end

    # The movement a list owns. Library, chooser, wizard and Flex all ask this
    # table rather than each spelling out which keymap actions mean next, first
    # and so on. Left and right are deliberately absent: they are not list
    # movement, and a list which gives them another meaning handles them before
    # asking here.
    MOVEMENTS = {
      "next-line"       => "next",
      "previous-line"   => "previous",
      "next-screen"     => "page-next",
      "previous-screen" => "page-previous",
      "top"             => "first",
      "bottom"          => "last",
      "line-start"      => "first",
      "line-end"        => "last",
      "next"            => "next",
      "previous"        => "previous",
      "first"           => "first",
      "last"            => "last",
      "page-next"       => "page-next",
      "page-previous"   => "page-previous",
    }

    def self.movement(action : String) : String?
      MOVEMENTS[action]?
    end

    # The cursor contract for every list screen. The list model settles which
    # entry is selected; the block turns that entry into the block or line
    # that draws it. A screen must not rediscover the cursor by searching its
    # own drawing for a focused or selected marker, because headings, control
    # headers and other furniture can carry those flags too. Without a mapping
    # the entry index is the location, which is what the library and the
    # wizard use.
    record Cursor(T), index : Int32, entry : ListModel::Entry(T)?, location : Int32

    def self.cursor_location(entries : Array(ListModel::Entry(T)), selected_key : String?,
                             fallback_index : Int32? = nil,
                             &location_for : ListModel::Entry(T), Int32 -> Int32) : Cursor(T) forall T
      index = ListModel.selection_index(entries, selected_key, fallback_index)
      return Cursor(T).new(-1, nil, -1) if index < 0
      entry = entries[index]
      Cursor(T).new(index, entry, yield entry, index)
    end

    def self.cursor_location(entries : Array(ListModel::Entry(T)), selected_key : String?,
                             fallback_index : Int32? = nil) : Cursor(T) forall T
      cursor_location(entries, selected_key, fallback_index) { |_entry, index| index }
    end

    def self.filter_summary(filter : String, total : Int32, shown : Int32,
                            noun : String = "row") : String
      plural = ->(count : Int32) { "#{count} #{noun}#{"s" unless count == 1}" }
      unless filter.empty?
        return shown > 0 ? "#{shown} of #{total} #{noun}s matching \"#{filter}\"." :
          "Nothing matching \"#{filter}\"."
      end
      "#{plural.call(total)}."
    end

    def self.filter_hint(policy : String, filtering : Bool,
                         typeahead : String = "type to filter",
                         explicit : String = "/: filter",
                         filtering_hint : String = "Enter/Esc: browse results  Ctrl+U: clear") : String
      return filtering ? filtering_hint : explicit if policy == EXPLICIT
      typeahead
    end
  end
end
