require "json"
require "./blocks"

module Tawb
  module Frames
    MAX_DEPTH  =  4
    MAX_FRAMES = 25

    def self.build(tree : JSON::Any, documents : Hash(String, Array(JSON::Any))) : Array(JSON::Any)
      remaining = [MAX_FRAMES]
      build_frame(tree, documents, 0, remaining)
    end

    private def self.build_frame(tree : JSON::Any, documents, depth : Int32, remaining : Array(Int32)) : Array(JSON::Any)
      object = tree.as_h
      frame = object["frame"].as_h
      frame_id = frame["id"].as_s
      blocks = Blocks.build(documents[frame_id]? || [] of JSON::Any)
      return blocks if depth >= MAX_DEPTH || remaining[0] <= 0

      children = object["childFrames"]?.try(&.as_a?) || [] of JSON::Any
      child_index = 0
      output = [] of JSON::Any
      blocks.each do |block|
        output << block
        role = block.as_h["item"].as_h["role"]?.try(&.as_s?)
        next unless role == "iframe"
        child = children[child_index]?
        child_index += 1
        next unless child
        remaining[0] -= 1
        output.concat(build_frame(child, documents, depth + 1, remaining))
      end
      output
    end
  end
end
