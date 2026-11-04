module Tawb
  # What makes a list a list.
  #
  # The browser's own lists, the dropdown of a select, and the keyboard wizard
  # all answer the same questions: which rows survive the filter, where a
  # section heading belongs, which row is selected while it does, and where a
  # movement key lands. None of that depends on what a row does when it is
  # activated, so it lives here rather than in each screen.
  #
  # A row is anything with `key` and `search`. `search` is what the filter
  # reads; it may include words the line does not show — a URL behind a title,
  # an action id or a binding behind a label.
  #
  # A section is `{ key, title, rows }`. A title makes a heading row visible
  # whenever the section still has a matching row. `pinned` rows are shown
  # whatever the filter says: the wizard's reset and exit rows are the reason.
  module ListModel
    # A row for the conformance surface and for screens with no richer row
    # type of their own. The wizard uses its own row object; the generic
    # functions only ask it for `key` and `search`.
    record Row, key : String, search : String

    record Section(T), key : String, title : String?, rows : Array(T)

    # What a screen may draw: a section heading, a row inside a section, or a
    # pinned row after every section.
    record Entry(T), kind : String, key : String, title : String?, row : T?

    def self.terms(filter : String) : Array(String)
      filter.downcase.split(/\s+/).reject(&.empty?)
    end

    # What the reader typed, against what they can see. Case is ignored,
    # because an address is lower case and a title is not, and nobody
    # filtering a list of pages means the difference. Every word must appear,
    # in any order: a search for "book mark" is a search for both words, not
    # for that exact phrase, so "wiki braille" finds the article without
    # knowing which order they come in.
    def self.matches?(haystack : String, filter : String) : Bool
      words = terms(filter)
      return true if words.empty?
      text = haystack.downcase
      words.all? { |word| text.includes?(word) }
    end

    def self.filter_rows(rows : Array(T), filter : String) : Array(T) forall T
      words = terms(filter)
      return rows.dup if words.empty?
      rows.select do |row|
        harvest = row.search.downcase
        words.all? { |word| harvest.includes?(word) }
      end
    end

    def self.visible_entries(sections : Array(Section(T)), pinned : Array(T),
                             filter : String) : Array(Entry(T)) forall T
      entries = [] of Entry(T)
      sections.each do |section|
        rows = filter_rows(section.rows, filter)
        next if rows.empty?
        if (title = section.title) && !title.empty?
          entries << Entry(T).new("heading", "section:#{section.key}", title, nil)
        end
        rows.each do |row|
          entries << Entry(T).new("row", row.key, nil, row)
        end
      end
      pinned.each do |row|
        entries << Entry(T).new("pinned", row.key, nil, row)
      end
      entries
    end

    def self.first_selectable(entries : Array(Entry(T))) : Int32 forall T
      entries.index { |entry| entry.kind != "heading" } || 0
    end

    # The nearest selectable entry to a position, used when the row the reader
    # was on has gone. A stable key is the first choice; this is what a screen
    # falls back to when there is no identity left to follow.
    def self.nearest_selectable(entries : Array(Entry(T)), index : Int32) : Int32 forall T
      return -1 if entries.empty?
      start = Math.max(0, Math.min(index, entries.size - 1))
      distance = 0
      while distance < entries.size
        before = start - distance
        if before >= 0 && entries[before].kind != "heading"
          return before
        end
        after = start + distance
        if after < entries.size && entries[after].kind != "heading"
          return after
        end
        distance += 1
      end
      first_selectable(entries)
    end

    # The key the selection should have after the rows or the filter changed.
    # The row the reader was on wins when it is still there; otherwise the
    # first row after its heading is a better landing place than the heading
    # itself, because that is where the next Enter or replacement acts. A
    # caller that knows the position still means the same place — a removed
    # row does — names it as `fallback_index`, and the nearest row to it wins.
    def self.selection_key(entries : Array(Entry(T)), preferred : String?,
                           fallback_index : Int32? = nil) : String? forall T
      return nil if entries.empty?
      if preferred && entries.any? { |entry| entry.key == preferred }
        return preferred
      end
      if fallback = fallback_index
        return entries[nearest_selectable(entries, fallback)].key
      end
      entries[first_selectable(entries)].key
    end

    def self.selection_index(entries : Array(Entry(T)), preferred : String?,
                             fallback_index : Int32? = nil) : Int32 forall T
      key = selection_key(entries, preferred, fallback_index)
      return -1 unless key
      entries.index { |entry| entry.key == key } || 0
    end

    # Where one movement lands. `page_size` is the screen's list height;
    # `first` is the very top entry, heading included, and `last` is the
    # pinned row at the bottom. `next` and `previous` step through headings as
    # ordinary rows so a reader can hear the section they are entering.
    def self.move_key(entries : Array(Entry(T)), selected_key : String?,
                      action : String, page_size : Int32 = 1) : String? forall T
      return nil if entries.empty?
      index = selection_index(entries, selected_key)
      target = case action
               when "next"           then index + 1
               when "previous"       then index - 1
               when "page-next"      then index + page_size
               when "page-previous"  then index - page_size
               when "first"          then 0
               when "last"           then entries.size - 1
               else                       index
               end
      target = Math.max(0, Math.min(target, entries.size - 1))
      entries[target].key
    end

    # The filter's own two edits, so every list removes a character the same
    # way. Crystal's `rchop` removes one code point, which is one character
    # to the reader and must be one Backspace.
    def self.append_filter(filter : String, text : String) : String
      filter + text
    end

    def self.backspace_filter(filter : String) : String
      filter.rchop
    end
  end
end
