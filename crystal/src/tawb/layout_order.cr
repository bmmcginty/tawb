require "json"
require "set"

module Tawb
  # Diagnostic block permutations. These return the original block objects in
  # another order; identity and activation metadata are never reconstructed.
  module LayoutOrder
    ROW_TOLERANCE = 2.0
    OVERLAP_RATIO = 0.6

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

    def self.order(blocks : Array(T), mode : String = "default") : Array(T) forall T
      mode == "rectangle" ? order_rectangle(blocks) : blocks.dup
    end
  end
end
