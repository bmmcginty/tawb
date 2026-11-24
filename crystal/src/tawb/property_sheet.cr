require "json"
require "./list_model"
require "./list_screen"

module Tawb
  # A property sheet is a list screen whose rows name a property and show its
  # current value. It shares the list state, movement and cursor contract with
  # the library and every list; a choice row opens the same kind of nested list.
  class PropertySheet
    class PropertyRow
      getter id : String
      getter label : String
      getter kind : String
      getter choices : Array(String)?
      getter command : String?
      getter note : String
      property value : String

      def initialize(@id : String, @label : String, @value : String, @kind : String,
                     @choices : Array(String)? = nil, @command : String? = nil,
                     @note : String = "")
      end

      def key : String
        @id
      end

      def search : String
        "#{@label} #{@value}"
      end
    end

    record ChoiceRow, key : String, search : String

    class ListState(T)
      property selected_key : String?
      property fallback_index : Int32

      def initialize(@selected_key : String? = nil, @fallback_index : Int32 = 0)
      end

      def entries(rows : Array(T)) : Array(ListModel::Entry(T)) forall T
        ListModel.visible_entries(
          [ListModel::Section(T).new("rows", nil, rows)],
          [] of T, "")
      end

      def visible(rows : Array(T)) : Array(T) forall T
        entries(rows).map { |entry| entry.row.not_nil! }
      end

      def settle(rows : Array(T)) : Int32 forall T
        held = entries(rows)
        if held.empty?
          @selected_key = nil
          return -1
        end
        @selected_key = ListModel.selection_key(held, @selected_key, @fallback_index)
        index = ListModel.selection_index(held, @selected_key)
        @fallback_index = Math.max(0, index)
        index
      end

      def move(action : String, rows : Array(T), page_size : Int32) : Nil forall T
        held = entries(rows)
        index = settle(rows)
        return if index < 0
        @selected_key = ListModel.move_key(held, @selected_key, action, page_size)
        @fallback_index = Math.max(0, ListModel.selection_index(held, @selected_key))
      end
    end

    getter title : String
    getter rows : Array(PropertyRow)
    property status : String
    property choosing : {row: PropertyRow, list: ListState(ChoiceRow)}?

    def initialize(title : String, rows : Array(PropertyRow), action_label : String? = nil)
      @title = title
      @rows = rows
      if action_label
        @rows << PropertyRow.new("apply", action_label, "", "action", nil, "apply")
      end
      @status = ""
      @choosing = nil
      @list = ListState(PropertyRow).new
      @list.settle(@rows)
    end

    def self.row(id : String, label : String, value : String = "", kind : String = "text",
                 choices : Array(String)? = nil, command : String? = nil,
                 note : String = "") : PropertyRow
      PropertyRow.new(id, label, value, kind, choices, command, note)
    end

    def entries : Array(ListModel::Entry(PropertyRow))
      @list.entries(@rows)
    end

    def index : Int32
      @list.settle(@rows)
    end

    def row : PropertyRow?
      at = index
      at < 0 ? nil : @rows[at]?
    end

    def choices : Array(ChoiceRow)
      choosing = @choosing
      return [] of ChoiceRow unless choosing
      choosing[:list].visible(choice_rows(choosing[:row]))
    end

    def choice_index : Int32
      choosing = @choosing
      return -1 unless choosing
      choosing[:list].settle(choice_rows(choosing[:row]))
    end

    def begin_choice(row : PropertyRow) : Nil
      selected = row.choices.try(&.index(row.value)) || 0
      @choosing = {row: row, list: ListState(ChoiceRow).new(nil, Math.max(0, selected))}
    end

    def end_choice : Nil
      @choosing = nil
    end

    def move(action : String) : Nil
      choosing = @choosing
      if choosing
        choosing[:list].move(action, choice_rows(choosing[:row]), 10)
      else
        @list.move(action, @rows, 10)
      end
    end

    def handle(action : String) : Hash(String, JSON::Any)
      result = {} of String => JSON::Any
      if choosing = @choosing
        if action == "close-popup"
          end_choice
          return result(true)
        end
        if movement = ListScreen.movement(action)
          move(movement)
          return result(true)
        end
        if action == "activate"
          at = choice_index
          held = choices
          if at >= 0 && (choice = held[at]?)
            choosing[:row].value = choice.search
            end_choice
            result = result(true)
            result["changed"] = JSON::Any.new(true)
            return result
          end
          result = result(true)
          result["message"] = JSON::Any.new("No value to choose.")
          return result
        end
        return result(true)
      end
      if action == "close-popup"
        result = result(true)
        result["command"] = JSON::Any.new("cancel")
        return result
      end
      if movement = ListScreen.movement(action)
        move(movement)
        return result(true)
      end
      if action == "focus-next" || action == "focus-previous"
        move(action == "focus-next" ? "next" : "previous")
        return result(true)
      end
      return result(false) unless action == "activate"
      row = row()
      unless row
        result = result(true)
        result["message"] = JSON::Any.new("No property is selected.")
        return result
      end
      case row.not_nil!.kind
      when "readonly"
        result = result(true)
        result["message"] = JSON::Any.new("#{row.not_nil!.label} comes from the page and is read-only.")
        return result
      when "action"
        result = result(true)
        result["command"] = JSON::Any.new(row.not_nil!.command || "apply")
        return result
      when "boolean"
        row.not_nil!.value = row.not_nil!.value == "yes" ? "no" : "yes"
        result = result(true)
        result["changed"] = JSON::Any.new(true)
        return result
      when "choice"
        choices = row.not_nil!.choices
        if choices.nil? || choices.empty?
          result = result(true)
          result["message"] = JSON::Any.new("No choices are available.")
          return result
        end
        begin_choice(row.not_nil!)
        return result(true)
      else
        result = result(true)
        result["edit"] = JSON::Any.new(row.not_nil!.id)
        return result
      end
    end

    def values : Hash(String, JSON::Any)
      values = {} of String => JSON::Any
      @rows.each do |row|
        next if row.kind == "action"
        values[row.id] = JSON::Any.new(row.value)
      end
      values
    end

    def snapshot : JSON::Any
      lines = [@title]
      cursor = 0
      if choosing = @choosing
        lines << display(choosing[:row]) << ""
        held = choices
        held.each { |entry| lines << entry.search }
        target = ListScreen.cursor_location(
          choosing[:list].entries(choice_rows(choosing[:row])),
          choosing[:list].selected_key, choosing[:list].fallback_index
        ) { |_entry, index| 3 + index }
        cursor = target.location >= 0 ? target.location : 2
      else
        @rows.each { |row| lines << display(row) }
        target = ListScreen.cursor_location(entries, @list.selected_key, @list.fallback_index) do |_entry, index|
          1 + index
        end
        cursor = target.location >= 0 ? target.location : 1
      end
      JSON::Any.new({
        "title" => JSON::Any.new(@title), "status" => JSON::Any.new(@status),
        "cursor" => JSON::Any.new(cursor.to_i64),
        "lines" => JSON::Any.new(lines.map { |line| JSON::Any.new(line) }),
      })
    end

    def self.display(row : PropertyRow) : String
      return "[#{row.label}]" if row.kind == "action"
      value = row.value.empty? ? "(none)" : row.value
      return "#{row.label}: #{value} (source)" if row.kind == "readonly"
      "#{row.label}: #{value}"
    end

    private def display(row : PropertyRow) : String
      PropertySheet.display(row)
    end

    private def result(handled : Bool) : Hash(String, JSON::Any)
      {"handled" => JSON::Any.new(handled)}
    end

    private def choice_rows(row : PropertyRow) : Array(ChoiceRow)
      (row.choices || [] of String).map_with_index do |choice, index|
        ChoiceRow.new("choice:#{index}", choice)
      end
    end
  end
end
