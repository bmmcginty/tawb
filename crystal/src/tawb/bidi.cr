require "json"
require "./transport"

module Tawb
  module Bidi
    DEFAULT_TIMEOUT_MS = 30_000

    def self.from_remote(value : JSON::Any?) : JSON::Any
      return JSON::Any.new(nil) unless value
      object = value.as_h?
      return JSON::Any.new(nil) unless object
      type = object["type"]?.try(&.as_s?) || ""
      case type
      when "undefined", "null"
        JSON::Any.new(nil)
      when "string"
        JSON::Any.new(object["value"]?.try(&.as_s?) || "")
      when "boolean"
        JSON::Any.new(object["value"]?.try(&.as_bool?) || false)
      when "number"
        number = object["value"]?
        if number.try(&.as_s?)
          # JSON has no representation for BiDi's non-finite numbers. They do
          # not occur in extracted accessibility items; retain the protocol
          # spelling rather than silently changing it to zero.
          JSON::Any.new(number.not_nil!.as_s)
        else
          number || JSON::Any.new(nil)
        end
      when "bigint"
        JSON::Any.new(object["value"]?.try(&.as_s?) || "0")
      when "array", "set"
        values = object["value"]?.try(&.as_a?) || [] of JSON::Any
        JSON::Any.new(values.map { |item| from_remote(item) })
      when "object", "map"
        output = {} of String => JSON::Any
        entries = object["value"]?.try(&.as_a?) || [] of JSON::Any
        entries.each do |entry|
          pair = entry.as_a
          key_value = pair[0]
          key = key_value.as_s? || from_remote(key_value).raw.to_s
          output[key] = from_remote(pair[1]?)
        end
        JSON::Any.new(output)
      else
        if handle = object["handle"]?.try(&.as_s?)
          reference = {"handle" => JSON::Any.new(handle)}
          if shared = object["sharedId"]?.try(&.as_s?)
            reference["sharedId"] = JSON::Any.new(shared)
          end
          JSON::Any.new(reference)
        else
          JSON::Any.new(nil)
        end
      end
    end

    class Session
      @next_id = 0_i64
      @events = [] of JSON::Any

      def initialize(url : String)
        # This is a session-lifetime connection. Silence means the reader is
        # reading, not that Firefox has gone away; in particular, a terminal
        # prompt or the keyboard wizard can legitimately leave BiDi idle for
        # minutes. Bound each command below, as the JavaScript client does,
        # rather than putting an idle timeout on the socket's read loop.
        @socket = Transport::WebSocket.new(url, read_timeout: nil)
        @mutex = Mutex.new
        @write_mutex = Mutex.new
        @waiters = {} of Int64 => Channel(JSON::Any)
        @event_ready = Channel(Nil).new(1)
        @closed = false
        spawn { read_loop }
      end

      # One fiber owns socket reads. Commands, auth handling, navigation waits,
      # and live collection may all be active together; routing replies by id
      # is what keeps an event consumer from stealing a command's answer.
      def command(method : String, params = {} of String => JSON::Any,
                  timeout_ms : Int32 = DEFAULT_TIMEOUT_MS) : JSON::Any
        response = Channel(JSON::Any).new(1)
        wanted = @mutex.synchronize do
          raise IO::Error.new("BiDi connection is closed") if @closed
          @next_id += 1
          @waiters[@next_id] = response
          @next_id
        end
        begin
          @write_mutex.synchronize do
            @socket.send({
              "id"     => JSON::Any.new(wanted),
              "method" => JSON::Any.new(method),
              "params" => JSON::Any.new(params),
            }.to_json)
          end
        rescue error
          @mutex.synchronize { @waiters.delete(wanted) }
          raise error
        end
        answer = select
        when value = response.receive
          value
        when timeout(timeout_ms.milliseconds)
          @mutex.synchronize { @waiters.delete(wanted) }
          seconds = timeout_ms / 1000.0
          raise IO::TimeoutError.new("#{method} did not answer within #{seconds}s")
        end
        object = answer.as_h
        if object["type"]?.try(&.as_s?) == "error"
          name = object["error"]?.try(&.as_s?) || "BiDi error"
          detail = object["message"]?.try(&.as_s?) || ""
          raise IO::Error.new(detail.empty? ? name : "#{name}: #{detail}")
        end
        object["result"]? || JSON::Any.new(nil)
      end

      def next_event(method : String) : JSON::Any
        loop do
          found = @mutex.synchronize do
            if index = @events.index { |event| event.as_h["method"]?.try(&.as_s?) == method }
              @events.delete_at(index).as_h["params"]? || JSON::Any.new(nil)
            elsif @closed
              raise IO::Error.new("BiDi connection is closed")
            end
          end
          return found.not_nil! if found
          @event_ready.receive
        end
      end

      # The same match, but without waiting: what the browser has already
      # pushed is answered for any of the named methods, anything else is
      # kept for its reader, and an idle socket is simply reported as having
      # nothing. A load-state wait polls this rather than blocking on an
      # event the protocol never promised to send. When a context is given,
      # only events carrying that context answer, and events for any other
      # context stay queued for the reader they belong to: a navigation
      # event describes one browsing context, and treating a frame's or
      # another tab's as this tab's own is how a load wait ends too early.
      def poll_any(methods : Array(String), context : String? = nil) : Tuple(String, JSON::Any)?
        @mutex.synchronize do
          if index = @events.index do |event|
               object = event.as_h
               methods.includes?(object["method"]?.try(&.as_s?) || "") &&
                 (context.nil? ||
                   object["params"]?.try(&.as_h?).try(&.["context"]?.try(&.as_s?)) == context)
             end
            event = @events.delete_at(index).as_h
            return {event["method"].as_s, event["params"]? || JSON::Any.new(nil)}
          end
        end
        nil
      end

      # BiDi delivers no event you have not asked for, channel callbacks
      # included. Failure to subscribe is tolerated exactly as the JavaScript
      # driver tolerates it: the page goes quiet rather than the reader.
      def subscribe(events : Array(String)) : Nil
        names = events.map { |event| JSON::Any.new(event) }
        command("session.subscribe", {"events" => JSON::Any.new(names)})
      rescue
        nil
      end

      def close : Nil
        @mutex.synchronize { @closed = true }
        @socket.close
        wake_closed
      rescue
        wake_closed
      end

      private def read_loop : Nil
        loop do
          message = JSON.parse(@socket.receive)
          object = message.as_h
          if id = object["id"]?.try(&.as_i64?)
            waiter = @mutex.synchronize { @waiters.delete(id) }
            waiter.try(&.send(message))
          else
            @mutex.synchronize { @events << message }
            select
            when @event_ready.send(nil)
            else
            end
          end
        end
      rescue
        @mutex.synchronize { @closed = true }
        wake_closed
      end

      private def wake_closed : Nil
        failed = JSON::Any.new({
          "type" => JSON::Any.new("error"),
          "error" => JSON::Any.new("connection closed"),
          "message" => JSON::Any.new("BiDi connection is closed"),
        })
        waiters = @mutex.synchronize do
          found = @waiters.values
          @waiters.clear
          found
        end
        waiters.each { |waiter| waiter.send(failed) rescue nil }
        select
        when @event_ready.send(nil)
        else
        end
      end
    end
  end
end
