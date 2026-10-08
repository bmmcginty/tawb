require "json"

module Tawb
  module Aria
    LINK_ROLES   = {"link"}
    BUTTON_ROLES = {
      "button", "menuitem", "menuitemcheckbox", "menuitemradio",
      "tab", "switch", "checkbox", "radio", "option",
    }
    FIELD_ROLES = {"textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton"}

    def self.render_line(item : JSON::Any) : String
      object = item.as_h
      role = string(object, "role")
      name = string(object, "name")
      value = string(object, "value")
      if role == "heading"
        level_value = object["level"]?
        level = level_value.try(&.as_i64?) || level_value.try(&.as_s?).try(&.to_i64?)
        marker = level ? "#" * level.to_i + " " : "## "
        return marker + name
      end
      return "{#{name}#{expansion(object)}#{state_text(object)}}" if LINK_ROLES.includes?(role)
      if BUTTON_ROLES.includes?(role)
        attached = truthy?(object["file"]?) && !value.empty? ? ": #{value}" : ""
        return "[*#{name}#{attached}#{expansion(object)}#{state_text(object)}]"
      end
      if FIELD_ROLES.includes?(role)
        filled = truthy?(object["autofilled"]?) ? "filled by the browser" : ""
        shown = !value.empty? ? value : filled
        inside = shown.empty? ? name : "#{name}: #{shown}"
        return "[#{inside}#{expansion(object)}#{state_text(object)}]"
      end
      return "(image) #{name}" if role == "img"
      return "(#{role}) #{name}" if role == "video" || role == "audio"
      return name.empty? ? "<frame>" : "<frame: #{name}>" if role == "iframe"
      name
    end

    def self.state_text(object : Hash(String, JSON::Any)) : String
      states = [] of String
      checked = object["checked"]?
      if checked.try(&.as_s?) == "mixed"
        states << "partly checked"
      elsif checked.try(&.as_bool?) == true
        states << "checked"
      elsif !checked.nil? && checked.try(&.as_bool?) == false
        states << "not checked"
      end
      boolean_state(object, "pressed", "pressed", "not pressed", states)
      states << "selected" if object["selected"]?.try(&.as_bool?) == true
      if current = object["current"]?
        if current.as_bool? == true
          states << "current"
        elsif word = current.as_s?
          states << "current #{word}" unless word.empty?
        end
      end
      states << "read only" if truthy?(object["readonly"]?)
      states << "required" if truthy?(object["required"]?)
      if invalid = object["invalid"]?
        if invalid.as_bool? == true
          states << "invalid"
        elsif word = invalid.as_s?
          states << "invalid: #{word}" unless word.empty?
        end
      end
      if orientation = object["orientation"]?.try(&.as_s?)
        states << orientation unless orientation.empty?
      end
      states << "unavailable" if truthy?(object["disabled"]?)
      states.empty? ? "" : ", #{states.join(", ")}"
    end

    private def self.expansion(object : Hash(String, JSON::Any)) : String
      expanded = object["expanded"]?
      return ", expanded" if expanded.try(&.as_bool?) == true
      return ", collapsed" if !expanded.nil? && expanded.try(&.as_bool?) == false
      ""
    end

    private def self.boolean_state(object, key, yes, no, states) : Nil
      value = object[key]?
      states << yes if value.try(&.as_bool?) == true
      states << no if !value.nil? && value.try(&.as_bool?) == false
    end

    private def self.string(object : Hash(String, JSON::Any), key : String) : String
      object[key]?.try(&.as_s?) || ""
    end

    private def self.truthy?(value : JSON::Any?) : Bool
      return false unless value
      return false if value.raw.nil?
      boolean = value.as_bool?
      boolean.nil? ? true : boolean
    end
  end
end
