require "json"
require "set"
require "./blocks"

module Tawb
  module Frames
    MAX_DEPTH  =  4
    MAX_FRAMES = 25

    # Ask only for documents named by frame markers in the documents already
    # read. The tree itself is one cheap browser census; evaluating every one
    # of its hundreds of advertising contexts is the expensive part this
    # selection avoids.
    def self.collect_documents(tree : JSON::Any,
                               &items_for : String -> Array(JSON::Any)) : Hash(String, Array(JSON::Any))
      documents = {} of String => Array(JSON::Any)
      remaining = [MAX_FRAMES]
      collect_frame(tree, documents, 0, remaining, items_for)
      documents
    end

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

    private def self.frame_index(item : Hash(String, JSON::Any), fallback : Int32) : Int32
      item["frameIndex"]?.try(&.as_i?).try(&.to_i32) || fallback
    end

    private def self.collect_frame(tree : JSON::Any,
                                   documents : Hash(String, Array(JSON::Any)),
                                   depth : Int32, remaining : Array(Int32),
                                   items_for : String -> Array(JSON::Any)) : Nil
      object = tree.as_h
      frame_id = object["frame"].as_h["id"].as_s
      items = items_for.call(frame_id)
      documents[frame_id] = items
      return if depth >= MAX_DEPTH || remaining[0] <= 0

      children = object["childFrames"]?.try(&.as_a?) || [] of JSON::Any
      fallback = 0
      used = Set(Int32).new
      items.each do |item|
        value = item.as_h
        next unless value["role"]?.try(&.as_s?) == "iframe"
        index = frame_index(value, fallback)
        fallback = {fallback + 1, index + 1}.max
        next if used.includes?(index)
        child = children[index]?
        next unless child
        used << index
        remaining[0] -= 1
        collect_frame(child, documents, depth + 1, remaining, items_for)
        break if remaining[0] <= 0
      end
    end

    private def self.build_frame(tree : JSON::Any, depth : Int32, remaining : Array(Int32),
                                 blocks_for : String -> Array(JSON::Any)) : Array(JSON::Any)
      object = tree.as_h
      frame = object["frame"].as_h
      frame_id = frame["id"].as_s
      blocks = blocks_for.call(frame_id)
      return blocks if depth >= MAX_DEPTH || remaining[0] <= 0

      children = object["childFrames"]?.try(&.as_a?) || [] of JSON::Any
      fallback = 0
      output = [] of JSON::Any
      blocks.each do |block|
        output << block
        item = block.as_h["item"].as_h
        next unless item["role"]?.try(&.as_s?) == "iframe"
        index = frame_index(item, fallback)
        fallback = {fallback + 1, index + 1}.max
        child = children[index]?
        next unless child
        next if remaining[0] <= 0
        remaining[0] -= 1
        output.concat(build_frame(child, depth + 1, remaining, blocks_for))
      end
      output
    end
  end
end
