require "json"
require "./blocks"

module Tawb
  module Frames
    MAX_DEPTH  =  4
    MAX_FRAMES = 25

    def self.build(tree : JSON::Any, documents : Hash(String, Array(JSON::Any))) : Array(JSON::Any)
      assemble(tree) do |frame_id|
        blocks = Blocks.build(documents[frame_id]? || [] of JSON::Any)
        # An accessibility item carries no element reference, so it records
        # the document it came from: activation resolves its role and name
        # against that document and not against the tab's top one.
        blocks.each do |block|
          item = block.as_h["item"]?.try(&.as_h?) || next
          item["frame"] = JSON::Any.new(frame_id)
        end
        blocks
      end
    end

    # The same assembly for a view that answers in blocks already rather than
    # in accessibility items: the walk is told how to ask each document, and
    # places what comes back after that document's own iframe marker.
    def self.assemble(tree : JSON::Any, &blocks_for : String -> Array(JSON::Any)) : Array(JSON::Any)
      remaining = [MAX_FRAMES]
      build_frame(tree, 0, remaining, blocks_for)
    end

    private def self.build_frame(tree : JSON::Any, depth : Int32, remaining : Array(Int32),
                                 blocks_for : String -> Array(JSON::Any)) : Array(JSON::Any)
      object = tree.as_h
      frame = object["frame"].as_h
      frame_id = frame["id"].as_s
      blocks = blocks_for.call(frame_id)
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
        output.concat(build_frame(child, depth + 1, remaining, blocks_for))
      end
      output
    end
  end
end
