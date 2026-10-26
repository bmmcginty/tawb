require "uri"
require "json"
require "./dbus"
require "./log"

module Tawb
  # A file chooser the browser cannot draw for itself.
  #
  # Both Linux browsers ask a desktop portal for a file or folder rather than
  # drawing one: Chromium's `SelectFileDialogLinuxPortal` and GTK's
  # `GtkFileChooserNative`, which Firefox uses, both call
  # `org.freedesktop.portal.FileChooser`. On a desktop somebody else answers.
  # On a machine where this program had to make the session bus for the
  # browser — a terminal, a container, a browser under Xvfb — nobody answers,
  # and the browser is left holding a chooser that never appears. Chromium
  # never gets as far as drawing one: its only file dialog is the portal.
  #
  # So on a bus this program owns, the portal name is claimed and this answers.
  # It is a frontend rather than a backend: the name the callers use is
  # `org.freedesktop.portal.Desktop`, and no backend is consulted. The
  # desktop's own portal is left alone — the name is claimed only if nobody
  # owns it.
  #
  # One interface is implemented, FileChooser, plus the request object it
  # answers with. Everything else answers "unknown method", which is what a
  # caller gets on a bus with no portal on it at all.
  #
  # The shape of a request is fixed by the specification and is not this
  # program's to choose:
  #
  #   * the client makes up a token, puts it in `handle_token`, and subscribes
  #     to `Response` on `/org/freedesktop/portal/desktop/request/<sender>/<token>`
  #     *before* calling, because the answer may arrive before the call returns;
  #   * the sender is the caller's unique name with the leading colon dropped
  #     and every dot replaced by an underscore;
  #   * the call returns that object path, and the answer arrives later as a
  #     signal on the object path.
  module Portal
    PORTAL_NAME = "org.freedesktop.portal.Desktop"
    PORTAL_PATH = "/org/freedesktop/portal/desktop"
    FILECHOOSER = "org.freedesktop.portal.FileChooser"
    REQUEST     = "org.freedesktop.portal.Request"
    # How a program that is not sandboxed tells the portal what it is. Chromium
    # registers its application id before it uses any portal interface, and a
    # portal that answers "unknown method" is one it treats as not there.
    HOST_REGISTRY = "org.freedesktop.host.portal.Registry"
    PROPERTIES  = "org.freedesktop.DBus.Properties"

    # What this frontend answers for. The real one answers 4 on this machine;
    # a caller uses the number to decide whether to ask for newer options, and
    # claiming more than is implemented would invite exactly those options.
    VERSION = 4_u32

    # The two answers a request can have. Zero is "the reader chose
    # something"; one is "the reader declined", which is what makes Escape a
    # cancellation rather than a chooser that waits for ever.
    RESPONSE_SUCCESS   = 0_u32
    RESPONSE_CANCELLED = 1_u32

    REQUEST_PREFIX = "#{PORTAL_PATH}/request/"

    # Callers build the request path themselves, so it has to be reproducible.
    def self.request_path(sender : String, token : String) : String
      who = sender.sub(/\A:/, "").gsub('.', '_')
      "#{REQUEST_PREFIX}#{who}/#{token}"
    end

    # A file URI for an absolute path. Percent-encoding is not optional: a
    # name with a space in it is the ordinary case, and a URI that does not
    # encode the name is a name the browser cannot open.
    # Bytes a URI may carry as themselves. Everything else — a space, a
    # percent, a non-ASCII letter — is percent-encoded, because a `file://`
    # URI that is not escaped is a name the browser cannot open.
    URI_SAFE = /[A-Za-z0-9\-_.!~*'()]/

    def self.file_uri(path : String) : String
      encoded = path.split('/').map do |part|
        part.each_char.map do |char|
          URI_SAFE.matches?(char.to_s) ? char.to_s : char.bytes.map { |byte| "%%%02X" % byte }.join
        end.join
      end.join('/')
      "file://#{encoded.starts_with?('/') ? "" : "/"}#{encoded}"
    end

    # What one caller asked for.
    record Ask,
      directory : Bool,
      multiple : Bool,
      title : String,
      initial : String,
      name : String,
      saving : Bool

    # One entry of an `a{sv}` dictionary. On the wire a dictionary arrives as
    # the pairs it is made of, so this is a search and not a lookup.
    def self.option(options : Dbus::Value?, name : String) : Dbus::Value?
      return nil unless options.is_a?(Array)
      options.each do |entry|
        next unless entry.is_a?(Array)
        next unless entry[0]? == name
        held = entry[1]?
        return held.value if held.is_a?(Dbus::Variant)
        return held
      end
      nil
    end

    def self.option_bool(options : Dbus::Value?, name : String) : Bool
      option(options, name) == true
    end

    # `current_folder` travels as a byte string with a trailing nul rather than
    # as a string, which is the portal's own convention for a path.
    def self.option_string(options : Dbus::Value?, name : String) : String
      value = option(options, name)
      text = case value
             when String then value
             when Array
               bytes = value.compact_map { |each| each.is_a?(UInt8) ? each : nil }
               String.new(Slice.new(bytes.size) { |index| bytes[index] })
             else
               ""
             end
      text.gsub(/\0+\z/, "")
    end

    # What a caller asked for, after the options that describe a desktop's own
    # chooser — `modal`, `filters`, `current_filter`, `accept_label`,
    # `choices` — have been dropped. None of those survive being turned into a
    # line on a terminal.
    def self.read_options(options : Dbus::Value?, saving : Bool) : Ask
      Ask.new(
        directory: option_bool(options, "directory") && !saving,
        multiple: option_bool(options, "multiple") && !saving,
        title: "",
        initial: option_string(options, "current_folder"),
        name: option_string(options, "current_name"),
        saving: saving,
      )
    end

    # Serve FileChooser on a connection this program already holds.
    #
    # `ask` is what puts the question in front of the reader: it is given what
    # the caller wants and answers with chosen paths, or nil when the reader
    # declined. It runs after the method call has been answered, because the
    # reply has to carry the request path immediately.
    #
    # `allow` is asked whether this sender may raise a chooser at all. The bus
    # is already a boundary, but a chooser is a question put to a person, and
    # only the browser being read should be able to put one.
    class Service
      getter answered : Int32

      def initialize(@connection : Dbus::Connection,
                     ask : Ask -> Array(String)?,
                     @allow : String -> Bool = ->(_sender : String) { true },
                     @log : Log? = nil)
        # The question is answered by whoever is reading, and that is not known
        # when the name is claimed: Chromium decides once, at startup, whether
        # there is a portal at all, so the name has to be owned before the
        # browser starts and the terminal is only ready a moment later.
        @ask = ask
        @pending = {} of String => Ask
        @registered = {} of String => String
        @answered = 0
        @stopped = false
        @counter = 0
        @connection.on_method_call do |message, answer|
          handle(message, answer)
        end
      end

      # Whoever is reading, from now on. Before this the chooser answers
      # "nothing was chosen" rather than leaving a browser waiting.
      def ask=(handler : Ask -> Array(String)?) : Nil
        @ask = handler
      end

      # Every question has been answered.
      def open_requests : Array(String)
        @pending.keys
      end

      def stop : Nil
        @stopped = true
        @pending.each do |path, _ask|
          respond(path, RESPONSE_CANCELLED, nil)
        end
        @pending.clear
      end

      private def handle(message : Dbus::Message, answer : Dbus::Answer) : Bool
        return false if @stopped

        # A request object answered rather than asked: cancellation is the only
        # method one has, and it comes from the client that raised it.
        path = message.path
        return false if path.nil?
        if path.starts_with?(REQUEST_PREFIX)
          return false unless message.iface == REQUEST && message.member == "Close"
          held = @pending.delete(path)
          if held.nil?
            answer.fail("org.freedesktop.DBus.Error.UnknownObject", "no such request")
            return true
          end
          answer.reply
          respond(path, RESPONSE_CANCELLED, nil)
          @log.try(&.write("portal.closed", {} of String => JSON::Any))
          return true
        end
        return false unless path == PORTAL_PATH

        if message.iface == HOST_REGISTRY
          return false unless message.member == "Register"
          app_id = message.body[0]?
          # Remembered rather than checked: this program already knows which
          # browser it launched and which connection is the browser's.
          if app_id.is_a?(String)
            @registered[message.sender || ""] = app_id
            @log.try(&.write("portal.registered", {
              "appId" => JSON::Any.new(app_id[0, 60]),
            }))
          end
          answer.reply
          return true
        end

        if message.iface == PROPERTIES
          if message.member == "Get"
            wanted = message.body[0]?
            property = message.body[1]?
            return false unless wanted == FILECHOOSER
            if property == "version"
              answer.reply("v", [Dbus::Variant.new("u", VERSION).as(Dbus::Argument)])
              return true
            end
            answer.fail("org.freedesktop.DBus.Error.UnknownProperty", "no #{property} here")
            return true
          end
          if message.member == "GetAll"
            entry = [
              "version".as(Dbus::Argument),
              Dbus::Variant.new("u", VERSION).as(Dbus::Argument),
            ].as(Dbus::Argument)
            answer.reply("a{sv}", [[entry].as(Dbus::Argument)])
            return true
          end
          return false
        end

        unless message.iface == FILECHOOSER &&
               (message.member == "OpenFile" || message.member == "SaveFile")
          @log.try(&.write("portal.other", {
            "iface"  => JSON::Any.new((message.iface || "")[0, 60]),
            "member" => JSON::Any.new((message.member || "")[0, 40]),
          }))
          return false
        end
        saving = message.member == "SaveFile"

        sender = message.sender || ""
        unless @allow.call(sender)
          answer.fail("org.freedesktop.portal.Error.NotAllowed",
            "this sender may not choose files")
          return true
        end

        title = message.body[1]?
        options = message.body[2]?
        held = Portal.read_options(options, saving)
        token = Portal.option_string(options, "handle_token")
        @counter += 1
        token = "tawb_#{@counter}" if token.empty?
        request_path = Portal.request_path(sender, token)

        ask = Ask.new(
          directory: held.directory,
          multiple: held.multiple,
          title: title.is_a?(String) ? title : "",
          initial: held.initial,
          name: held.name,
          saving: held.saving,
        )
        @pending[request_path] = ask
        # The path first, then the question: the client is already listening
        # and cannot hear an answer to a call that has not returned.
        answer.reply("o", [request_path.as(Dbus::Argument)])
        @log.try(&.write("portal.chooser", {
          "kind" => JSON::Any.new(ask.directory ? "directory" : "file"),
        }))
        spawn { run(request_path, ask) }
        true
      end

      private def run(path : String, ask : Ask) : Nil
        paths = begin
          @ask.call(ask)
        rescue error
          @log.try(&.write("portal.ask.failed", {
            "error" => JSON::Any.new((error.message || "")[0, 160]),
          }))
          nil
        end
        # A request the client closed while the reader was still choosing has
        # already been answered, with the cancelled code, by the Close that
        # removed it. Answering again would put a second Response on a path
        # the specification gives one answer — and the second one would carry
        # the path the reader chose after the browser had stopped waiting.
        unless @pending.delete(path)
          @log.try(&.write("portal.abandoned", {
            "kind"   => JSON::Any.new(ask.directory ? "directory" : "file"),
            "chosen" => JSON::Any.new((paths || [] of String).size.to_i64),
          }))
          return
        end
        respond(path, paths && !paths.empty? ? RESPONSE_SUCCESS : RESPONSE_CANCELLED, paths)
        @log.try(&.write("portal.responded", {
          "kind"   => JSON::Any.new(ask.directory ? "directory" : "file"),
          "chosen" => JSON::Any.new((paths || [] of String).size.to_i64),
        }))
      end

      private def respond(path : String, code : UInt32, paths : Array(String)?) : Nil
        uris = (paths || [] of String).map { |each| Portal.file_uri(each).as(Dbus::Argument) }
        entry = [
          "uris".as(Dbus::Argument),
          Dbus::Variant.new("as", uris.as(Dbus::Argument)).as(Dbus::Argument),
        ].as(Dbus::Argument)
        @answered += 1
        @connection.emit_signal(
          path: path, iface: REQUEST, member: "Response", signature: "ua{sv}",
          body: [code.as(Dbus::Argument), [entry].as(Dbus::Argument)],
        )
      end

    end
  end
end
