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

    # Activation through the element's own default action, aimed at the
    # deepest descendant covering its first line box: a handler bound below
    # the labelled control hears it, exactly as it would hear a mouse.
    def self.activate(handle : FirefoxDriver::Handle) : JSON::Any
      handle.evaluate(CLICK_THROUGH)
    end

    # The item-level activation policy from Core#activate. The handle-level
    # actions above and below are deliberately smaller: this is the caller
    # that decides when a closed-shadow target or an autofilled sign-in needs
    # trusted input, and when the DOM's own default action is the right one.
    def self.activate_item(session : Bidi::Session, page_context_id : String,
                           item : JSON::Any, handle : FirefoxDriver::Handle? = nil) : JSON::Any
      object = item.as_h
      return press_frame(session, page_context_id, object) if object["pressFrame"]?
      held = handle || raise IO::Error.new("this line carries no element reference to activate")
      context_id = scope_context_id(object["frame"]?, held.context_id)

      if object["pierced"]?.try(&.as_bool?) == true
        clicked = real_click(session, context_id, held) rescue nil
        return activation_result("real-click") if clicked && ready?(clicked)
      end

      role = object["role"]?.try(&.as_s?)
      if role && Aria::BUTTON_ROLES.includes?(role)
        remembered = submits_autofilled(held).as_bool? || false rescue false
        if remembered
          clicked = real_click(session, context_id, held) rescue nil
          return activation_result("real-click") if clicked && ready?(clicked)

          activate(held)
          why = clicked.try(&.as_h?).try(&.["reason"]?.try(&.as_s?)) ||
            "could not be pressed that way"
          name = object["name"]?.try(&.as_s?) || ""
          return activation_result("default-action",
            "Pressed \"#{name}\", but the browser only sends a remembered password " +
            "when a person presses the button, and this one #{why}. " +
            "If the sign-in is refused, type the password in.")
        end
      end

      activate(held)
      activation_result("default-action")
    end

    # Press into a document hidden behind a closed shadow root. Page script
    # cannot inspect it, but trusted hit testing can still reach its viewport.
    def self.press_frame(session : Bidi::Session, page_context_id : String,
                         item : Hash(String, JSON::Any)) : JSON::Any
      name = item["name"]?.try(&.as_s?) || ""
      frame_value = item["pressFrame"]?
      context_id = scope_context_id(frame_value, "")
      if context_id.empty?
        return activation_result("frame", "Cannot reach into #{name} with this browser.")
      end

      frame = FirefoxDriver::Frame.new(session, context_id)
      size = frame.evaluate("() => ({ w: window.innerWidth, h: window.innerHeight })").as_h? rescue nil
      width = size.try(&.["w"]?).try { |value| Core.js_number(value) } || 0.0
      height = size.try(&.["h"]?).try { |value| Core.js_number(value) } || 0.0
      unless width > 0 && height > 0
        return activation_result("frame", "#{name} has nothing on screen to press.")
      end
      click_in_frame(session, context_id, width / 2, height / 2)
      activation_result("frame", "Pressed the middle of #{name}.")
    end

    # Put a control under the browser's keyboard.
    def self.focus_control(handle : FirefoxDriver::Handle) : JSON::Any
      handle.evaluate(FOCUS_CONTROL)
    end

    # Whether pressing this would submit a form the browser filled in itself.
    def self.submits_autofilled(handle : FirefoxDriver::Handle) : JSON::Any
      handle.evaluate(SUBMITS_AUTOFILLED)
    end

    # A click the browser accounts a person's, at real coordinates, carrying
    # user activation. Refuses rather than guesses when the element cannot be
    # brought somewhere a mouse could reach it — the ready answer the check
    # produced is what comes back, reason and all.
    def self.real_click(session : Bidi::Session, context_id : String, handle : FirefoxDriver::Handle) : JSON::Any
      ready = handle.evaluate(PREPARE_REAL_CLICK)
      return ready unless ready?(ready)
      perform_click(session, context_id, handle)
      JSON::Any.new({"ok" => JSON::Any.new(true)})
    end

    # The pointer moved onto the element and left there. No releaseActions
    # afterwards: there is no button held down to release, and releasing the
    # action sequence is what would undo the pointer's position.
    def self.hover(session : Bidi::Session, context_id : String, handle : FirefoxDriver::Handle) : JSON::Any
      ready = handle.evaluate(PREPARE_REAL_CLICK)
      return ready unless ready?(ready)
      point = pointer_point(ready.as_h)
      session.command("input.performActions", pointer_params(
        context_id, "tweb-mouse",
        [
          pointer_move(point[:from_x], point[:from_y], JSON::Any.new("viewport")),
          pointer_move(point[:x], point[:y], JSON::Any.new("viewport")),
        ]))
      JSON::Any.new({"ok" => JSON::Any.new(true)})
    end

    private def self.ready?(ready : JSON::Any) : Bool
      ready.as_h?.try(&.["ok"]?.try(&.as_bool?)) || false
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

    private def self.click_in_frame(session : Bidi::Session, context_id : String,
                                    x : Float64, y : Float64) : Nil
      begin
        session.command("input.performActions", pointer_params(
          context_id, "tweb-mouse",
          [
            pointer_move(JSON::Any.new(Core.js_round(x).to_i64),
              JSON::Any.new(Core.js_round(y).to_i64), JSON::Any.new("viewport")),
            JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
            JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
          ]))
      ensure
        session.command("input.releaseActions",
          {"context" => JSON::Any.new(context_id)}) rescue nil
      end
    end

    # Firefox's native Alt-click save gesture (src/driver_firefox.js
    # downloadLink). Keyboard and pointer sources advance together in BiDi
    # ticks, so Alt is down before the pointer moves and remains down until
    # after its release produces the click.
    def self.download_link(session : Bidi::Session, context_id : String, handle : FirefoxDriver::Handle) : Nil
      shared = handle.shared_id
      raise IO::Error.new("this line carries no element reference to download") unless shared
      target = element_reference(shared)
      alt = "\u{E00A}"
      begin
        session.command("input.performActions", {
          "context" => JSON::Any.new(context_id),
          "actions" => JSON::Any.new([
            JSON::Any.new({
              "type"    => JSON::Any.new("key"),
              "id"      => JSON::Any.new("tweb-download-key"),
              "actions" => JSON::Any.new([
                JSON::Any.new({"type" => JSON::Any.new("keyDown"), "value" => JSON::Any.new(alt)}),
                JSON::Any.new({"type" => JSON::Any.new("pause")}),
                JSON::Any.new({"type" => JSON::Any.new("pause")}),
                JSON::Any.new({"type" => JSON::Any.new("pause")}),
                JSON::Any.new({"type" => JSON::Any.new("keyUp"), "value" => JSON::Any.new(alt)}),
              ]),
            }),
            JSON::Any.new({
              "type"       => JSON::Any.new("pointer"),
              "id"         => JSON::Any.new("tweb-download-mouse"),
              "parameters" => JSON::Any.new({"pointerType" => JSON::Any.new("mouse")}),
              "actions"    => JSON::Any.new([
                JSON::Any.new({"type" => JSON::Any.new("pause")}),
                pointer_move(JSON::Any.new(0), JSON::Any.new(0), target),
                JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
                JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
                JSON::Any.new({"type" => JSON::Any.new("pause")}),
              ]),
            }),
          ]),
        })
      ensure
        session.command("input.releaseActions",
          {"context" => JSON::Any.new(context_id)}) rescue nil
      end
    end

    # The track of a slider, and a trusted press at the point a requested
    # position maps onto. Used when a custom ARIA slider advertises a range
    # and then ignores every standard key: Core.slider_target maps the value
    # onto the range, this maps it onto the pixels the page actually has.
    def self.click_slider(session : Bidi::Session, context_id : String, handle : FirefoxDriver::Handle, ratio : Float64, orientation : JSON::Any?) : Nil
      shared = handle.shared_id
      raise IO::Error.new("this slider carries no element reference") unless shared
      target = element_reference(shared)
      begin
        # The first move reveals hover-only tracks. Element-origin offsets
        # are from its centre in WebDriver actions, so the second move needs
        # only the dimensions after that disclosure has happened.
        session.command("input.performActions", pointer_params(
          context_id, "tweb-slider",
          [pointer_move(JSON::Any.new(0), JSON::Any.new(0), target)]))
        sleep(120.milliseconds)
        geometry = handle.evaluate(SLIDER_GEOMETRY, orientation || JSON::Any.new(nil)).as_h
        vertical = geometry["vertical"]?.try(&.as_bool?) || false
        start = Core.js_number(geometry["start"]?)
        finish = Core.js_number(geometry["end"]?)
        width = Core.js_number(geometry["width"]?)
        height = Core.js_number(geometry["height"]?)
        along = start + (vertical ? 1 - ratio : ratio) * (finish - start)
        x = vertical ? JSON::Any.new(0) : JSON::Any.new(Core.js_round(along - width / 2).to_i64)
        y = vertical ? JSON::Any.new(Core.js_round(along - height / 2).to_i64) : JSON::Any.new(0)
        session.command("input.performActions", pointer_params(
          context_id, "tweb-slider",
          [
            pointer_move(x, y, target),
            JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
            JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
          ]))
      ensure
        session.command("input.releaseActions",
          {"context" => JSON::Any.new(context_id)}) rescue nil
      end
    end

    # Adjust an already-focused control with the keyboard it is required to
    # support (src/core.js Core.prototype.adjustControlHandle). The value is
    # read back either way, so callers never claim an adjustment merely
    # because an event was sent; when the keyboard did nothing and the
    # control is a slider, the requested value is mapped onto its visual
    # track and pressed there with trusted pointer input instead.
    def self.adjust_control(keyboard : FirefoxDriver::Keyboard, scope_context_id : String, role : String?, handle : FirefoxDriver::Handle, key : String) : JSON::Any
      handle.evaluate(FOCUS_ELEMENT)
      before = handle.evaluate(SLIDER_STATE)
      target = role == "slider" ? Core.slider_target(before, key) : nil
      keyboard.press(key)
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
      click_slider(keyboard.session, scope_context_id, handle, ratio, orientation)
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
        click_slider(keyboard.session, scope_context_id, handle, ratio, orientation)
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

    private def self.read_slider_state(handle : FirefoxDriver::Handle) : JSON::Any?
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

    private def self.perform_click(session : Bidi::Session, context_id : String, handle : FirefoxDriver::Handle) : Nil
      shared = handle.shared_id
      raise IO::Error.new("this line carries no element reference to click") unless shared
      target = element_reference(shared)
      begin
        session.command("input.performActions", pointer_params(
          context_id, "tweb-mouse",
          [
            pointer_move(JSON::Any.new(0), JSON::Any.new(0), target),
            JSON::Any.new({"type" => JSON::Any.new("pointerDown"), "button" => JSON::Any.new(0)}),
            JSON::Any.new({"type" => JSON::Any.new("pointerUp"), "button" => JSON::Any.new(0)}),
          ]))
      ensure
        # A pointer left pressed belongs to nobody once this returns, and the
        # next action would inherit it.
        session.command("input.releaseActions",
          {"context" => JSON::Any.new(context_id)}) rescue nil
      end
    end

    private def self.element_reference(shared : String) : JSON::Any
      JSON::Any.new({
        "type"    => JSON::Any.new("element"),
        "element" => JSON::Any.new({"sharedId" => JSON::Any.new(shared)}),
      })
    end

    private def self.pointer_params(context_id : String, id : String, actions : Array(JSON::Any)) : Hash(String, JSON::Any)
      {
        "context" => JSON::Any.new(context_id),
        "actions" => JSON::Any.new([JSON::Any.new({
          "type"       => JSON::Any.new("pointer"),
          "id"         => JSON::Any.new(id),
          "parameters" => JSON::Any.new({"pointerType" => JSON::Any.new("mouse")}),
          "actions"    => JSON::Any.new(actions),
        })]),
      }
    end

    private def self.pointer_move(x : JSON::Any, y : JSON::Any, origin : JSON::Any) : JSON::Any
      JSON::Any.new({
        "type"   => JSON::Any.new("pointerMove"),
        "x"      => x,
        "y"      => y,
        "origin" => origin,
      })
    end

    # The point the reachability check vetted, not a point computed again
    # afterwards: what was established is that *this* point lands on the
    # element. prepareRealClick answers numbers for all four when it says ok;
    # the fallbacks mirror the driver's, in case a page answered an ok
    # without them.
    private def self.pointer_point(ready : Hash(String, JSON::Any)) : NamedTuple(x: JSON::Any, y: JSON::Any, from_x: JSON::Any, from_y: JSON::Any)
      x = number_at(ready, "x") || JSON::Any.new(0)
      y = number_at(ready, "y") || JSON::Any.new(0)
      from_x = number_at(ready, "fromX") || x
      from_y = number_at(ready, "fromY") || begin
        case raw = y.raw
        when Int64   then JSON::Any.new(raw - 1)
        when Float64 then JSON::Any.new(raw - 1.0)
        else              JSON::Any.new(-1)
        end
      end
      {x: x, y: y, from_x: from_x, from_y: from_y}
    end

    private def self.number_at(object : Hash(String, JSON::Any), key : String) : JSON::Any?
      value = object[key]?
      return nil unless value
      value.raw.is_a?(Number) ? value : nil
    end
  end
end
