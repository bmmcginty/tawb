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
      if explicit && (enter || escape)
        return Edit.new(true, false, true, filter, false)
      end
      if clear
        return Edit.new(true, filter != "", false, "", filtering)
      end
      if backspace
        return Edit.new(true, !filter.empty?, false, ListModel.backspace_filter(filter), filtering)
      end
      if character
        return Edit.new(true, true, false, ListModel.append_filter(filter, chunk), filtering)
      end
      Edit.new(false, false, false, filter, filtering)
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
