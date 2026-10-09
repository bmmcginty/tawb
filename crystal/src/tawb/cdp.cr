require "json"
require "./address"
require "./transport"

module Tawb
  module Cdp
    EXTRACT_AX            = {{ read_file("#{__DIR__}/../../assets/extract_ax_items.js") }}
    EXTRACT_AX_WITH_PAIRS = EXTRACT_AX
      .sub(/^\/\/[^\n]*\n/, "")
      .sub(/\(\{layout:false\}\)\s*$/, "({layout:false,pairs:this})")

    record Target, id : String, web_socket_url : String
    record ShadowPair, host_id : Int64, root_id : Int64, kind : String

    class Page
      getter target : Target

      def initialize(@endpoint : String)
        body = Transport.http(@endpoint, "PUT", "/json/new?about%3Ablank")
        object = JSON.parse(body).as_h
        @target = Target.new(object["id"].as_s, object["webSocketDebuggerUrl"].as_s)
        @socket = Transport::WebSocket.new(@target.web_socket_url)
        @next_id = 0_i64
        @events = [] of JSON::Any
        @contexts = {} of String => Tuple(Int64, String?)
        @iframe_targets = Set(String).new
        @frame_sessions = {} of String => String
        command("Page.enable")
        command("Runtime.enable")
        command("Target.setDiscoverTargets", {
          "discover" => JSON::Any.new(true),
          "filter"   => JSON.parse(%([{"type":"iframe"}])),
        })
      end

      def navigate(url : String) : Nil
        # Page.enable can replay about:blank's completion while another
        # command is in flight. It predates this navigation and must never
        # satisfy the wait for the requested document.
        @events.reject! { |event| event.as_h["method"]?.try(&.as_s?) == "Page.domContentEventFired" }
        response = command("Page.navigate", {"url" => JSON::Any.new(url)})
        result = response.as_h["result"].as_h
        if error = result["errorText"]?.try(&.as_s?)
          raise IO::Error.new("navigation to #{url} failed: #{error}") unless error.empty?
        end
        wait_event("Page.domContentEventFired")
      end

      def accessibility_documents(layout = false) : Tuple(JSON::Any, Hash(String, Array(JSON::Any)))
        # Discovery events can still be in flight when the top document's DOM
        # event arrives. The listing is a synchronous census and closes that
        # race without recursively auto-attaching to renderer workers.
        targets = command("Target.getTargets").as_h["result"].as_h["targetInfos"].as_a
        targets.each do |target|
          info = target.as_h
          @iframe_targets << info["targetId"].as_s if info["type"]?.try(&.as_s?) == "iframe"
        end
        tree = command("Page.getFrameTree").as_h["result"].as_h["frameTree"]
        known_frames = frame_ids(tree).to_set
        # A tab session may omit an OOPIF from Page.getFrameTree. Its target
        # still has a frame tree of its own; add that root to the parent list
        # so the renderer can place it after the corresponding iframe marker.
        children = tree.as_h["childFrames"]?.try(&.as_a?)
        unless children
          children = [] of JSON::Any
          tree.as_h["childFrames"] = JSON::Any.new(children)
        end
        @iframe_targets.each do |target_id|
          next if known_frames.includes?(target_id)
          session_id = attach_frame(target_id)
          child_tree = command("Page.getFrameTree", session_id: session_id).as_h["result"].as_h["frameTree"]
          children << child_tree
        end

        documents = {} of String => Array(JSON::Any)
        frame_ids(tree).each_with_index do |frame_id, index|
          context = @contexts[frame_id]?
          if context
            documents[frame_id] = evaluate_items(context[0], context[1], layout)
          elsif index == 0
            documents[frame_id] = evaluate_items(nil, nil, layout)
          elsif @iframe_targets.includes?(frame_id)
            session_id = attach_frame(frame_id)
            documents[frame_id] = evaluate_items(nil, session_id, layout)
          end
        end
        {tree, documents}
      end

      def accessibility_items : Array(JSON::Any)
        evaluate_items(nil)
      end

      def close : Nil
        @socket.close
        Transport.http(@endpoint, "GET", "/json/close/#{@target.id}")
      rescue
        @socket.close rescue nil
      end

      def close_browser : Nil
        command("Browser.close")
      rescue
      ensure
        @socket.close rescue nil
      end

      private def command(method : String, params = {} of String => JSON::Any, session_id : String? = nil) : JSON::Any
        @next_id += 1
        wanted = @next_id
        request = {
          "id"     => JSON::Any.new(wanted),
          "method" => JSON::Any.new(method),
          "params" => JSON::Any.new(params),
        }
        request["sessionId"] = JSON::Any.new(session_id) if session_id
        @socket.send(request.to_json)
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          if object["id"]?.try(&.as_i64?) == wanted
            if error = object["error"]?
              raise IO::Error.new("CDP #{method} failed: #{error.to_json}")
            end
            return message
          end
          note_event(message)
          @events << message if object["method"]?
        end
      end

      private def attach_frame(frame_id : String) : String
        session = @frame_sessions[frame_id]?
        return session if session
        response = command("Target.attachToTarget", {
          "targetId" => JSON::Any.new(frame_id),
          "flatten"  => JSON::Any.new(true),
        })
        session = response.as_h["result"].as_h["sessionId"].as_s
        @frame_sessions[frame_id] = session
        command("Page.enable", session_id: session)
        command("Runtime.enable", session_id: session)
        session
      end

      private def evaluate_items(context_id : Int64?, session_id : String? = nil, layout = false) : Array(JSON::Any)
        expression = layout ? EXTRACT_AX.sub("{layout:false}", "{layout:true}") : EXTRACT_AX
        parameters = {
          "expression"    => JSON::Any.new(expression),
          "returnByValue" => JSON::Any.new(true),
          "awaitPromise"  => JSON::Any.new(true),
        }
        parameters["contextId"] = JSON::Any.new(context_id) if context_id
        response = command("Runtime.evaluate", parameters, session_id)
        result = response.as_h["result"].as_h
        if exception = result["exceptionDetails"]?
          raise IO::Error.new("accessibility extraction failed: #{exception.to_json}")
        end
        items = result["result"].as_h["value"].as_a
        needs_privileged = items.empty? || has_media_controls?(context_id, session_id)
        return items unless needs_privileged
        privileged_items(context_id, session_id, layout) || items
      end

      private def has_media_controls?(context_id : Int64?, session_id : String?) : Bool
        parameters = {
          "expression"    => JSON::Any.new("!!document.querySelector('video[controls],audio[controls]')"),
          "returnByValue" => JSON::Any.new(true),
        }
        parameters["contextId"] = JSON::Any.new(context_id) if context_id
        response = command("Runtime.evaluate", parameters, session_id)
        response.as_h["result"].as_h["result"].as_h["value"].as_bool
      rescue
        false
      end

      private def privileged_items(context_id : Int64?, session_id : String?, layout : Bool) : Array(JSON::Any)?
        document = command("DOM.getDocument", {
          "depth"  => JSON::Any.new(-1_i64),
          "pierce" => JSON::Any.new(true),
        }, session_id).as_h["result"].as_h["root"]
        pairs = [] of ShadowPair
        collect_shadow_pairs(document, pairs)
        return nil if pairs.empty?

        basket_params = {
          "expression" => JSON::Any.new("[]"),
        }
        basket_params["contextId"] = JSON::Any.new(context_id) if context_id
        basket_result = command("Runtime.evaluate", basket_params, session_id)
        basket = basket_result.as_h["result"].as_h["result"].as_h["objectId"].as_s
        registered = 0
        begin
          pairs.each do |pair|
            resolve_params = {"nodeId" => JSON::Any.new(pair.host_id)}
            resolve_params["executionContextId"] = JSON::Any.new(context_id) if context_id
            host = command("DOM.resolveNode", resolve_params, session_id)
              .as_h["result"].as_h["object"].as_h["objectId"].as_s
            resolve_params["nodeId"] = JSON::Any.new(pair.root_id)
            root = command("DOM.resolveNode", resolve_params, session_id)
              .as_h["result"].as_h["object"].as_h["objectId"].as_s
            arguments = [
              JSON::Any.new({"objectId" => JSON::Any.new(host)}),
              JSON::Any.new({"objectId" => JSON::Any.new(root)}),
              JSON::Any.new({"value" => JSON::Any.new(pair.kind)}),
            ]
            command("Runtime.callFunctionOn", {
              "objectId"            => JSON::Any.new(basket),
              "functionDeclaration" => JSON::Any.new("function (host, root, kind) { this.push([host, root, null, kind]); }"),
              "arguments"           => JSON::Any.new(arguments),
            }, session_id)
            registered += 1
          rescue
            # A node can disappear between the pierced listing and resolve.
          end
          return nil if registered == 0
          paired_expression = layout ? EXTRACT_AX_WITH_PAIRS.sub("layout:false", "layout:true") : EXTRACT_AX_WITH_PAIRS
          answer = command("Runtime.callFunctionOn", {
            "objectId"            => JSON::Any.new(basket),
            "functionDeclaration" => JSON::Any.new("function () { return #{paired_expression}; }"),
            "returnByValue"       => JSON::Any.new(true),
          }, session_id).as_h["result"].as_h
          if exception = answer["exceptionDetails"]?
            raise IO::Error.new("privileged accessibility extraction failed: #{exception.to_json}")
          end
          answer["result"].as_h["value"].as_a
        ensure
          command("Runtime.releaseObject", {"objectId" => JSON::Any.new(basket)}, session_id) rescue nil
        end
      rescue
        # A privileged scan is an enhancement. Keep the complete ordinary
        # extraction if the document navigated or a pierced node disappeared.
        nil
      end

      private def collect_shadow_pairs(node : JSON::Any, pairs : Array(ShadowPair)) : Nil
        object = node.as_h
        host_id = object["nodeId"]?.try(&.as_i64?)
        if host_id && (roots = object["shadowRoots"]?)
          roots.as_a.each do |root|
            root_object = root.as_h
            kind = root_object["shadowRootType"]?.try(&.as_s?) || "closed"
            if kind == "closed" || kind == "user-agent"
              pairs << ShadowPair.new(host_id, root_object["nodeId"].as_i64, kind)
            end
            collect_shadow_pairs(root, pairs)
          end
        end
        if content = object["contentDocument"]?
          collect_shadow_pairs(content, pairs)
        end
        if children = object["children"]?
          children.as_a.each { |child| collect_shadow_pairs(child, pairs) }
        end
      end

      private def frame_ids(tree : JSON::Any) : Array(String)
        ids = [tree.as_h["frame"].as_h["id"].as_s]
        if children = tree.as_h["childFrames"]?
          children.as_a.each { |child| ids.concat(frame_ids(child)) }
        end
        ids
      end

      private def note_event(message : JSON::Any) : Nil
        object = message.as_h
        case object["method"]?.try(&.as_s?)
        when "Target.targetCreated"
          info = object["params"].as_h["targetInfo"].as_h
          if info["type"]?.try(&.as_s?) == "iframe"
            @iframe_targets << info["targetId"].as_s
          end
        when "Target.targetDestroyed"
          @iframe_targets.delete(object["params"].as_h["targetId"].as_s)
        when "Runtime.executionContextCreated"
          context = object["params"].as_h["context"].as_h
          auxiliary = context["auxData"]?.try(&.as_h?)
          if auxiliary && auxiliary["isDefault"]?.try(&.as_bool?)
            if frame_id = auxiliary["frameId"]?.try(&.as_s?)
              @contexts[frame_id] = {context["id"].as_i64, object["sessionId"]?.try(&.as_s?)}
            end
          end
        when "Runtime.executionContextDestroyed"
          id = object["params"].as_h["executionContextId"].as_i64
          @contexts.reject! { |_frame, context| context[0] == id }
        when "Runtime.executionContextsCleared"
          @contexts.clear
        end
      end

      private def wait_event(method : String) : JSON::Any
        if index = @events.index { |event| event.as_h["method"]?.try(&.as_s?) == method }
          return @events.delete_at(index)
        end
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          note_event(message)
          return message if object["method"]?.try(&.as_s?) == method
          @events << message if object["method"]?
        end
      end
    end
  end
end
