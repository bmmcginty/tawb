require "./lynx_settings"

module Tawb
  # Lynx's single-screen Options menu, in Lynx's own lines.
  #
  # Every row here is a line a real Lynx prints on an 80-column terminal, with
  # the spacing and column positions it uses. Some rows carry more than one
  # option; each option's value is written at the column Lynx puts it, so what
  # a reader sees is the screen they know rather than a list of the same
  # settings.
  #
  # Choosing a letter does not change a value. It offers to: the value is
  # shown and the reader either changes it and presses RETURN or leaves it
  # with q. The words for all of that are Lynx's too.
  module LynxOptions
    # One value an option can hold: the raw value the preferences store and
    # the words the screen shows for it.
    record Choice, value : JSON::Any, label : String

    record Option, letter : String, label : String, fixed : String?,
      choices : Array(Choice)?, key : String?, boolean : Bool,
      side_effects : Proc(Hash(String, JSON::Any), Nil)?

    record Field, letter : String, column : Int32, start : Int32, stop : Int32
    record Line, text : String, fields : Array(Field)
    record Position, row : Int32, column : Int32, field : Field

    private record ScreenRow, text : String?, fields : Array(Tuple(String, Int32, String))?

    private def self.text_row(text : String) : ScreenRow
      ScreenRow.new(text, nil)
    end

    private def self.field_row(fields : Array(Tuple(String, Int32, String))) : ScreenRow
      ScreenRow.new(nil, fields)
    end

    KEYPAD_CHOICES = [
      {"NUMBERS_AS_ARROWS", "Numbers act as arrows"},
      {"LINKS_ARE_NUMBERED", "Links are numbered"},
      {"FIELDS_ARE_NUMBERED", "Form fields are numbered"},
      {"LINKS_AND_FIELDS_ARE_NUMBERED", "Links and form fields are numbered"},
    ]

    # A boolean is a list of two values like any other; what makes it
    # different is that any key moves to the next one, where a longer list is
    # walked with the arrow keys.
    private ON_OFF = [Choice.new(JSON::Any.new(false), "OFF"), Choice.new(JSON::Any.new(true), "ON")]
    SEARCH_CHOICES = [
      {"CASE_INSENSITIVE", "CASE INSENSITIVE"},
      {"CASE_SENSITIVE", "CASE SENSITIVE"},
    ]

    # Keypad mode and the numbering preferences it drives are one setting with
    # two derived halves, which is what Lynx's set_numbers_as_arrows does.
    private def self.keypad_side_effects(preferences : Hash(String, JSON::Any)) : Nil
      mode = preferences["keypadMode"]?.try(&.as_s?) || ""
      preferences["numberLinks"] = JSON::Any.new(
        mode == "LINKS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
      preferences["numberFields"] = JSON::Any.new(
        mode == "FIELDS_ARE_NUMBERED" || mode == "LINKS_AND_FIELDS_ARE_NUMBERED")
    end

    # `fixed` is a value TAWB has no setting for and does not pretend to: what
    # Lynx would show is shown, and choosing it says where the option really
    # lives.
    OPTIONS = [
      Option.new("E", "(E)ditor", "NONE", nil, nil, false, nil),
      Option.new("D", "(D)ISPLAY variable", "NONE", nil, nil, false, nil),
      Option.new("L", "mu(L)ti-bookmarks", "OFF", nil, nil, false, nil),
      Option.new("B", "(B)ookmark file", "lynx_bookmarks.html", nil, nil, false, nil),
      Option.new("F", "(F)TP sort criteria", "By Filename", nil, nil, false, nil),
      Option.new("P", "(P)ersonal mail address", "NONE", nil, nil, false, nil),
      Option.new("S", "(S)earching type", nil,
        SEARCH_CHOICES.map { |pair| Choice.new(JSON::Any.new(pair[0]), pair[1]) },
        "searchCase", false, nil),
      Option.new("G", "preferred document lan(G)uage", "en", nil, nil, false, nil),
      Option.new("H", "preferred document c(H)arset", "NONE", nil, nil, false, nil),
      Option.new("C", "display (C)haracter set", "Western (ISO-8859-1)", nil, nil, false, nil),
      Option.new("O", "Raw 8-bit or CJK m(O)de", "ON", nil, nil, false, nil),
      Option.new("&", "show color (&)", "ON", nil, nil, false, nil),
      Option.new("V", "(V)I keys", "OFF", nil, nil, false, nil),
      Option.new("M", "e(M)acs keys", "OFF", nil, nil, false, nil),
      Option.new("W", "sho(W) dot files", "OFF", nil, nil, false, nil),
      Option.new("T", "popups for selec(T) fields", "ON", nil, nil, false, nil),
      Option.new("@", "show cursor (@)", nil, ON_OFF, "showCursor", true, nil),
      Option.new("K", "(K)eypad mode", nil,
        KEYPAD_CHOICES.map { |pair| Choice.new(JSON::Any.new(pair[0]), pair[1]) },
        "keypadMode", false, ->keypad_side_effects(Hash(String, JSON::Any))),
      Option.new("N", "li(N)e edit style", "Default Binding", nil, nil, false, nil),
      Option.new("I", "l(I)st directory style", "Mixed style", nil, nil, false, nil),
      Option.new("U", "(U)ser mode", "Novice", nil, nil, false, nil),
      Option.new("!", "verbose images (!)", "ON", nil, nil, false, nil),
      Option.new("A", "user (A)gent", "TAWB", nil, nil, false, nil),
    ]

    private BY_LETTER = OPTIONS.to_h { |option| {option.letter, option} }

    ANY_KEY_CHANGE  = "Hit any key to change value; RETURN to accept."
    VALUE_ACCEPTED  = "Value accepted!"
    CANCELLED       = "Cancelled!!!"
    CHOICE_LIST     = "(Choice list) Hit return and use arrow keys and return to select option."
    SELECT_LINE     = "  Select capital letter of option line, '>' to save, or 'r' to return to Lynx."
    COMMAND_PROMPT  = "Command: "
    NOT_CHANGEABLE  = "That option belongs to Lynx or the browser and is not changed by TAWB."

    # The screen, one entry per row, in the order Lynx draws it. A row with
    # `fields` holds one or more options: [letter, valueColumn, prefix], where
    # the prefix is everything Lynx prints before that option's value —
    # including the spaces that follow the value before it.
    SCREEN_ROWS = [
      text_row("              Options Menu (TAWB Lynx interface)"),
      text_row(""),
      field_row([{"E", 36, "     (E)ditor                     : "}]),
      field_row([{"D", 36, "     (D)ISPLAY variable           : "}]),
      field_row([{"L", 24, "     mu(L)ti-bookmarks: "}, {"B", 51, "       (B)ookmark file: "}]),
      field_row([{"F", 36, "     (F)TP sort criteria          : "}]),
      field_row([{"P", 36, "     (P)ersonal mail address      : "}]),
      field_row([{"S", 36, "     (S)earching type             : "}]),
      field_row([{"G", 36, "     preferred document lan(G)uage: "}]),
      field_row([{"H", 36, "     preferred document c(H)arset : "}]),
      field_row([{"C", 36, "     display (C)haracter set      : "}]),
      field_row([{"O", 36, "     Raw 8-bit or CJK m(O)de      : "}, {"&", 62, "      show color (&)  : "}]),
      field_row([{"V", 16, "     (V)I keys: "}, {"M", 36, "   e(M)acs keys: "}, {"W", 62, "     sho(W) dot files: "}]),
      field_row([{"T", 36, "     popups for selec(T) fields   : "}, {"@", 62, "      show cursor (@) : "}]),
      field_row([{"K", 36, "     (K)eypad mode                : "}]),
      field_row([{"N", 36, "     li(N)e edit style            : "}]),
      text_row(""),
      field_row([{"I", 36, "     l(I)st directory style       : "}]),
      field_row([{"U", 36, "     (U)ser mode                  : "}, {"!", 71, "        verbose images (!) : "}]),
      field_row([{"A", 36, "     user (A)gent                 : "}]),
      # Lynx wraps a long user-agent string onto this row. TAWB's is one
      # word, so the row stays blank and the rows below keep their Lynx
      # positions.
      text_row(""),
      text_row(SELECT_LINE),
    ] of ScreenRow

    # The row the Command prompt is on, counting the screen's own rows from
    # zero.
    COMMAND_ROW = SCREEN_ROWS.size

    def self.option_for_letter(letter : String) : Option?
      BY_LETTER[letter]?
    end

    def self.choice_index(option : Option, preferences : Hash(String, JSON::Any)) : Int32
      choices = option.choices
      return -1 unless choices
      current = preferences[option.key.not_nil!]?
      choices.index { |choice| current && choice.value == current } || -1
    end

    def self.option_value(option : Option, preferences : Hash(String, JSON::Any)) : String
      return option.fixed.not_nil! if option.fixed
      index = choice_index(option, preferences)
      choices = option.choices.not_nil!
      choices[index < 0 ? 0 : index].label
    end

    def self.apply_choice(option : Option, preferences : Hash(String, JSON::Any), index : Int32) : Nil
      choices = option.choices.not_nil!
      preferences[option.key.not_nil!] = choices[index].value
      option.side_effects.try(&.call(preferences))
    end

    # The screen for these preferences: one line per row, and where on each
    # line every option's value begins and ends. Nothing here knows about
    # highlighting or cursors; that is the terminal's business.
    def self.screen_lines(preferences : Hash(String, JSON::Any) = {} of String => JSON::Any) : Array(Line)
      SCREEN_ROWS.map do |row|
        if row.text
          Line.new(row.text.not_nil!, [] of Field)
        else
          text = ""
          fields = [] of Field
          row.fields.not_nil!.each do |entry|
            letter, column, prefix = entry
            text += prefix
            start = text.size
            text += option_value(option_for_letter(letter).not_nil!, preferences)
            fields << Field.new(letter, column, start, text.size)
          end
          Line.new(text, fields)
        end
      end
    end

    # Where an option's value is on the screen: its row, and the column its
    # value starts at.
    def self.option_position(lines : Array(Line), letter : String) : Position?
      lines.each_with_index do |line, row|
        field = line.fields.find { |candidate| candidate.letter == letter }
        return Position.new(row, field.start, field) if field
      end
      nil
    end

    def self.persistable_options(preferences : Hash(String, JSON::Any)) : Hash(String, JSON::Any)
      preferences.select { |name, _| LynxSettings::KNOWN_SETTINGS.includes?(name) }
    end
  end
end
