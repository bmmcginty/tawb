require "json"

module Tawb
  module LynxNumber
    def self.parse(text : String) : Hash(String, JSON::Any)?
      match = /^(\d+)([gGpP]?)([+-]?)$/.match(text) || /^(\d+)([+-])([gGpP]?)$/.match(text)
      return nil unless match

      digits = match[1]
      suffixes = (match[2]? || "") + (match[3]? || "")
      command = if suffixes.matches?(/[pP]/)
                  "page"
                elsif suffixes.matches?(/[gG]/)
                  "move"
                else
                  "follow"
                end
      relative = suffixes.includes?('+') ? 1_i64 : suffixes.includes?('-') ? -1_i64 : 0_i64
      {
        "number"   => JSON::Any.new(digits.to_i64),
        "command"  => JSON::Any.new(command),
        "relative" => JSON::Any.new(relative),
      }
    end

    def self.relative(prompt : JSON::Any, amount : Int64, direction : Int64) : Int64
      object = prompt.as_h
      cursor = object["cursor"].as_i64
      column = object["col"]?.try(&.as_i64) || 0_i64
      targets = object["targets"]?.try(&.as_a) || [] of JSON::Any
      current = targets.select do |target|
        item = target.as_h
        line = item["line"].as_i64
        target_column = item["col"]?.try(&.as_i64) || 0_i64
        line < cursor || (line == cursor && target_column <= column)
      end.last?

      if current
        item = current.as_h
        number = item["number"].as_i64
        return number + direction * amount if item["line"].as_i64 == cursor
        return number + amount if direction > 0
        return number + 1 - amount
      end
      return amount if direction > 0
      targets.empty? ? -1_i64 : targets[0].as_h["number"].as_i64 - amount
    end
  end
end
