require "json"
require "set"

module Tawb
  # Diagnostic block permutations. These return the original block objects in
  # another order; identity and activation metadata are never reconstructed.
  module LayoutOrder
    ROW_TOLERANCE = 2.0
    OVERLAP_RATIO = 0.6

    # What the reader hears for each order. The action id carries the same
    # name, so a command typed as layout-rectangle and the status line a
    # moment later call the mode the same thing.
    LABELS = {
      "default"   => "document order",
      "container" => "container order",
      "rectangle" => "rectangle order",
    }

    record Rect, top : Float64, left : Float64, width : Float64, height : Float64 do
      def right : Float64
        left + width
      end

      def bottom : Float64
        top + height
      end
    end

    record Entry(T), block : T, index : Int32, rect : Rect

    private def self.number(object : Hash(String, JSON::Any), key : String) : Float64?
      value = object[key]?
      value.try(&.as_f?) || value.try(&.as_i?).try(&.to_f64)
    end

    def self.rect_of(block) : Rect?
      item = block.item.as_h?
      visual = item.try(&.["visual"]?).try(&.as_h?)
      object = visual.try(&.["rect"]?).try(&.as_h?)
      return nil unless object
      top = number(object, "top")
      left = number(object, "left")
      width = number(object, "width")
      height = number(object, "height")
      return nil unless top && left && width && height
      return nil unless top.finite? && left.finite? && width.finite? && height.finite?
      return nil if width <= 0 || height <= 0
      Rect.new(top, left, width, height)
    end

    private def self.visual_string(block, key : String, fallback : String) : String
      block.item.as_h?.try(&.["visual"]?).try(&.as_h?).try(&.[key]?).try(&.as_s?) || fallback
    end

    private def self.direction(block) : String
      visual_string(block, "direction", "ltr") == "rtl" ? "rtl" : "ltr"
    end

    private def self.writing_mode(block) : String
      visual_string(block, "writingMode", "horizontal-tb")
    end

    private def self.overlap_ratio(a : Rect, b : Rect) : Float64
      width = Math.max(0.0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      height = Math.max(0.0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      smaller = Math.min(a.width * a.height, b.width * b.height)
      smaller > 0 ? (width * height) / smaller : 0.0
    end

    private def self.same_band?(start : Float64, size : Float64, entry, vertical : Bool) : Bool
      value = vertical ? entry.rect.left : entry.rect.top
      own_size = vertical ? entry.rect.width : entry.rect.height
      tolerance = Math.max(ROW_TOLERANCE, Math.min(8.0, Math.min(size, own_size) / 2.0))
      (value - start).abs <= tolerance
    end

    def self.rectangle_entries(blocks : Array(T)) : Array(Entry(T)) forall T
      placed = [] of Entry(T)
      blocks.each_with_index do |block, index|
        if rect = rect_of(block)
          placed << Entry(T).new(block, index.to_i32, rect)
        end
      end
      return placed if placed.size < 2

      mode = writing_mode(placed.first.block)
      vertical = mode.starts_with?("vertical")
      sign = vertical && mode.ends_with?("-rl") ? -1.0 : 1.0
      placed.sort! do |a, b|
        av = vertical ? a.rect.left : a.rect.top
        bv = vertical ? b.rect.left : b.rect.top
        compared = sign * (av - bv)
        compared == 0 ? a.index <=> b.index : (compared < 0 ? -1 : 1)
      end

      rows = [] of Array(Entry(T))
      starts = [] of Float64
      sizes = [] of Float64
      placed.each do |entry|
        if rows.empty? || !same_band?(starts.last, sizes.last, entry, vertical)
          rows << [] of Entry(T)
          starts << (vertical ? entry.rect.left : entry.rect.top)
          sizes << (vertical ? entry.rect.width : entry.rect.height)
        end
        rows.last << entry
      end

      rows.each do |row|
        inline_sign = !vertical && direction(row.first.block) == "rtl" ? -1.0 : 1.0
        row.sort! do |a, b|
          if overlap_ratio(a.rect, b.rect) >= OVERLAP_RATIO
            a.index <=> b.index
          else
            av = vertical ? a.rect.top : a.rect.left
            bv = vertical ? b.rect.top : b.rect.left
            compared = inline_sign * (av - bv)
            compared == 0 ? a.index <=> b.index : (compared < 0 ? -1 : 1)
          end
        end
      end
      rows.flatten
    end

    def self.attach_unplaced(blocks : Array(T), ordered : Array(Entry(T))) : Array(T) forall T
      return blocks.dup if ordered.empty?
      placed = ordered.map(&.index).to_set
      leading = [] of T
      after = Hash(Int32, Array(T)).new { |hash, key| hash[key] = [] of T }
      anchor = nil.as(Int32?)
      blocks.each_with_index do |block, index|
        at = index.to_i32
        if placed.includes?(at)
          anchor = at
        elsif previous = anchor
          after[previous] << block
        else
          leading << block
        end
      end
      out = leading
      ordered.each do |entry|
        out << entry.block
        out.concat(after[entry.index]) if after.has_key?(entry.index)
      end
      out
    end

    def self.order_rectangle(blocks : Array(T)) : Array(T) forall T
      attach_unplaced(blocks, rectangle_entries(blocks))
    end

    class Container
      property id : Int64
      property depth : Int32
      property kind : String
      property direction : String
      property writing_mode : String
      property first : Int32

      def initialize(@id, @depth, @kind, @direction, @writing_mode, @first)
      end
    end

    class Group(T)
      property id : Int64
      property first : Int32
      property rect : Rect?
      getter blocks : Array(T)

      def initialize(@id, @first, @rect)
        @blocks = [] of T
      end
    end

    private def self.path_of(block) : Array(JSON::Any)
      block.item.as_h?.try(&.["visual"]?).try(&.as_h?).try(&.["path"]?).try(&.as_a?) || [] of JSON::Any
    end

    private def self.raw_rect(value : JSON::Any?) : Rect?
      object = value.try(&.as_h?)
      return nil unless object
      top = number(object, "top")
      left = number(object, "left")
      width = number(object, "width")
      height = number(object, "height")
      return nil unless top && left && width && height
      return nil unless top.finite? && left.finite? && width.finite? && height.finite?
      return nil if width <= 0 || height <= 0
      Rect.new(top, left, width, height)
    end

    private def self.group_rows(groups : Array(Group(T)), container : Container) : Array(Group(T)) forall T
      return groups.dup if groups.size < 2
      vertical = container.writing_mode.starts_with?("vertical")
      sign = vertical && container.writing_mode.ends_with?("-rl") ? -1.0 : 1.0
      sorted = groups.sort do |a, b|
        ar = a.rect.not_nil!
        br = b.rect.not_nil!
        av = vertical ? ar.left : ar.top
        bv = vertical ? br.left : br.top
        compared = sign * (av - bv)
        compared == 0 ? a.first <=> b.first : (compared < 0 ? -1 : 1)
      end

      rows = [] of Array(Group(T))
      starts = [] of Float64
      sizes = [] of Float64
      sorted.each do |group|
        rect = group.rect.not_nil!
        value = vertical ? rect.left : rect.top
        size = vertical ? rect.width : rect.height
        tolerance = rows.empty? ? 0.0 : Math.max(ROW_TOLERANCE,
          Math.min(8.0, Math.min(sizes.last, size) / 2.0))
        if rows.empty? || (value - starts.last).abs > tolerance
          rows << [] of Group(T)
          starts << value
          sizes << size
        end
        rows.last << group
      end

      rows.each do |row|
        inline_sign = !vertical && container.direction == "rtl" ? -1.0 : 1.0
        row.sort! do |a, b|
          ar = a.rect.not_nil!
          br = b.rect.not_nil!
          if overlap_ratio(ar, br) >= OVERLAP_RATIO
            a.first <=> b.first
          else
            av = vertical ? ar.top : ar.left
            bv = vertical ? br.top : br.left
            compared = inline_sign * (av - bv)
            compared == 0 ? a.first <=> b.first : (compared < 0 ? -1 : 1)
          end
        end
      end
      rows.flatten
    end

    private def self.order_groups(groups : Array(Group(T)), container : Container) : Array(Group(T)) forall T
      placed = groups.select(&.rect)
      return groups if placed.size < 2
      ordered = if container.kind == "columns"
                  sign = container.direction == "rtl" ? -1.0 : 1.0
                  placed.sort do |a, b|
                    ar = a.rect.not_nil!
                    br = b.rect.not_nil!
                    horizontal = sign * (ar.left - br.left)
                    if horizontal == 0
                      vertical = ar.top - br.top
                      vertical == 0 ? a.first <=> b.first : (vertical < 0 ? -1 : 1)
                    else
                      horizontal < 0 ? -1 : 1
                    end
                  end
                else
                  group_rows(placed, container)
                end
      placed_ids = ordered.map(&.id).to_set
      leading = [] of Group(T)
      after = Hash(Int64, Array(Group(T))).new { |hash, key| hash[key] = [] of Group(T) }
      anchor = nil.as(Int64?)
      groups.each do |group|
        if placed_ids.includes?(group.id)
          anchor = group.id
        elsif previous = anchor
          after[previous] << group
        else
          leading << group
        end
      end
      out = leading
      ordered.each do |group|
        out << group
        out.concat(after[group.id]) if after.has_key?(group.id)
      end
      out
    end

    def self.container_census(blocks : Array(T)) : Array(Container) forall T
      containers = {} of Int64 => Container
      blocks.each_with_index do |block, index|
        path_of(block).each_with_index do |raw, depth|
          entry = raw.as_h?
          next unless entry
          id = entry["container"]?.try(&.as_i?)
          group = entry["group"]?.try(&.as_i?)
          next unless id && group
          if container = containers[id]?
            container.depth = Math.max(container.depth, depth.to_i32)
          else
            containers[id] = Container.new(
              id, depth.to_i32,
              entry["kind"]?.try(&.as_s?) || "grid",
              entry["direction"]?.try(&.as_s?) == "rtl" ? "rtl" : "ltr",
              entry["writingMode"]?.try(&.as_s?) || "horizontal-tb",
              index.to_i32)
          end
        end
      end
      containers.values.sort do |a, b|
        depth = b.depth <=> a.depth
        depth == 0 ? b.first <=> a.first : depth
      end
    end

    def self.apply_container(blocks : Array(T), container : Container) : Array(T) forall T
      slots = [] of Int32
      groups = {} of Int64 => Group(T)
      blocks.each_with_index do |block, index|
        entry = path_of(block).compact_map(&.as_h?).find do |one|
          one["container"]?.try(&.as_i?) == container.id
        end
        next unless entry
        id = entry["group"]?.try(&.as_i?)
        next unless id
        slots << index.to_i32
        group = groups[id]? || begin
          made = Group(T).new(id, index.to_i32, raw_rect(entry["rect"]?))
          groups[id] = made
          made
        end
        group.blocks << block
      end
      return blocks if groups.size < 2
      original = groups.values.sort_by(&.first)
      flattened = order_groups(original, container).flat_map(&.blocks)
      out = blocks.dup
      slots.each_with_index { |slot, index| out[slot] = flattened[index] }
      out
    end

    def self.order_container(blocks : Array(T)) : Array(T) forall T
      ordered_blocks = blocks.dup
      container_census(blocks).each do |container|
        ordered_blocks = apply_container(ordered_blocks, container)
      end
      ordered_blocks
    end

    def self.order(blocks : Array(T), mode : String = "default") : Array(T) forall T
      case mode
      when "rectangle" then order_rectangle(blocks)
      when "container" then order_container(blocks)
      else                  blocks.dup
      end
    end
  end
end
