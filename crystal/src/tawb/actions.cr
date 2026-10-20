require "json"
require "./aria"
require "./bidi"
require "./firefox_driver"

module Tawb
  # The page-acting half (src/core.js's activateHandle, realClickHandle and
  # hover over src/click.js). Activation here goes through the element's own
  # default action, aimed the way a mouse would be; a real click and a hover
  # go through the browser's own input pipeline as trusted pointer actions,
  # named by shared reference so the browser computes the element's own
  # centre point and hits what we meant. The reachability check each of them
  # runs first is the page's own prepareRealClick, embedded as an asset so
  # both runtimes put the same question in front of the page.
  module Actions
    # The asset files carry a generated-from header for readers; the wire
    # wants the function source alone — the same bytes the JavaScript driver
    # puts there with Function.prototype.toString.
    def self.asset_source(raw : String) : String
      raw.lines[1..].join("\n")
    end

    PREPARE_REAL_CLICK = asset_source(
      {{ read_file("#{__DIR__}/../../assets/prepare_real_click.js") }})
    CLICK_THROUGH = asset_source(
      {{ read_file("#{__DIR__}/../../assets/click_through.js") }})
    SUBMITS_AUTOFILLED = asset_source(
      {{ read_file("#{__DIR__}/../../assets/submits_autofilled.js") }})
    SLIDER_STATE = asset_source(
      {{ read_file("#{__DIR__}/../../assets/slider_state.js") }})
    SLIDER_GEOMETRY = asset_source(
      {{ read_file("#{__DIR__}/../../assets/slider_geometry.js") }})
    FOCUS_CONTROL = "(el) => { el.focus(); return true; }"
    FOCUS_ELEMENT = "(el) => el.focus()"
    # The page-side half of the place keeper's element search (src/place.js
    # describeElement and locateElement). DESCRIBE_ELEMENT runs against the
    # element the reader is standing on and answers a label and a position in
    # document order. LOCATE_ELEMENT runs after the new view has been built
    # and answers which entry of that view's node array the same element is
    # now.
    DESCRIBE_ELEMENT = asset_source(
      {{ read_file("#{__DIR__}/../../assets/describe_element.js") }})
    LOCATE_ELEMENT = asset_source(
      {{ read_file("#{__DIR__}/../../assets/locate_element.js") }})

    # What the page says about the element the reader is on:
    # {"label", "ordinal", "total"}, or nil when the reference is not an
    # element the page will describe.
    def self.describe_element(handle : Engine::Handle) : JSON::Any?
      described = handle.evaluate(DESCRIBE_ELEMENT)
      described.raw.nil? ? nil : described
    end

    # Which entry of `array_name` the held element is now:
    # {"index", "exact"}, or nil when the element is not in that view's node
    # array and nothing above it in document order is either. `array_name`
    # travels as the second argument, which is the form locateElement's
    # direct-handle branch takes: a handle nested inside an ordinary object
    # cannot be serialised as a remote object reference.
    def self.locate_element(handle : Engine::Handle,
                            array_name : String) : JSON::Any?
      found = handle.evaluate(LOCATE_ELEMENT, JSON::Any.new(array_name))
      found.raw.nil? ? nil : found
    end

    # Activation through the element's own default action, aimed at the
    # deepest descendant covering its first line box: a handler bound below
    # the labelled control hears it, exactly as it would hear a mouse.
    def self.activate(handle : Engine::Handle) : JSON::Any
      handle.evaluate(CLICK_THROUGH)
    end

    # The ordinary default action, with the one fallback the DOM path needs.
    #
    # The page side descends to the node a mouse would land on, and that node
    # is not always an HTMLElement: an SVG icon, a MathML fragment, or a page
    # that replaced click() has no method to call. Nothing has been pressed
    # at that point, so the same control is pressed with trusted pointer
    # input. It reaches the inner node and bubbles from it, which is what the
    # DOM path was imitating in the first place.
    def self.default_activation(handle : Engine::Handle) : JSON::Any
      result = activate(handle)
      return activation_result("default-action") unless needs_real_click?(result)

      clicked = real_click(handle) rescue nil
      return activation_result("real-click") if clicked && ready?(clicked)

      why = clicked.try(&.as_h?).try(&.["reason"]?.try(&.as_s?)) || "could not be placed"
      activation_result("default-action",
        "Could not press it directly, and a real click #{why}.")
    end

    # The item-level activation policy from Core#activate. The handle-level
    # actions above and below are deliberately smaller: this is the caller
    # that decides when a closed-shadow target or an autofilled sign-in needs
    # trusted input, and when the DOM's own default action is the right one.
    def self.activate_item(page : Engine::Page, item : JSON::Any,
                           handle : Engine::Handle? = nil) : JSON::Any
      object = item.as_h
      return press_frame(page, object) if object["pressFrame"]?
      held = handle || raise IO::Error.new("this line carries no element reference to activate")

      if object["pierced"]?.try(&.as_bool?) == true
        clicked = real_click(held) rescue nil
        return activation_result("real-click") if clicked && ready?(clicked)
      end

      role = object["role"]?.try(&.as_s?)
      if role && Aria::BUTTON_ROLES.includes?(role)
        remembered = submits_autofilled(held).as_bool? || false rescue false
        if remembered
          clicked = real_click(held) rescue nil
          return activation_result("real-click") if clicked && ready?(clicked)

          done = default_activation(held)
          # The fallback may already have made this a real press, or explained
          # why neither route worked. Neither should be overwritten with the
          # remembered-password warning.
          how = done.as_h["how"]?.try(&.as_s?)
          status = done.as_h["status"]?.try(&.as_s?)
          return done if how == "real-click" || status

          why = clicked.try(&.as_h?).try(&.["reason"]?.try(&.as_s?)) ||
            "could not be pressed that way"
          name = object["name"]?.try(&.as_s?) || ""
          return activation_result("default-action",
            "Pressed \"#{name}\", but the browser only sends a remembered password " +
            "when a person presses the button, and this one #{why}. " +
            "If the sign-in is refused, type the password in.")
        end
      end

      default_activation(held)
    end

    # Press into a document hidden behind a closed shadow root. Page script
    # cannot inspect it, but trusted hit testing can still reach its viewport.
    def self.press_frame(page : Engine::Page,
                         item : Hash(String, JSON::Any)) : JSON::Any
      name = item["name"]?.try(&.as_s?) || ""
      frame_value = item["pressFrame"]?
      frame_id = scope_context_id(frame_value, "")
      if frame_id.empty?
        return activation_result("frame", "Cannot reach into #{name} with this browser.")
      end

      frame = page.frame_for(frame_id)
      size = frame.evaluate("() => ({ w: window.innerWidth, h: window.innerHeight })").as_h? rescue nil
      width = size.try(&.["w"]?).try { |value| Core.js_number(value) } || 0.0
      height = size.try(&.["h"]?).try { |value| Core.js_number(value) } || 0.0
      unless width > 0 && height > 0
        return activation_result("frame", "#{name} has nothing on screen to press.")
      end
      frame.click_in_frame(width / 2, height / 2)
      activation_result("frame", "Pressed the middle of #{name}.")
    end

    # Put a control under the browser's keyboard.
    def self.focus_control(handle : Engine::Handle) : JSON::Any
      handle.evaluate(FOCUS_CONTROL)
    end

    # Whether pressing this would submit a form the browser filled in itself.
    def self.submits_autofilled(handle : Engine::Handle) : JSON::Any
      handle.evaluate(SUBMITS_AUTOFILLED)
    end

    # A click the browser accounts a person's, at real coordinates, carrying
    # user activation. Refuses rather than guesses when the element cannot be
    # brought somewhere a mouse could reach it — the ready answer the check
    # produced is what comes back, reason and all.
    def self.real_click(handle : Engine::Handle) : JSON::Any
      ready = handle.evaluate(PREPARE_REAL_CLICK)
      return ready unless ready?(ready)
      handle.click
      JSON::Any.new({"ok" => JSON::Any.new(true)})
    end

    # The pointer moved onto the element and left there, from a point just
    # outside it: the page's mouseover and mouseenter are what a menu opens
    # on, and a pointer that merely appears on the target raises neither.
    def self.hover(handle : Engine::Handle) : JSON::Any
      ready = handle.evaluate(PREPARE_REAL_CLICK)
      return ready unless ready?(ready)
      point = pointer_point(ready.as_h)
      handle.hover_at(point[:from_x], point[:from_y], point[:x], point[:y])
      JSON::Any.new({"ok" => JSON::Any.new(true)})
    end

    private def self.ready?(ready : JSON::Any) : Bool
      ready.as_h?.try(&.["ok"]?.try(&.as_bool?)) || false
    end

    private def self.needs_real_click?(result : JSON::Any) : Bool
      result.as_h?.try(&.["reason"]?.try(&.as_s?)) == "no-click-method"
    end

    private def self.activation_result(how : String, status : String? = nil) : JSON::Any
      JSON::Any.new({
        "how"    => JSON::Any.new(how),
        "status" => JSON::Any.new(status),
      })
    end

    private def self.scope_context_id(value : JSON::Any?, fallback : String) : String
      return fallback unless value
      if string = value.as_s?
        return string
      end
      object = value.as_h? || return fallback
      object["id"]?.try(&.as_s?) || object["contextId"]?.try(&.as_s?) ||
        object["context"]?.try(&.as_s?) || fallback
    end

    # The browser's own save-target gesture, which keeps the current tab in
    # place and gives the request to the download manager — cookies, proxy,
    # filename handling and downloads history and all. Which modifier that
    # is, and how it is held across the click, is the engine's.
    def self.download_link(handle : Engine::Handle) : Nil
      handle.download_link
    end

    # A trusted press at the point a requested position maps onto the
    # slider's own track. Used when a custom ARIA slider advertises a range
    # and then ignores every standard key: Core.slider_target maps the value
    # onto the range, and the engine maps it onto the pixels the page has.
    def self.click_slider(handle : Engine::Handle, ratio : Float64,
                          orientation : JSON::Any?) : Nil
      handle.click_slider(ratio, orientation)
    end

    # Adjust an already-focused control with the keyboard it is required to
    # support (src/core.js Core.prototype.adjustControlHandle). The value is
    # read back either way, so callers never claim an adjustment merely
    # because an event was sent; when the keyboard did nothing and the
    # control is a slider, the requested value is mapped onto its visual
    # track and pressed there with trusted pointer input instead.
    def self.adjust_control(handle : Engine::Handle, role : String?,
                            key : String) : JSON::Any
      handle.evaluate(FOCUS_ELEMENT)
      before = handle.evaluate(SLIDER_STATE)
      target = role == "slider" ? Core.slider_target(before, key) : nil
      handle.keyboard.press(key)
      sleep(120.milliseconds)
      after = read_slider_state(handle)
      before_value = before.as_h["value"]?
      after_value = state_value(after)

      if target.nil? || after.nil? || js_string(after_value) != js_string(before_value) ||
         target == Core.js_number(before_value)
        changed = !after.nil? && js_string(after_value) != js_string(before_value)
        return JSON::Any.new({
          "changed"  => JSON::Any.new(changed),
          "fallback" => JSON::Any.new(false),
          "before"   => before_value || JSON::Any.new(nil),
          "after"    => after_value || JSON::Any.new(nil),
        })
      end

      low = Core.js_number(before.as_h["min"]?)
      high = Core.js_number(before.as_h["max"]?)
      ratio = (target.not_nil! - low) / (high - low)
      orientation = before.as_h["orientation"]?
      click_slider(handle, ratio, orientation)
      sleep(120.milliseconds)
      after = read_slider_state(handle)
      # Some composite media controls use the first pointer press only to
      # leave their muted state, restoring the previous volume rather than
      # honoring the point on the track. Once awake, the same trusted press
      # reaches the advertised value. Retry only when the numeric result is
      # plainly not the requested position; a slider that snaps to nearby
      # discrete values has already answered correctly.
      actual = Core.js_number(state_value(after))
      step = Core.js_number(before.as_h["step"]?)
      tolerance = Math.max(step.finite? ? step : 0.0, (high - low) * 0.03)
      if actual.finite? && (actual - target.not_nil!).abs > tolerance
        click_slider(handle, ratio, orientation)
        sleep(120.milliseconds)
        after = read_slider_state(handle) || after
      end
      changed = !after.nil? && js_string(state_value(after)) != js_string(before_value)
      JSON::Any.new({
        "changed"  => JSON::Any.new(changed),
        "fallback" => JSON::Any.new(true),
        "before"   => before_value || JSON::Any.new(nil),
        "after"    => state_value(after) || JSON::Any.new(nil),
        "target"   => JSON::Any.new(target.not_nil!),
      })
    end

    private def self.read_slider_state(handle : Engine::Handle) : JSON::Any?
      handle.evaluate(SLIDER_STATE)
    rescue
      nil
    end

    private def self.state_value(state : JSON::Any?) : JSON::Any?
      state.try(&.as_h?).try(&.["value"]?)
    end

    # JavaScript's String(): what the reader compares a read-back value by.
    def self.js_string(value : JSON::Any?) : String
      case raw = value.try(&.raw)
      when Nil        then "null"
      when String     then raw
      when Bool       then raw ? "true" : "false"
      when Int64      then raw.to_s
      when Float64
        whole = raw.trunc
        raw == whole && raw.abs < 1e21 ? whole.to_i64.to_s : raw.to_s
      else "null"
      end
    end

    # The point the reachability check vetted, not a point computed again
    # afterwards: what was established is that *this* point lands on the
    # element. prepareRealClick answers whole numbers for all four when it
    # says ok; the fallbacks mirror the driver's, in case a page answered an
    # ok without them.
    private def self.pointer_point(ready : Hash(String, JSON::Any)) : NamedTuple(x: Float64, y: Float64, from_x: Float64, from_y: Float64)
      x = number_at(ready, "x") || 0.0
      y = number_at(ready, "y") || 0.0
      from_x = number_at(ready, "fromX") || x
      from_y = number_at(ready, "fromY") || y - 1.0
      {x: x, y: y, from_x: from_x, from_y: from_y}
    end

    private def self.number_at(object : Hash(String, JSON::Any), key : String) : Float64?
      value = object[key]?
      return nil unless value
      value.raw.is_a?(Number) ? Core.js_number(value) : nil
    end
  end
end
