require "./dbus"
require "./log"

module Tawb
  # The browser's own windows, read the way a screen reader reads them.
  #
  # Some of what a browser puts in front of a person is not a page. Chrome's
  # "Add extension?" confirmation is a native dialog: the dialog has no
  # document, no frame, no target, and nothing in CDP will ever describe the
  # dialog — checked with `Target.getTargets({filter:[{}]})`, every type rather
  # than the default subset, and watched through `Target.targetCreated` across
  # a whole install. The dialog does not appear. The omnibox popup does appear,
  # as `browser_ui:chrome://omnibox-popup`, so the absence is not a rule about
  # browser UI; that particular dialog is simply not WebUI.
  #
  # The dialog is, however, a dialog the browser already describes to
  # assistive technology, because a blind user pressing "Add to Chrome" has to
  # be able to answer the dialog too. On Linux that description is AT-SPI,
  # which is D-Bus (see `dbus.cr`), and AT-SPI carries everything the dialog
  # says: the dialog's heading, the permissions the dialog lists, and the
  # dialog's buttons with an action that presses them. So the reader gets the
  # dialog's own words on the terminal and the reader's answer presses the
  # dialog's own button. The browser does the install.
  #
  # Two conditions, both real:
  #
  #   * The browser must have been started with platform accessibility on —
  #     `--force-renderer-accessibility`, of which `basic` is enough. Without
  #     the flag AT-SPI shows the application and the window frame and nothing
  #     inside the application and the window frame, because
  #     `AXPlatformNodeAuraLinux::CreateAtkObject()` refuses to build a node
  #     for anything that is not a top-level window unless `AXMode::kNativeAPIs`
  #     is set. Nothing else turns platform accessibility on: not the
  #     ACCESSIBILITY_ENABLED environment variable, not org.a11y.Status's
  #     ScreenReaderEnabled, not registering as an AT-SPI listener, and not
  #     CDP's own Accessibility.enable. See `browser.cr` for where the flag is
  #     passed.
  #   * There must be an accessibility bus to answer on, which is at-spi2-core
  #     running against a session bus. See `a11y_bus.cr`.
  module Atspi
    # Every application on the accessibility bus answers for the application's
    # own tree at this path. The at-spi registry keeps a desktop object listing
    # every application, but asking the applications directly means one daemon
    # fewer has to be running: with at-spi2-registryd not started at all, a
    # browser still registers on the bus and still answers here. Verified,
    # because the alternative was starting a daemon that is not needed.
    ROOT_PATH  = "/org/a11y/atspi/accessible/root"
    ACCESSIBLE = "org.a11y.atspi.Accessible"
    ACTION        = "org.a11y.atspi.Action"
    TEXT          = "org.a11y.atspi.Text"
    EDITABLE_TEXT = "org.a11y.atspi.EditableText"
    TABLE_CELL    = "org.a11y.atspi.TableCell"
    PROPERTIES    = "org.freedesktop.DBus.Properties"

    # A dialog is not deep, and a page behind a dialog can be. Both limits are
    # here to keep a walk from turning into a tour of a document: what is being
    # read is a confirmation with a heading, a list and two buttons.
    MAX_DEPTH =  12
    MAX_NODES = 400

    # How long to wait on a connection that may not be an application at all.
    PROBE_TIMEOUT = 1500.milliseconds

    # Roles that name a button a reader can press. AT-SPI spells the role "push
    # button"; Chromium's own views answer "button" for some of them, so both
    # spellings are taken.
    BUTTON_ROLES = Set{"push button", "button", "toggle button"}

    # Options a dialog offers alongside the dialog's answer. Firefox's install
    # doorhanger has one — "Allow extension to run in private windows" — and a
    # reader who cannot see the option should be able to tick the option before
    # answering, exactly as a sighted user can.
    TOGGLE_ROLES = Set{"check box", "check menu item"}

    # Controls that hold a value rather than a label. Chrome's "Save password?"
    # is the case that matters: the username and the password Chrome is about
    # to save are in two entries, and a dialog read without the two entries
    # says "Username" twice and never says whose password Chrome is saving. The
    # browser masks the password itself — the entry answers with bullets — so
    # what a reader hears is what a sighted user sees.
    VALUE_ROLES = Set{"entry", "password text", "text", "spin button"}

    # The states a control can be in arrive as a pair of 32-bit words, one bit
    # per state, in the order the AT-SPI enumeration defines the states. Only
    # three matter here, and two of the three are about which button answers
    # the dialog: the button the dialog itself would press.
    STATE_CHECKED    =  4
    STATE_FOCUSED    = 12
    STATE_SHOWING    = 23
    STATE_IS_DEFAULT = 39

    # Roles that hold no words of their own and only group what is inside them.
    # A dialog is mostly these roles, and reading these roles out would bury
    # the two lines that matter.
    SILENT_ROLES = Set{"panel", "filler", "section", "redundant object", "unknown"}

    # Roles that are never worth walking into. A file chooser's listing is
    # thousands of nodes — a row, then a cell per column, then whatever the
    # cell wraps — and the buttons that answer the dialog come *after* it.
    # Walking the inside of a cell spends the whole budget on the listing and
    # never reaches them, which is a save dialog with no Save button on it.
    PRUNE_ROLES = Set{"table cell", "animation", "icon", "image", "separator",
                      "scroll bar", "static"}

    # How many rows of one table are read. A directory with more than this many
    # entries is one the reader will type a path into rather than walk.
    MAX_ROWS = 150

    # One node of an accessibility tree: which connection answers for the node,
    # and which object on that connection the node is.
    record Node, bus : String, path : String

    # A node together with what the node answered about itself. `value` and the
    # three states are filled in only for the controls they apply to, which is
    # why each one has a quiet default rather than being required.
    class Described
      getter bus : String
      getter path : String
      getter role : String
      getter name : String
      property value : String
      property checked : Bool
      property focused : Bool
      property is_default : Bool
      property showing : Bool
      property editable : Bool
      property action_name : String
      property action_index : Int32

      def initialize(@bus : String, @path : String, @role : String, @name : String,
                     @value : String = "", @checked : Bool = false,
                     @focused : Bool = false, @is_default : Bool = false,
                     @showing : Bool = false, @editable : Bool = false,
                     @action_name : String = "", @action_index : Int32 = 0)
      end

      def node : Node
        Node.new(@bus, @path)
      end
    end

    record States, checked : Bool, focused : Bool, showing : Bool, is_default : Bool

    # Everything a dialog says, and everything a reader can answer the dialog
    # with.
    record Reading,
      role : String,
      name : String,
      lines : Array(String),
      buttons : Array(Described),
      toggles : Array(Described),
      fields : Array(Described),
      actions : Array(Described),
      truncated : Bool

    # Which process a pid belongs to the group of. The browser is not always a
    # child of this process — with no display the browser is started under
    # xvfb-run and is that shell's child — so the process group is what
    # identifies the browser this session started, and the browser was detached
    # precisely so that the browser leads a process group.
    def self.process_group_of(pid : Int64) : Int64?
      stat = File.read("/proc/#{pid}/stat")
      # The second field is the executable name in brackets and may itself
      # contain spaces and brackets, so the fields after the second field are
      # counted from the last close bracket rather than from the start.
      close = stat.rindex(')')
      return nil if close.nil?
      after = stat[(close + 2)..].split(' ')
      group = after[2]?.try(&.to_i64?) # state, ppid, pgrp
      group == 0 ? nil : group
    rescue
      nil
    end

    class Accessibility
      getter connection : Dbus::Connection

      def initialize(@connection : Dbus::Connection, @log : Log? = nil)
      end

      def close : Nil
        @connection.close
      end

      private def call(node : Node, iface : String, member : String,
                       signature : String = "", body : Array(Dbus::Argument) = [] of Dbus::Argument,
                       timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : Array(Dbus::Value)
        @connection.call(
          destination: node.bus, path: node.path, iface: iface, member: member,
          signature: signature, body: body, timeout: timeout,
        )
      end

      def children_of(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : Array(Node)
        answered = call(node, ACCESSIBLE, "GetChildren", timeout: timeout)[0]?
        found = [] of Node
        return found unless answered.is_a?(Array)
        answered.each do |entry|
          next unless entry.is_a?(Array)
          bus = entry[0]?
          path = entry[1]?
          next unless bus.is_a?(String) && path.is_a?(String)
          found << Node.new(bus, path)
        end
        found
      end

      def role_of(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : String
        role = call(node, ACCESSIBLE, "GetRoleName", timeout: timeout)[0]?
        role.is_a?(String) ? role : ""
      end

      def name_of(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : String
        name = call(
          node, PROPERTIES, "Get", "ss",
          [ACCESSIBLE.as(Dbus::Argument), "Name".as(Dbus::Argument)], timeout
        )[0]?
        name.is_a?(String) ? name : ""
      end

      # Role and name together, which is what every caller here wants and what
      # costs two round trips rather than one walk of everything.
      def describe_node(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : Described
        Described.new(node.bus, node.path, role_of(node, timeout), name_of(node, timeout))
      end

      # Which of a control's states are set. Chrome marks the button Chrome's
      # own dialog would press — for an install prompt that button is Cancel,
      # not Add, which is worth knowing before deciding what Escape should mean.
      def states_of(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : States
        answered = call(node, ACCESSIBLE, "GetState", timeout: timeout)[0]?
        words = [] of UInt32
        if answered.is_a?(Array)
          answered.each do |word|
            words << case word
            when UInt32 then word
            when Int32  then word.to_u32!
            when Int64  then word.to_u32!
            when UInt64 then word.to_u32!
            else             0_u32
            end
          end
        end
        States.new(
          checked: state_bit(words, STATE_CHECKED),
          focused: state_bit(words, STATE_FOCUSED),
          showing: state_bit(words, STATE_SHOWING),
          is_default: state_bit(words, STATE_IS_DEFAULT),
        )
      end

      private def state_bit(words : Array(UInt32), index : Int32) : Bool
        word = words[index < 32 ? 0 : 1]? || 0_u32
        ((word >> (index % 32)) & 1) == 1
      end

      # What a control holds, as opposed to what the control is called.
      def value_of(node : Node, timeout : Time::Span = Dbus::DEFAULT_TIMEOUT) : String
        text = call(
          node, TEXT, "GetText", "ii",
          [0.to_i64.as(Dbus::Argument), -1.to_i64.as(Dbus::Argument)], timeout
        )[0]?
        text.is_a?(String) ? text : ""
      end

      def interfaces_of(node : Node) : Array(String)
        answered = call(node, ACCESSIBLE, "GetInterfaces")[0]?
        return [] of String unless answered.is_a?(Array)
        answered.compact_map(&.as?(String))
      end

      def actions_of(node : Node) : Array(NamedTuple(name: String, index: Int32))
        count_value = call(node, PROPERTIES, "Get", "ss",
          [ACTION.as(Dbus::Argument), "NActions".as(Dbus::Argument)])[0]?
        count = case count_value
                when Int32  then count_value
                when Int64  then count_value.to_i32
                when UInt32 then count_value.to_i32
                when UInt64 then count_value.to_i32
                else             0
                end
        actions = [] of NamedTuple(name: String, index: Int32)
        count.times do |index|
          name = call(node, ACTION, "GetName", "i",
            [index.to_i64.as(Dbus::Argument)])[0]?
          actions << {name: name, index: index} if name.is_a?(String) && !name.empty?
        end
        actions
      end

      def table_cell_position(node : Node) : Tuple(Int32, Int32)?
        value = call(node, PROPERTIES, "Get", "ss",
          [TABLE_CELL.as(Dbus::Argument), "Position".as(Dbus::Argument)])[0]?
        return nil unless value.is_a?(Array)
        row = value[0]?.try { |part| number_to_i32(part) }
        column = value[1]?.try { |part| number_to_i32(part) }
        row && column ? {row, column} : nil
      end

      private def number_to_i32(value : Dbus::Value) : Int32?
        case value
        when Int32  then value
        when Int64  then value.to_i32
        when UInt32 then value.to_i32
        when UInt64 then value.to_i32
        end
      end

      def set_text(node : Node, text : String) : Bool
        done = call(node, EDITABLE_TEXT, "SetTextContents", "s",
          [text.as(Dbus::Argument)])[0]?
        done == true
      end

      def do_action(node : Node, index : Int32 = 0) : Bool
        done = call(node, ACTION, "DoAction", "i", [index.to_i64.as(Dbus::Argument)])[0]?
        done == true
      end

      # Press a control. `DoAction(0)` is the control's first action, which for
      # a button is the press; the same call is what a screen reader makes when
      # the screen reader's user activates the control the user is on.
      def press(node : Node) : Bool
        do_action(node)
      end

      # Everything holding a connection to the accessibility bus, minus this
      # connection. Most of them are applications; some are other assistive
      # technology, which is why what comes back is candidates rather than
      # answers.
      def connections : Array(String)
        answered = @connection.call(
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          iface: "org.freedesktop.DBus",
          member: "ListNames",
        )[0]?
        found = [] of String
        return found unless answered.is_a?(Array)
        own = @connection.name
        answered.each do |name|
          next unless name.is_a?(String)
          next unless name.starts_with?(':')
          next if name == own
          found << name
        end
        found
      end

      # What is at the root of one connection's tree, or nil when that
      # connection does not have one. The short timeout is deliberate: another
      # assistive technology on the bus is not an application and will not
      # answer at all, and waiting the ordinary timeout for each of those would
      # make finding the browser take longer than the dialog stays up.
      def application_at(bus : String, timeout : Time::Span = PROBE_TIMEOUT) : Described?
        described = describe_node(Node.new(bus, ROOT_PATH), timeout)
        described.role == "application" ? described : nil
      rescue
        nil
      end

      # Every application currently on the bus.
      def applications : Array(Described)
        buses = connections
        answers = ::Channel(Described?).new(buses.size)
        buses.each do |bus|
          spawn { answers.send(application_at(bus)) }
        end
        found = [] of Described
        buses.size.times do
          application = answers.receive
          found << application if application
        end
        found
      end

      # The application belonging to a browser this session started.
      #
      # Identity is the process, not the name: a desktop may have several
      # browsers on it and only one of them is the browser this session is
      # reading. The bus knows the pid behind every connection, and the browser
      # this session started leads a process group of its own, so the two
      # together name the browser exactly. Asking the bus who owns a name is
      # cheap and local to the bus, so the pids are gathered first and only the
      # matching connection is asked for a tree.
      #
      # `names` is the fallback for a browser reached with --connect: that
      # browser was running before this session existed, so there is no pid of
      # this session's to match.
      def application_for(pid : Int64? = nil, names : Array(String) = [] of String) : Described?
        buses = connections
        if pid
          buses.each do |bus|
            owner = begin
              @connection.process_id_of(bus).to_i64
            rescue
              next
            end
            next if owner != pid && Atspi.process_group_of(owner) != pid
            application = application_at(bus)
            return application if application
          end
        end
        unless names.empty?
          wanted = names.map(&.downcase)
          buses.each do |bus|
            application = application_at(bus)
            if application && wanted.includes?(application.name.downcase)
              return application
            end
          end
        end
        nil
      end

      # The windows and dialogs an application has open, which are the direct
      # children of the application node. A native dialog is one of these: the
      # dialog is not inside the window the dialog came from, the dialog is
      # beside the window.
      def top_levels(application : Described) : Array(Described)
        found = [] of Described
        children_of(application.node).each do |child|
          begin
            found << describe_node(child)
          rescue
            # A window that closed while it was being asked about.
          end
        end
        found
      end

      # Everything a dialog says, in the order the dialog says it.
      #
      # What comes back is the lines a reader needs and the controls the reader
      # can answer with. Empty grouping nodes are dropped, and a node whose
      # name repeats the node's parent's name is dropped too — a views dialog
      # nests a heading inside a panel inside a panel, and each of the three
      # answers with the same string.
      def read(node : Node | Described, max_depth : Int32 = MAX_DEPTH,
               max_nodes : Int32 = MAX_NODES) : Reading
        root = node.is_a?(Described) ? node : describe_node(node)
        walk = Walk.new(self, max_depth, max_nodes)
        walk.enter(root, 0, Set(String).new)

        # What the dialog would do if the dialog were answered without being
        # read: the button the dialog has focused, or the button the dialog
        # calls its default.
        (walk.buttons + walk.toggles).each do |control|
          begin
            states = states_of(control.node)
            control.checked = states.checked
            control.focused = states.focused
            control.is_default = states.is_default
          rescue
            # A control that went away with the control's dialog.
          end
        end

        # A control's own words are not also a line. Firefox wraps its option
        # in a list item that answers with the same name as the check box
        # inside the list item, which would otherwise be read out once as prose
        # and once as a control.
        control_names = Set(String).new
        (walk.buttons + walk.toggles + walk.fields + walk.actions).each do |control|
          control_names << control.name unless control.name.empty?
        end
        Reading.new(
          role: root.role,
          name: root.name,
          lines: walk.lines.reject { |line| control_names.includes?(line) },
          buttons: walk.buttons,
          toggles: walk.toggles,
          fields: walk.fields,
          actions: walk.actions,
          truncated: walk.visited >= max_nodes,
        )
      end
    end

    # One walk of one dialog, which is a recursion carrying four growing lists
    # and a count. A class rather than a closure, because Crystal has no
    # equivalent of a JavaScript inner function closing over the lists it is
    # filling.
    class Walk
      getter lines : Array(String)
      getter buttons : Array(Described)
      getter toggles : Array(Described)
      getter fields : Array(Described)
      getter actions : Array(Described)
      getter visited : Int32

      def initialize(@accessibility : Accessibility, @max_depth : Int32, @max_nodes : Int32)
        @lines = [] of String
        @buttons = [] of Described
        @toggles = [] of Described
        @fields = [] of Described
        @actions = [] of Described
        @visited = 0
      end

      def enter(current : Described, depth : Int32, seen : Set(String),
                inherited_name : String = "", beside : String = "") : Nil
        return if @visited >= @max_nodes
        @visited += 1
        name = current.name.strip
        if BUTTON_ROLES.includes?(current.role) && !name.empty?
          @buttons << Described.new(current.bus, current.path, current.role, name)
        elsif TOGGLE_ROLES.includes?(current.role) && !name.empty?
          @toggles << Described.new(current.bus, current.path, current.role, name)
        elsif VALUE_ROLES.includes?(current.role)
          value = begin
            @accessibility.value_of(current.node)
          rescue
            ""
          end
          interfaces = @accessibility.interfaces_of(current.node) rescue [] of String
          editable = interfaces.includes?(EDITABLE_TEXT)
          states = editable ? (@accessibility.states_of(current.node) rescue nil) : nil
          # A GTK entry is often named by a label beside it rather than by an
          # ancestor: the save dialog's Name field is a blank text box whose
          # next sibling is the word "Name:".
          contextual = inherited_name.gsub(/\s+(?:layer|stack|revealer)$/i, "")
          field_name = name.empty? ? (beside.empty? ? contextual : beside) : name
          # A GTK path bar keeps several location widgets stacked and shows
          # one. The hidden ones have no name, no text and are neither focused
          # nor showing; the visible one is focused as soon as the chooser
          # switches to typing a location.
          visible = !editable || states.nil? ||
                    states.not_nil!.showing || states.not_nil!.focused ||
                    !value.empty? || !name.empty?
          if visible && (!name.empty? || !value.empty? || editable)
            @fields << Described.new(current.bus, current.path, current.role,
              field_name, value, editable: editable, showing: states.try(&.showing) || false)
          end
        elsif current.role == "file chooser"
          offered = @accessibility.actions_of(current.node) rescue [] of NamedTuple(name: String, index: Int32)
          if show = offered.find { |action| action[:name] == "show_location" }
            @actions << Described.new(current.bus, current.path, current.role,
              "Enter Location", action_name: show[:name], action_index: show[:index])
          end
        elsif current.role == "table cell" && !name.empty?
          position = @accessibility.table_cell_position(current.node) rescue nil
          if position && position[1] == 0
            offered = @accessibility.actions_of(current.node) rescue [] of NamedTuple(name: String, index: Int32)
            if activate = offered.find { |action| action[:name] == "activate" }
              @actions << Described.new(current.bus, current.path, current.role,
                name, action_name: activate[:name], action_index: activate[:index])
            end
          end
          # A line already said by something this node is inside of. A views
          # dialog nests a panel whose name is everything below the panel, so
          # the panel's children repeat the panel's name whole or in pieces —
          # the sentence about where passwords are saved arrives three times,
          # once entire and twice in fragments.
        elsif !name.empty? && !SILENT_ROLES.includes?(current.role) &&
              !seen.any? { |said| said == name || said.includes?(name) }
          @lines << name
        end
        now_seen = name.empty? ? seen : seen.dup << name
        child_context = name.empty? ? inherited_name : name
        return if depth >= @max_depth
        # A named cell is the name a reader needed; the cells around it are
        # columns of sizes and dates. An unnamed one is the row wrapper the
        # name cell lives inside, so that one is walked.
        prune = PRUNE_ROLES.includes?(current.role) &&
                !(current.role == "table cell" && name.empty?)
        return if prune
        children = begin
          @accessibility.children_of(current.node)
        rescue
          return
        end
        among = current.role == "table" ? children.first(MAX_ROWS) : children
        # One child of lookahead, so a control can be named by the label beside
        # it. Describing each child once, as the walk already did, is what
        # makes this free.
        pending = nil.as(Described?)
        among.each do |child|
          described = begin
            @accessibility.describe_node(child)
          rescue
            next
          end
          unless pending.nil?
            beside = described.role == "label" ?
              described.name.gsub(/[:\s]+\z/, "") : ""
            enter(pending.not_nil!, depth + 1, now_seen, child_context, beside)
            pending = nil
          end
          pending = described
        end
        enter(pending.not_nil!, depth + 1, now_seen, child_context) unless pending.nil?
      end
    end

    # Opens the accessibility bus. `address` is the bus itself; with no address
    # given the session bus is asked where the accessibility bus is, which is
    # how every assistive technology finds the accessibility bus.
    def self.open(address : String? = nil,
                  session_address : String? = ENV["DBUS_SESSION_BUS_ADDRESS"]?,
                  log : Log? = nil) : Accessibility
      bus_address = address
      if bus_address.nil?
        if session_address.nil? || session_address.empty?
          raise Dbus::Error.new("no session bus, so no accessibility bus to find")
        end
        session = Dbus.connect(session_address)
        begin
          found = session.call(
            destination: "org.a11y.Bus",
            path: "/org/a11y/bus",
            iface: "org.a11y.Bus",
            member: "GetAddress",
          )[0]?
          bus_address = found.as?(String)
        ensure
          session.close
        end
      end
      raise Dbus::Error.new("the session bus named no accessibility bus") if bus_address.nil?
      connection = Dbus.connect(bus_address)
      log.try(&.write("atspi.open", {
        "address" => JSON::Any.new(bus_address),
        "name"    => JSON::Any.new(connection.name),
      }))
      Accessibility.new(connection, log)
    end
  end
end
