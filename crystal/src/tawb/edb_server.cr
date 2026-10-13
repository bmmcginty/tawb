require "http/server"
require "json"
require "uri"
require "./address"
require "./auth"
require "./log"
require "./reader"

module Tawb
  # Serving the live browser to edbrowse, over http on the loopback address.
  #
  # edbrowse renders html and drives forms better than a line list ever will,
  # and edbrowse is an editor as well as a browser. What edbrowse cannot do is
  # run a page: edbrowse's javascript engine is not a browser engine, and the
  # sites that matter are applications. So the page is run in a real browser,
  # as always, and edbrowse is handed the result as ordinary html from an
  # ordinary http origin.
  #
  # http rather than a protocol plugin, for a reason that is not aesthetic:
  # edbrowse refuses to submit a form to any protocol but http, https, gopher
  # and mailto (edbrowse's html.c, "cannot submit using protocol %s"), so a
  # plugin can show a page but never fill one in. Over http, every part of
  # edbrowse works with no special cases — g, i=, i*, ib, A, rf and the back
  # key.
  #
  # Two rules make refresh behave. Anything that acts on the page answers 302
  # back to the tab's own url, so the buffer never holds an address that would
  # re-click a button when the reader types rf; and every response says
  # no-cache, because edbrowse caches and rf would otherwise hand back the
  # render before last.
  module Edb
    HOST = "127.0.0.1"

    # Let a click's consequences begin before rendering.
    SETTLE = 600.milliseconds

    # How long a real press is given before edbrowse is sent back to look. The
    # things a real press is used on are the things that take a moment to
    # answer — a bot check runs its checks and only then rewrites the page —
    # and edbrowse has no way to notice that on its own: edbrowse fetches
    # once, renders, and sits there. So the answer is held until there is
    # something worth fetching.
    PRESS_SETTLE = 2000.milliseconds

    # How long a click gets to turn into a navigation.
    NAVIGATION_WATCH = 1500.milliseconds

    # The limits the reader's own views walk frames under. The same two,
    # because a second set beside them would drift apart.
    MAX_DEPTH  = 12
    MAX_FRAMES = 24

    # ------------------------------------------------------------------
    # What the server asks of a browser
    #
    # The real one is an engine session (see `edb.cr`); the conformance
    # harness binds a scripted one, and the server cannot tell the difference
    # — which is the point, and the same arrangement the interactive reader's
    # `Reader::CoreEnv` uses.
    # ------------------------------------------------------------------

    record FieldEntry, path : String, tag : String, value : String
    record Applied, applied : Int32, missed : Array(String)
    record Outcome, ok : Bool, how : String = "", why : String = ""

    # One document: the tab's own, or a frame inside it.
    module DocumentEnv
      abstract def url : String

      # The walk the page runs for edbrowse, as the tokens the walk answers
      # with: `{"url", "title", "tokens"}`. See `crystal/assets/edb_extract.js`.
      abstract def extract : JSON::Any

      # The child documents this one has, in the order the markup mentions
      # them, and the ones the markup never mentions. An <iframe> inside a
      # closed shadow root is not findable by walking for elements, so the
      # frame tokens the extractor produced account for some of the child
      # documents and not necessarily all.
      abstract def ordered_frames : Array(DocumentEnv)
      abstract def hidden_frames : Array(DocumentEnv)

      # The reader's answers, put into the live elements, so the site's own
      # handlers, validation and enable/disable logic run exactly as they
      # would have.
      abstract def apply_fields(entries : Array(FieldEntry)) : Applied

      # Press one element. `real` sends a click through the browser's own
      # input pipeline rather than running the element's default action,
      # which is the half that needs to be a person as far as the page is
      # concerned.
      abstract def activate(desc : JSON::Any, real : Bool) : Outcome

      # Focus one element and press Enter on the browser's own keyboard,
      # which is what a person does to a search box.
      abstract def press_enter(desc : JSON::Any) : Bool
    end

    # One tab.
    module TabEnv
      abstract def url : String
      abstract def title : String
      abstract def closed? : Bool
      abstract def goto(url : String) : Nil
      abstract def back : Nil
      abstract def close : Nil

      # The address the document actually holds. The Firefox session caches
      # the url it was last told to visit, so a move through history leaves
      # the cache naming the page before. The document knows.
      abstract def sync_url : Nil

      abstract def document : DocumentEnv

      # The reader's own four line lists — ax, render, inspect, source — as
      # the lines they are. This is how the accessibility tree stays
      # reachable from edbrowse, which matters because it is the view that is
      # right when a page's markup is wrong.
      abstract def view(kind : String) : Array(String)

      # Arming the password intercept, which is per tab on Chromium and does
      # nothing the second time.
      abstract def arm_auth : Nil
    end

    module BrowserEnv
      abstract def name : String
      abstract def alive? : Bool
      abstract def tabs : Array(TabEnv)
      abstract def new_tab : TabEnv
      abstract def attach_auth(&answer : (JSON::Any, String, TabEnv?) -> JSON::Any?) : Nil
      abstract def close : Nil
    end

    # ------------------------------------------------------------------
    # Element identity
    #
    # An id names a descriptor: a path through the document, the tag, the
    # accessible name, the position in document order. The registry only
    # remembers which descriptor got which number, so the same element keeps
    # its id across renders and a link in a buffer from ten minutes ago still
    # means what the link said. Resolution happens in the page, from the
    # descriptor alone (`crystal/assets/edb_resolve.js`), so nothing here is
    # load-bearing state: another process with a connection to the browser
    # could resolve the same id.
    # ------------------------------------------------------------------

    record Record, desc : JSON::Any, kind : String, within : Int32?

    class Registry
      def initialize
        @by_key = {} of String => Int32
        @by_id = {} of Int32 => Record
        @next = 1
      end

      # `kind` is how this id will be used from the other side — a control to
      # press, a field to fill, a form, a frame — because a form submission
      # arrives as names and values with nothing to say which was which.
      #
      # `within` is the id of the frame this element lives in, or nil for the
      # tab's own document. A descriptor is a path through *a* document, and
      # the same path means different elements in different documents, so
      # `within` is part of the key as well as part of the record: acting on
      # an element means knowing which document to look in.
      def id_for(desc : JSON::Any, kind : String = "control", within : Int32? = nil) : Int32
        object = desc.as_h
        tag = object["tag"]?.try(&.as_s?) || ""
        path = object["path"]?.try(&.as_s?) || ""
        name = object["name"]?.try(&.as_s?) || ""
        key = "#{within}|#{tag}|#{path}|#{name}"
        id = @by_key[key]?
        if id.nil?
          id = @next
          @next += 1
          @by_key[key] = id
        end
        # Keep the freshest ordinal: the ordinal is what picks between
        # duplicates when the path has stopped matching.
        @by_id[id] = Record.new(desc, kind, within)
        id
      end

      def get(id : Int32) : Record?
        @by_id[id]?
      end
    end

    # ------------------------------------------------------------------
    # Tabs
    # ------------------------------------------------------------------

    class Tabs
      getter urls : Hash(Int32, String)

      # `urls` and `start_at` are carried over when the browser is replaced:
      # the pages are gone, but the numbers are in the reader's buffer, and a
      # number that still remembers where the number was pointing can be
      # offered back.
      def initialize(@browser : BrowserEnv, @urls = {} of Int32 => String, start_at : Int32 = 1)
        @numbers = {} of TabEnv => Int32
        @pages = {} of Int32 => TabEnv
        @registries = {} of Int32 => Registry
        @next = start_at
      end

      def next_number : Int32
        @next
      end

      def remember(number : Int32, url : String?) : Nil
        return if url.nil? || url.empty? || url == "about:blank"
        @urls[number] = url
      end

      def last_url(number : Int32) : String?
        @urls[number]?
      end

      def number_for(tab : TabEnv) : Int32
        number = @numbers[tab]?
        if number.nil?
          number = @next
          @next += 1
          @numbers[tab] = number
          @pages[number] = tab
          @registries[number] = Registry.new
        end
        number
      end

      def list : Array(NamedTuple(number: Int32, tab: TabEnv))
        @browser.tabs.map { |tab| {number: number_for(tab), tab: tab} }
      end

      def page(number : Int32) : TabEnv?
        # Numbering happens as tabs are listed, so ask for the list first: a
        # reader who goes straight to a tab's own address — which is the
        # address this program prints when it starts, and the one their buffer
        # holds after a redirect — must not be told the tab is gone merely
        # because nothing had counted the tabs yet.
        list unless @pages.has_key?(number)
        tab = @pages[number]?
        return nil unless tab
        begin
          return nil if tab.closed?
        rescue
          # A session that does not answer about a tab's being closed.
        end
        tab
      end

      def registry(number : Int32) : Registry
        @registries[number] ||= Registry.new
      end
    end

    # ------------------------------------------------------------------
    # Writing the page out for edbrowse
    # ------------------------------------------------------------------

    def self.escape_html(text) : String
      text.to_s
        .gsub('&', "&amp;").gsub('<', "&lt;").gsub('>', "&gt;")
        .gsub('"', "&quot;")
    end

    # The address bar.
    #
    # There is no key here to press for one, and a reader should not have to
    # remember an incantation to reach the web — least of all `b tweb://` plus
    # a scheme they were not thinking about. So every page tweb serves begins
    # with a field to type an address into, which is the one form of
    # instruction that cannot be forgotten: the field is in the buffer, on
    # line one, where the reader already is.
    #
    # One line, one field, one button, because edbrowse numbers input fields
    # within the current line: on line 1 of any tweb page,
    #
    #     i=example.com
    #     i*
    #
    # with no number to count out and no url to remember. `action` is relative
    # to the <base href> every page carries, which points at the tab, so a
    # tab's own bar sends the address into that tab. The pages tweb writes
    # itself have no tab to stay in and pass an absolute action.
    #
    # `back` puts the tab's own back button beside Go. Back is a link rather
    # than a second submit button on purpose: edbrowse numbers fields within a
    # line, and a second button would turn the address field's `i*` into
    # `i2*`, which is exactly the counting the one-line design exists to
    # avoid. As a link it is one `g`.
    #
    # The field holds the address of the page being read, the way a url bar
    # does. That is worth more than a blank field: the field is the only place
    # the reader can see where they actually are — edbrowse's own fu names the
    # loopback address this server answers on — and an address that is already
    # there can be edited into a neighbouring one, which is most of what a url
    # bar is for. edbrowse's i= replaces the field, so typing a fresh address
    # costs nothing.
    def self.open_bar(action : String = "../open", back : Bool = false, value : String = "") : String
      button = back ? %( <a href="back">Back</a>) : ""
      %(<p><form action="#{action}" method="post">Open: ) +
        %(<input name="url" value="#{escape_html(value)}"> ) +
        %(<input type="submit" name="go" value="Go">) +
        %(</form>#{button}</p>)
    end

    # Tokens in, html out. The only interesting decisions are which elements
    # become links (all activatable ones, named by whatever names them, so an
    # icon button is not an empty {} in the buffer) and how fields that sit
    # outside any form are handled.
    def self.tokens_to_html(extracted : JSON::Any, registry : Registry, base : String,
                            tab : Int32, within : Int32? = nil) : String
      parts = [] of String
      form_depth = 0
      form_id = 0
      saw_submit = false
      pressable_form = false
      last_submit_id = 0
      last_submit_name = "it"

      # A token spliced in from a frame says which document the token came
      # from, and the token's ids have to record that or acting on one would
      # look in the wrong place. `within` stays the default, for the page that
      # renders a single frame on its own.
      where = within

      object = extracted.as_h
      tokens = object["tokens"]?.try(&.as_a?) || [] of JSON::Any
      tokens.each do |raw|
        token = raw.as_h
        where = if token.has_key?("within")
                  token["within"].as_i64?.try(&.to_i32)
                else
                  within
                end
        # edbrowse can fill in a form and submit it, and that is the right way
        # to work an ordinary page. It is no way to work these two.
        #
        # A control behind a closed shadow root cannot be ticked by setting a
        # property on it: that is what the field-applying walk does, and a bot
        # check — which is what a closed shadow root is usually hiding —
        # ignores a property, because the bot check can see perfectly well
        # that nobody pressed anything. And a form on a frame's own page is
        # not a form on the page edbrowse is reading, so submitting the form
        # from there has nowhere to send the values.
        #
        # So those get a plain link as well. edbrowse can always follow a link.
        needs_pressing = (token["pierced"]?.try(&.as_bool?) || false) || !within.nil?

        case token["kind"].as_s
        when "text"
          parts << escape_html(token["text"]?.try(&.as_s?) || "")
        when "open"
          parts << "<#{token["tag"].as_s}>"
        when "close"
          parts << "</#{token["tag"].as_s}>"
        when "image"
          parts << %(<img alt="#{escape_html(token["text"]?.try(&.as_s?) || "")}">)
        when "link"
          id = registry.id_for(token["desc"], "control", where)
          name = token["name"]?.try(&.as_s?) || ""
          navigational = token["navigational"]?.try(&.as_bool?) || false
          if form_depth > 0 && !navigational
            # Inside a form, a control that is not a navigation is the form's
            # submit button in all but name — most sites build one out of an
            # anchor or a div. Emitting the control as a real submit button is
            # what lets edbrowse's i* send the fields the reader just filled
            # in; left as a link, g would activate the control with the old
            # values still in the page.
            parts << %(<input type="submit" name="e#{id}" value="#{escape_html(name)}">)
            saw_submit = true
            last_submit_id = id
            last_submit_name = name
          else
            # Following a link normally runs the element's own default action,
            # which is right for reading and useless for a challenge: a
            # default action is not a person pressing anything, and the whole
            # job of the thing behind a closed shadow root is to tell the
            # difference. Where that is what is being looked at, the link
            # presses the element properly and waits for the page to answer
            # before edbrowse is sent back to look.
            suffix = needs_pressing ? "/click" : ""
            parts << %(<a href="e#{id}#{suffix}">#{escape_html(name)}</a>)
          end
        when "frame"
          # The frame's contents follow this line, spliced in where the frame
          # sits. The link stays because the walk does not always get there —
          # past the depth limit, or once the frame budget is spent — and
          # because a frame on its own page is sometimes the easier read.
          id = token["frameId"]?.try(&.as_i64?).try(&.to_i32) ||
               registry.id_for(token["desc"], "frame", where)
          name = token["name"]?.try(&.as_s?) || ""
          parts << %(<p><a href="f#{id}">[frame: #{escape_html(name)}]</a></p>)
        when "form-open"
          pressable_form = needs_pressing
          id = registry.id_for(token["desc"], "form", where)
          parts << %(<form action="submit/e#{id}" method="post">)
          form_depth += 1
          form_id = id
          saw_submit = false
        when "form-close"
          if form_depth > 0
            # A form with nothing to press is common on an application, where
            # the page submits in script and the reader is expected to press
            # Enter. Give edbrowse something to press; the server side knows
            # that pressing it means "fill these in, then press Enter in the
            # page".
            unless saw_submit
              parts << %(<input type="submit" name="e#{form_id}" value="Submit">)
            end
            parts << "</form>"
            # Submitting from here would send the values to a document that is
            # not the one the form is in. Pressing the form's own control is
            # the thing that works, so offer it.
            if pressable_form && last_submit_id != 0
              parts << %(<p><a href="e#{last_submit_id}/click">press #{escape_html(last_submit_name)}</a></p>)
            end
            pressable_form = false
            last_submit_id = 0
            form_depth -= 1
          end
        when "field"
          type = token["type"]?.try(&.as_s?) || ""
          is_button = type.in?("submit", "button", "image", "reset")
          id = registry.id_for(token["desc"], is_button ? "control" : "field", where)
          if is_button
            last_submit_id = id
            value = token["value"]?.try(&.as_s?) || ""
            label = token["label"]?.try(&.as_s?) || ""
            last_submit_name = value.empty? ? (label.empty? ? "it" : label) : value
          end
          loose = form_depth == 0
          saw_submit = true if !loose && is_button
          # A field with no form around it is the normal case on an
          # application: the site collects the field in script. edbrowse can
          # only submit fields that are in a form, so each loose field gets
          # one of its own, whose button means "type this in and press Enter"
          # — which is what a person does to a search box.
          parts << %(<form action="submit/e#{id}" method="post">) if loose
          parts << field_html(token, id, needs_pressing)
          parts << %(<input type="submit" name="enter" value="Enter"></form>) if loose
        end
      end

      url = object["url"]?.try(&.as_s?) || ""
      raw_title = object["title"]?.try(&.as_s?)
      title = escape_html(raw_title.nil? || raw_title.empty? ? url : raw_title)
      # One line of this program's own at the top, and only one: the line says
      # which page this really is — edbrowse's own fu would only show the
      # loopback address — and the line is how the other four representations
      # and the tab list are reached, since there is no key here to press for
      # them.
      header = %(<p>tweb #{tab}: #{escape_html(url)}) +
               %( <a href="ax">ax</a> <a href="render">text</a> <a href="inspect">inspect</a> <a href="source">source</a>) +
               %( <a href="../tabs">tabs</a></p>)
      String.build do |html|
        html << %(<html><head><title>#{title}</title><base href="#{escape_html(base)}"></head>\n)
        html << "<body>\n" << open_bar("open", back: true, value: url) << "\n"
        html << header << "\n" << parts.join('\n') << "\n</body></html>\n"
      end
    end

    def self.field_html(token : Hash(String, JSON::Any), id : Int32,
                        pressable : Bool = false) : String
      name = "e#{id}"
      label = escape_html(token["label"]?.try(&.as_s?) || "")
      tag = token["tag"]?.try(&.as_s?) || ""
      value = token["value"]?.try(&.as_s?) || ""

      if tag == "select"
        options = (token["options"]?.try(&.as_a?) || [] of JSON::Any).map do |raw|
          option = raw.as_h
          selected = (option["selected"]?.try(&.as_bool?) || false) ? " selected" : ""
          disabled = (option["disabled"]?.try(&.as_bool?) || false) ? " disabled" : ""
          %(<option#{selected}#{disabled}>#{escape_html(option["text"]?.try(&.as_s?) || "")}</option>)
        end.join
        return %(#{label}: <select name="#{name}">#{options}</select>)
      end

      if tag == "textarea"
        return %(#{label}: <textarea name="#{name}">#{escape_html(value)}</textarea>)
      end

      type = token["type"]?.try(&.as_s?) || ""
      if type.in?("submit", "button", "reset", "image")
        shown = value.empty? ? (token["label"]?.try(&.as_s?) || "") : value
        return %(<input type="submit" name="#{name}" value="#{escape_html(shown)}">)
      end
      if type == "checkbox" || type == "radio"
        checked = (token["checked"]?.try(&.as_bool?) || false) ? " checked" : ""
        box = %(#{label}: <input type="#{type}" name="#{name}"#{checked}>)
        # Following this presses the control the way a person would, and
        # answers only once the page has had a moment to react — so what
        # edbrowse fetches next is the page as the press left it.
        return pressable ? %(#{box} <a href="#{name}/click">press #{label.empty? ? "it" : label}</a>) : box
      end
      return "" if type == "hidden"
      kind = type == "password" ? "password" : "text"
      %(#{label}: <input type="#{kind}" name="#{name}" value="#{escape_html(value)}">)
    end

    # The other four representations, as edbrowse can hold them: the reader's
    # own line lists, preformatted so edbrowse leaves them alone.
    def self.lines_to_html(title : String, base : String, heading : String,
                           lines : Array(String), here : String = "") : String
      body = lines.map { |line| escape_html(line) }.join('\n')
      String.build do |html|
        html << %(<html><head><title>#{escape_html(title)}</title>)
        html << %(<base href="#{escape_html(base)}"></head>\n)
        html << "<body>\n" << open_bar("open", back: true, value: here) << "\n"
        html << %(<p><a href="./">the page</a> <a href="../tabs">tabs</a></p>\n)
        html << "<h1>#{escape_html(heading)}</h1>\n"
        html << "<pre>\n#{body}\n</pre>\n</body></html>\n"
      end
    end

    # ------------------------------------------------------------------
    # What the reader typed
    # ------------------------------------------------------------------

    # Every url bar in the world accepts `timeanddate.com`, and a reader who
    # has just typed a page's name should not have to think about which of two
    # transport protocols a site prefers. What arrives here is whatever came
    # after tweb:// — or whatever was typed into the open field on the page —
    # and becomes something a browser can be sent to, or an admission that it
    # is not an address at all.
    #
    # Which of the two it is is decided in `address.cr`, since the terminal's
    # own address bar has to decide exactly the same thing and there is no
    # reason for two sets of rules. What differs is what happens to something
    # that is not an address: the terminal searches for it, the way a browser
    # does, and here it is offered as a link instead — a page is a place a
    # reader can leave and come back to, and a redirect they did not ask for
    # is one they cannot undo.
    record Target, url : String? = nil, search : String? = nil, error : String? = nil

    def self.normalise_target(text : String?) : Target
      resolved = Address.resolve(text)
      if error = resolved["error"]?.try(&.as_s?)
        return Target.new(error: error)
      end
      if resolved["searched"]?.try(&.as_bool?)
        return Target.new(search: resolved["words"]?.try(&.as_s?) || "")
      end
      Target.new(url: resolved["url"]?.try(&.as_s?) || "")
    end

    # The browser libraries describe failures to whoever is driving them, not
    # to whoever is reading. "Target page, context or browser has been closed"
    # names no cause and suggests no action; the reader wants the sentence a
    # person would say. Anything not recognised is passed through unchanged,
    # because a message that was not anticipated is still better than one that
    # was invented.
    EXPLANATIONS = [
      {/Target page, context or browser has been closed|the browser closed/i,
       "the browser closed. Ask for a page again and tweb will start another."},
      {/Cannot navigate to invalid URL|Invalid url/i,
       "that is not an address a browser can be sent to."},
      {/net::ERR_NAME_NOT_RESOLVED|NS_ERROR_UNKNOWN_HOST/i,
       "that host does not resolve."},
      {/net::ERR_CONNECTION_REFUSED|NS_ERROR_CONNECTION_REFUSED/i,
       "nothing is listening there."},
      {/Timeout .* exceeded|did not answer within/i,
       "the browser did not answer in time. Type rf to try again."},
    ]

    def self.explain(message : String) : String
      EXPLANATIONS.each do |pattern, said|
        return said if pattern.matches?(message)
      end
      message
    end

    # ------------------------------------------------------------------
    # The server
    # ------------------------------------------------------------------

    # What a walk of one document produced, with the frames inside it spliced
    # in where they sit.
    class Walked
      property url : String
      property title : String
      property tokens : Array(JSON::Any)
      property frames : Int32

      def initialize(@url = "", @title = "", @tokens = [] of JSON::Any, @frames = 0)
      end

      def to_json_any : JSON::Any
        JSON::Any.new({
          "url"    => JSON::Any.new(@url),
          "title"  => JSON::Any.new(@title),
          "tokens" => JSON::Any.new(@tokens),
        })
      end
    end

    class Server
      getter port : Int32
      getter token : String

      def initialize(browser : BrowserEnv, @reopen : Proc(BrowserEnv)? = nil,
                     port : Int32 = 0, token : String? = nil, @log : Log? = nil,
                     @settle : Time::Span = SETTLE,
                     @press_settle : Time::Span = PRESS_SETTLE,
                     @navigation_watch : Time::Span = NAVIGATION_WATCH)
        @browser = browser
        @tabs = Tabs.new(browser)
        @token = token || Random::Secure.hex(9)
        # Passwords, and the challenges nobody has answered yet.
        #
        # The reader is in edbrowse, waiting on the response to the very
        # request that raised the challenge, so there is nobody to ask while
        # the challenge is up: asking would mean holding that response open
        # until an answer arrived through a request the reader cannot make
        # until it does. So a challenge with no known password is cancelled —
        # which loads the 401's own body rather than hanging — and remembered
        # against the tab, and the tab's next page is a form asking for it.
        # Not what a browser does, and it is what works in a line browser.
        @credentials = Auth::Credentials.new(nil,
          ->(event : String, fields : Hash(String, JSON::Any)) { @log.try(&.write(event, fields)); nil })
        @waiting = {} of Int32 => JSON::Any
        @starting = false
        @server = HTTP::Server.new do |context|
          serve(context)
        end
        @port = @server.bind_tcp(HOST, port).port
        attach_auth(browser)
      end

      def browser : BrowserEnv
        @browser
      end

      def tabs : Tabs
        @tabs
      end

      def url : String
        "http://#{HOST}:#{@port}/t/#{@token}/tabs"
      end

      def tab_url(number : Int32) : String
        "/t/#{@token}/#{number}/"
      end

      def absolute_tab_url(number : Int32) : String
        "http://#{HOST}:#{@port}#{tab_url(number)}"
      end

      def listen : Nil
        @server.listen
      end

      def close : Nil
        @server.close
      end

      private def open_url(target : String, number : Int32? = nil) : String
        encoded = URI.encode_www_form(target)
        number.nil? ? "/t/#{@token}/open?url=#{encoded}" : "/t/#{@token}/#{number}/open?url=#{encoded}"
      end

      private def back_to(number : Int32, within : Int32?) : String
        within.nil? ? tab_url(number) : "#{tab_url(number)}f#{within}"
      end

      private def attach_auth(active : BrowserEnv) : Nil
        active.attach_auth do |raw, id, tab|
          answer = @credentials.answer(raw, id)
          if answer.nil?
            challenge = Auth.normalise_challenge(raw)
            number = tab ? @tabs.number_for(tab) : nil
            @waiting[number] = challenge if number
            @log.try(&.write("edb.auth.asked", {
              "tab"    => number ? JSON::Any.new(number.to_i64) : JSON::Any.new(nil),
              "origin" => challenge.as_h["origin"]? || JSON::Any.new(nil),
              "realm"  => challenge.as_h["realm"]? || JSON::Any.new(nil),
            }))
          end
          answer
        end
      rescue
        # A session with no password intercept to arm.
      end

      # A browser is the reader's to close, and they do — the window goes
      # away, this process keeps a session that answers every call with
      # "the browser closed", and the reader gets that sentence instead of a
      # page for the rest of the session. So notice instead: ask the session
      # whether the browser is still there before touching it, and if it is
      # not, start one again exactly the way this session started the first
      # one. Tab numbers survive the restart pointing at nothing, which is why
      # `Tabs` carries the urls over: the reader is offered the page back
      # rather than told a number is meaningless.
      #
      # Answers with true when a new browser had to be started, so the caller
      # can say so rather than silently answering about a page the reader
      # never opened.
      private def ensure_browser : Bool
        return false if alive?
        if @starting
          # Starting one takes seconds, and two requests arriving during those
          # seconds must not start two browsers.
          while @starting
            sleep 50.milliseconds
          end
          return true
        end
        reopen = @reopen
        unless reopen
          raise Exception.new("the browser has closed, and nothing here knows how to start another")
        end
        @log.try(&.write("edb.browser.gone", {"engine" => JSON::Any.new(@browser.name)}))
        @starting = true
        begin
          fresh = reopen.call
          @browser = fresh
          @tabs = Tabs.new(fresh, @tabs.urls, @tabs.next_number)
          @waiting.clear
          attach_auth(fresh)
          @log.try(&.write("edb.browser.restarted", {"engine" => JSON::Any.new(fresh.name)}))
        ensure
          @starting = false
        end
        true
      end

      private def alive? : Bool
        @browser.alive?
      rescue
        false
      end

      # ----------------------------------------------------------------
      # Reading
      # ----------------------------------------------------------------

      # Documents the page's own markup never mentions, in the order the
      # browser reports them.
      private record Unmentioned,
        ordered : Array(DocumentEnv),
        hidden : Array(DocumentEnv)

      private def unmentioned_frames(document : DocumentEnv) : Unmentioned
        ordered = begin
          document.ordered_frames
        rescue
          [] of DocumentEnv
        end
        hidden = begin
          document.hidden_frames
        rescue
          [] of DocumentEnv
        end
        Unmentioned.new(ordered, hidden)
      end

      private record Read,
        extracted : JSON::Any,
        ordered : Array(DocumentEnv),
        hidden : Array(DocumentEnv)

      private def read_page(document : DocumentEnv) : Read
        extracted = document.extract
        found = unmentioned_frames(document)
        tokens = extracted.as_h["tokens"]?.try(&.as_a?) || [] of JSON::Any
        # Appended rather than placed, because nothing says where in the page
        # they belonged — the same answer the reader gives.
        found.hidden.each_with_index do |child, index|
          host = child.url
          begin
            parsed = URI.parse(host)
            host = parsed.host || host
          rescue
            # Keep the address raw.
          end
          tokens << JSON::Any.new({
            "kind" => JSON::Any.new("frame"),
            "desc" => JSON::Any.new({
              "tag"     => JSON::Any.new("iframe"),
              "path"    => JSON::Any.new("hidden/#{index}"),
              "name"    => JSON::Any.new(host),
              "ordinal" => JSON::Any.new(index.to_i64),
            }),
            "name" => JSON::Any.new(host),
          })
        end
        object = extracted.as_h
        object["tokens"] = JSON::Any.new(tokens)
        Read.new(JSON::Any.new(object), found.ordered, found.hidden)
      end

      # The frame a descriptor names. Frames the markup mentioned are matched
      # by position — the Nth frame element belongs to the Nth child context,
      # the same assumption the reader has always made — and ones the markup
      # did not mention are named by where they sat in the browser's own list,
      # which is the only order they have.
      private def frame_for(scope : DocumentEnv, desc : JSON::Any) : DocumentEnv?
        found = unmentioned_frames(scope)
        path = desc.as_h["path"]?.try(&.as_s?) || ""
        if path.starts_with?("hidden/")
          return found.hidden[path["hidden/".size..].to_i? || 0]?
        end
        index = path.split('/').last?.try(&.to_i?) || 0
        return nil if found.ordered.empty?
        found.ordered[Math.min(index, found.ordered.size - 1)]?
      end

      # The page, with the frames inside it spliced in where they sit — the
      # same tree the reader's own views walk, and no further, because those
      # limits were measured on real pages and a second set beside them would
      # drift apart.
      #
      # Until frames were spliced in, a frame was one line saying [frame: …]
      # that had to be followed to a page of its own before anything in it
      # could be pressed. A Cloudflare checkbox, an embedded player, a comment
      # thread: all of them are frames, and none of them are optional reading.
      #
      # Ids are handed out here rather than in `tokens_to_html`, because a
      # frame's id is what the frame's contents are recorded as living in, and
      # the walk has to know the id before the walk descends.
      private def read_tree(document : DocumentEnv, registry : Registry,
                            within : Int32? = nil) : Walked
        walked = Walked.new
        budget = [MAX_FRAMES]
        walk_into(document, registry, within, 0, budget, Set(String).new, walked)
        walked
      end

      private def walk_into(document : DocumentEnv, registry : Registry, within : Int32?,
                            depth : Int32, budget : Array(Int32), seen : Set(String),
                            walked : Walked) : Nil
        read = begin
          read_page(document)
        rescue
          # Navigated or detached while it was being read. The line naming it
          # is already in the buffer; the reader can follow that.
          @log.try(&.write("edb.frame.unread", {
            "depth" => JSON::Any.new(depth.to_i64),
            "url"   => JSON::Any.new(document.url[0, Math.min(document.url.size, 100)]),
          }))
          return
        end
        object = read.extracted.as_h
        if depth == 0
          walked.url = object["url"]?.try(&.as_s?) || ""
          walked.title = object["title"]?.try(&.as_s?) || ""
        end

        ordinal = 0
        (object["tokens"]?.try(&.as_a?) || [] of JSON::Any).each do |raw|
          stamped = raw.as_h.dup
          stamped["within"] = within ? JSON::Any.new(within.to_i64) : JSON::Any.new(nil)
          walked.tokens << JSON::Any.new(stamped)
          next unless stamped["kind"].as_s == "frame"

          walked.frames += 1
          frame_id = registry.id_for(stamped["desc"], "frame", within)
          stamped["frameId"] = JSON::Any.new(frame_id.to_i64)
          walked.tokens[-1] = JSON::Any.new(stamped)

          # Frames the markup mentioned are matched by position; the ones the
          # markup did not mention are named by where they sat in the
          # browser's own list. The same two answers `frame_for` gives, so a
          # spliced frame and the link beside it always mean the same frame.
          path = stamped["desc"].as_h["path"]?.try(&.as_s?) || ""
          is_hidden = path.starts_with?("hidden/")
          child = if is_hidden
                    read.hidden[path["hidden/".size..].to_i? || 0]?
                  else
                    read.ordered[ordinal]?
                  end
          ordinal += 1 unless is_hidden
          next if child.nil? || depth + 1 > MAX_DEPTH || budget[0] <= 0

          url = child.url
          # about:blank frames are placeholders, and a frame that reappears at
          # the same url inside itself would recurse forever.
          next if url.empty? || url == "about:blank" || seen.includes?(url)

          budget[0] -= 1
          walk_into(child, registry, frame_id, depth + 1, budget, seen | Set{url}, walked)
        end
      end

      # A frame inside a frame is named by a chain of ids, so walk the chain:
      # each record says which document the record was read in, and the one at
      # the end of the chain is the tab's own.
      private def document_of(tab : TabEnv, registry : Registry, within : Int32?) : DocumentEnv?
        return tab.document if within.nil?
        record = registry.get(within)
        return nil unless record
        parent = document_of(tab, registry, record.within)
        return nil unless parent
        frame_for(parent, record.desc)
      end

      # ----------------------------------------------------------------
      # Waiting
      # ----------------------------------------------------------------

      # After something is pressed, wait long enough to be describing the page
      # the reader will see rather than the one they left. A click that
      # navigates is the slow case and the one worth waiting for; a click that
      # only changes the page in place gets the short wait and no more.
      private def settle_after(tab : TabEnv, before : String, watch : Time::Span) : Bool
        deadline = Time.instant + watch
        while Time.instant < deadline
          sleep 120.milliseconds
          now = begin
            tab.url
          rescue
            before
          end
          return true if now != before
        end
        false
      end

      # ----------------------------------------------------------------
      # Answering
      # ----------------------------------------------------------------

      private def send_html(context : HTTP::Server::Context, status : Int32, body : String) : Nil
        response = context.response
        response.status_code = status
        response.headers["content-type"] = "text/html; charset=utf-8"
        # edbrowse caches, and rf would hand back the render before last.
        response.headers["cache-control"] = "no-cache, no-store"
        response.headers["pragma"] = "no-cache"
        response.print(body)
      end

      private def redirect(context : HTTP::Server::Context, to : String) : Nil
        response = context.response
        response.status_code = 302
        response.headers["location"] = to
        response.headers["cache-control"] = "no-cache, no-store"
        response.print("")
      end

      # Pages of this program's own — the tab list, and everything tweb has to
      # say when it cannot do what was asked — carry the address bar too,
      # because those are exactly the pages a reader is on when they want to
      # go somewhere else.
      #
      # And a <base>, because the entry-point plugin can land the reader here
      # directly (`b tweb://tabs`), and then the buffer's own filename is a
      # tweb:// url that no relative link on this page resolves against.
      private def ours(context : HTTP::Server::Context, title : String, body : String) : Nil
        send_html(context, 200, String.build do |html|
          html << %(<html><head><title>#{Edb.escape_html(title)}</title>)
          html << %(<base href="http://#{HOST}:#{@port}/t/#{@token}/"></head>
)
          html << "<body>
" << Edb.open_bar("/t/#{@token}/open") << "
"
          html << body << "
</body></html>
"
        end)
      end

      # A tab number that names nothing: closed by the reader, or lost with
      # the browser it lived in. Either way the useful answer is the page the
      # number held.
      private def gone_tab(context : HTTP::Server::Context, number : Int32,
                           restarted : Bool = false) : Nil
        last = @tabs.last_url(number)
        said = restarted ?
          "The browser closed while you were reading it, and tweb has started another." :
          "That tab is not open any more."
        links = [%(<a href="/t/#{@token}/tabs">the tabs</a>)]
        if last
          links.unshift(%(<a href="#{open_url(last)}">open #{Edb.escape_html(last)} again</a>))
        end
        ours(context, "that tab is gone", "<p>#{said}</p>\n<p>#{links.join(" — ")}</p>")
      end

      # What the reader typed, turned into a page. `existing` is the tab they
      # were reading; without one, a new tab. The answers are the same either
      # way, and so is the redirect: back to a tab's own address, so the
      # buffer never holds the request that got there.
      private def open_typed(context : HTTP::Server::Context, typed : String?,
                             existing : NamedTuple(tab: TabEnv, number: Int32)? = nil) : Nil
        target = Edb.normalise_target(typed)
        if error = target.error
          return send_html(context, 400,
            "<html><body><p>tweb: #{Edb.escape_html(error)}</p></body></html>")
        end
        if words = target.search
          return ours(context, "not an address",
            "<p>#{Edb.escape_html(words)} is not a url — it has no host in it.</p>\n" +
            %(<p><a href="#{open_url(Address.search_url(words), existing.try(&.[:number]))}">) +
            %(search the web for it</a> — <a href="/t/#{@token}/tabs">the tabs</a></p>))
        end
        wanted = target.url.not_nil!
        tab = existing ? existing[:tab] : @browser.new_tab
        begin
          tab.arm_auth
        rescue
        end
        # A deliberate address is also how a reader who left a challenge
        # unanswered says they would like to be asked again.
        @credentials.reconsider
        tab.goto(wanted)
        sleep @settle
        tab.sync_url
        number = existing ? existing[:number] : @tabs.number_for(tab)
        @tabs.remember(number, wanted)
        @log.try(&.write("edb.open", {
          "tab"    => JSON::Any.new(number.to_i64),
          "url"    => JSON::Any.new(wanted[0, Math.min(wanted.size, 120)]),
          "reused" => JSON::Any.new(!existing.nil?),
        }))
        redirect(context, tab_url(number))
      end

      # The form. Plain enough for edbrowse to fill in with i= and submit, and
      # a POST because a password in a query string would be written into the
      # buffer's own filename and into this server's request handling.
      private def sign_in(context : HTTP::Server::Context, number : Int32,
                          challenge : JSON::Any) : Nil
        asked = Reader.describe_challenge(challenge)
        ours(context, "a password is wanted",
          "<p>#{Edb.escape_html(asked)} wants a password.</p>\n" +
          %(<form method="post" action="#{number}/auth">\n) +
          %(<p>User <input type="text" name="user"></p>\n) +
          %(<p>Password <input type="password" name="password"></p>\n) +
          %(<p><input type="submit" value="sign in"></p>\n) +
          "</form>\n" +
          %(<p><a href="#{number}/?show=1">show the page the server sent instead</a>) +
          %( — <a href="/t/#{@token}/tabs">the tabs</a></p>))
      end

      private def render(context : HTTP::Server::Context, number : Int32, base : String,
                         show : Bool = false) : Nil
        tab = @tabs.page(number)
        return gone_tab(context, number) unless tab
        # A challenge nobody has answered stands in front of the page the
        # challenge belongs to, until the reader answers the challenge or asks
        # to see what the server sent.
        if @waiting.has_key?(number)
          return sign_in(context, number, @waiting[number]) unless show
          @waiting.delete(number)
        end
        begin
          tab.arm_auth
        rescue
        end
        @tabs.remember(number, tab.url)
        registry = @tabs.registry(number)
        walked = read_tree(tab.document, registry)
        html = Edb.tokens_to_html(walked.to_json_any, registry, base, number)
        @log.try(&.write("edb.render", {
          "tab"    => JSON::Any.new(number.to_i64),
          "tokens" => JSON::Any.new(walked.tokens.size.to_i64),
          "frames" => JSON::Any.new(walked.frames.to_i64),
          "bytes"  => JSON::Any.new(html.bytesize.to_i64),
        }))
        send_html(context, 200, html)
      end

      HEADINGS = {
        "ax"      => "Accessibility tree",
        "render"  => "Visible text",
        "inspect" => "Accessibility with markup",
        "source"  => "Markup",
      }

      private def render_view(context : HTTP::Server::Context, number : Int32,
                              view : String, base : String) : Nil
        tab = @tabs.page(number)
        return gone_tab(context, number) unless tab
        lines = tab.view(view)
        heading = HEADINGS[view]? || view
        @log.try(&.write("edb.view", {
          "tab"    => JSON::Any.new(number.to_i64),
          "view"   => JSON::Any.new(view),
          "blocks" => JSON::Any.new(lines.size.to_i64),
        }))
        send_html(context, 200, Edb.lines_to_html(
          "#{heading} — tab #{number}", base, heading, lines, tab.url))
      end

      private def typed_address(context : HTTP::Server::Context, query : URI::Params) : String?
        if context.request.method == "POST"
          body = context.request.body.try(&.gets_to_end) || ""
          URI::Params.parse(body)["url"]?
        else
          query["url"]?
        end
      end

      # ----------------------------------------------------------------
      # Routing
      # ----------------------------------------------------------------

      private def serve(context : HTTP::Server::Context) : Nil
        route(context)
      rescue error
        message = error.message || error.class.name
        @log.try(&.write("edb.error", {
          "url"   => JSON::Any.new(context.request.resource),
          "error" => JSON::Any.new(message[0, Math.min(message.size, 200)]),
        }))
        send_html(context, 500,
          "<html><body><p>tweb: #{Edb.escape_html(Edb.explain(message))}</p>" +
          %(<p><a href="/t/#{@token}/tabs">the tabs</a></p></body></html>))
      end

      private def route(context : HTTP::Server::Context) : Nil
        uri = URI.parse(context.request.resource)
        query = URI::Params.parse(uri.query || "")
        parts = (uri.path || "/").split('/').reject(&.empty?)

        # /t/<token>/...
        unless parts[0]? == "t" && parts[1]? == @token
          return send_html(context, 404, "<html><body><p>tweb: no such page</p></body></html>")
        end
        rest = parts[2..]

        # Before anything touches the browser, make sure there is one.
        restarted = ensure_browser

        if rest.empty? || rest[0] == "tabs"
          rows = @tabs.list.map do |entry|
            title = begin
              entry[:tab].title
            rescue
              entry[:tab].url
            end
            shown = title.empty? ? entry[:tab].url : title
            %(<p><a href="#{entry[:number]}/">#{Edb.escape_html(shown)}</a>) +
              %( — <a href="#{entry[:number]}/close">close</a></p>)
          end
          return ours(context, "tweb tabs",
            rows.empty? ? "<p>No tabs open.</p>" : rows.join('\n'))
        end

        # open?url=… is how the entry-point plugin hands a url over: a new
        # tab, then a redirect to it, so the buffer ends up holding the tab's
        # own address rather than the command that opened it.
        if rest[0] == "open"
          return open_typed(context, typed_address(context, query))
        end

        number = rest[0].to_i?
        unless number
          return send_html(context, 404, "<html><body><p>tweb: no such tab</p></body></html>")
        end
        tab = @tabs.page(number)
        return gone_tab(context, number, restarted: restarted) unless tab
        base = "http://#{HOST}:#{@port}#{tab_url(number)}"
        what = rest[1]? || ""

        return render(context, number, base, show: query.has_key?("show")) if what.empty?

        # The answer to the sign-in form: remember the password for that realm
        # and go back for the page, which now loads without anybody being
        # asked anything.
        if what == "auth"
          challenge = @waiting[number]?
          return redirect(context, tab_url(number)) unless challenge
          fields = URI::Params.parse(context.request.body.try(&.gets_to_end) || "")
          user = fields["user"]? || ""
          @waiting.delete(number)
          return redirect(context, "#{tab_url(number)}?show=1") if user.empty?
          @credentials.remember(challenge, JSON::Any.new({
            "username" => JSON::Any.new(user),
            "password" => JSON::Any.new(fields["password"]? || ""),
          }))
          # The cancelled challenge was recorded as declined; the reader has
          # just said otherwise.
          @credentials.reconsider
          again = @tabs.last_url(number) || tab.url
          @log.try(&.write("edb.auth.answered", {
            "tab"    => JSON::Any.new(number.to_i64),
            "origin" => challenge.as_h["origin"]? || JSON::Any.new(nil),
            "realm"  => challenge.as_h["realm"]? || JSON::Any.new(nil),
          }))
          begin
            tab.goto(again)
          rescue
          end
          sleep @settle
          tab.sync_url
          return redirect(context, tab_url(number))
        end

        if what.in?("ax", "render", "inspect", "source")
          return render_view(context, number, what, base)
        end

        # The address bar on a tab's own page goes to that tab. Opening a new
        # one for every address is what put Back out of step with submit: the
        # reader would fill a form, be answered in the tab they were reading,
        # then type an address and be somewhere else entirely, with a back
        # button pointing into a history they had not walked.
        if what == "open"
          return open_typed(context, typed_address(context, query),
            {tab: tab, number: number})
        end

        # Back, for this tab. A back button at the start of a history does
        # nothing, in every browser there is, so there is nothing to report
        # here either: the reader is returned to the page they are on.
        if what == "back"
          before = tab.url
          begin
            tab.back
          rescue
          end
          sleep @settle
          tab.sync_url
          now = tab.url
          @tabs.remember(number, now)
          @log.try(&.write("edb.back", {
            "tab"   => JSON::Any.new(number.to_i64),
            "moved" => JSON::Any.new(now != before),
            "url"   => JSON::Any.new(now[0, Math.min(now.size, 120)]),
          }))
          return redirect(context, tab_url(number))
        end

        if what == "close"
          begin
            tab.close
          rescue
          end
          return redirect(context, "/t/#{@token}/tabs")
        end

        return submit(context, tab, number, rest) if what == "submit"
        return press(context, tab, number, what, rest) if what.matches?(/^e\d+$/)
        return frame_page(context, tab, number, what, base) if what.matches?(/^f\d+$/)

        send_html(context, 404, "<html><body><p>tweb: no such page</p></body></html>")
      end

      # submit/e<id>
      #
      # The reader filled the form in edbrowse; the values live there, not in
      # the page. So: put them into the live elements, let the site's own
      # input and change handlers run, and only then press the button — as a
      # person would press it, because a submit is exactly where sites ask
      # whether a person is present.
      private def submit(context : HTTP::Server::Context, tab : TabEnv, number : Int32,
                         rest : Array(String)) : Nil
        target_id = (rest[2]? || "").lchop("e").to_i?
        registry = @tabs.registry(number)
        target = target_id ? registry.get(target_id) : nil
        unless target
          return ours(context, "stale",
            "<p>That form is from an older version of this page. Type rf.</p>")
        end

        fields = URI::Params.parse(context.request.body.try(&.gets_to_end) || "")
        entries = [] of FieldEntry
        pressed = nil.as(Record?)
        fields.each do |name, value|
          next if name == "enter" # this program's own button on a loose field
          id = name.lchop("e").to_i?
          record = id ? registry.get(id) : nil
          next unless record
          if record.kind == "control"
            pressed = record
            next
          end
          next unless record.kind == "field"
          object = record.desc.as_h
          entries << FieldEntry.new(
            object["path"]?.try(&.as_s?) || "",
            object["tag"]?.try(&.as_s?) || "",
            value)
        end

        where = document_of(tab, registry, target.within)
        return ours(context, "gone", "<p>That frame is not there any more.</p>") unless where

        before = tab.url
        applied = entries.empty? ? Applied.new(0, [] of String) : where.apply_fields(entries)

        how = "nothing"
        if control = pressed
          result = where.activate(control.desc, true)
          how = result.ok ? "clicked" : "refused"
          unless result.ok
            return ours(context, "cannot", "<p>#{Edb.escape_html(result.why)}</p>" +
              %(<p><a href="#{tab_url(number)}">back to the page</a></p>))
          end
        else
          # Nothing to press: the page submits in script and expects Enter,
          # which is what a person would do in a search box. Type Enter into
          # the field the reader was filling, through the browser's own
          # keyboard.
          field = if target.kind == "field"
                    target.desc
                  elsif last = entries.last?
                    JSON::Any.new({
                      "path" => JSON::Any.new(last.path),
                      "tag"  => JSON::Any.new(last.tag),
                      "name" => JSON::Any.new(""),
                    })
                  end
          if field
            where.press_enter(field)
            how = "enter"
          end
        end

        # A submit is where sites ask whether a person is present, so it gets
        # the same wait a real press does.
        navigated = settle_after(tab, before, @press_settle)
        @log.try(&.write("edb.submit", {
          "tab"       => JSON::Any.new(number.to_i64),
          "fields"    => JSON::Any.new(entries.size.to_i64),
          "applied"   => JSON::Any.new(applied.applied.to_i64),
          "within"    => target.within ? JSON::Any.new(target.within.not_nil!.to_i64) : JSON::Any.new(nil),
          "how"       => JSON::Any.new(how),
          "navigated" => JSON::Any.new(navigated),
        }))
        redirect(context, navigated ? tab_url(number) : back_to(number, target.within))
      end

      # e<id> and e<id>/click
      private def press(context : HTTP::Server::Context, tab : TabEnv, number : Int32,
                        what : String, rest : Array(String)) : Nil
        registry = @tabs.registry(number)
        record = what[1..].to_i?.try { |id| registry.get(id) }
        unless record
          return ours(context, "stale",
            "<p>That link is from an older version of this page. Type rf.</p>")
        end

        # An element in a frame is resolved in that frame. A path through one
        # document means nothing in another, so acting on the tab's own page
        # would either miss or, worse, hit whatever happens to sit at the same
        # path there.
        where = document_of(tab, registry, record.within)
        unless where
          return ours(context, "gone", "<p>That frame is not there any more.</p>")
        end

        real = rest[2]? == "click"
        before = tab.url
        result = where.activate(record.desc, real)
        unless result.ok
          return ours(context, "cannot", "<p>#{Edb.escape_html(result.why)}</p>" +
            %(<p><a href="#{back_to(number, record.within)}">back to the page</a></p>))
        end
        # A real click is the one used on the things that take a moment to
        # answer — a bot check above all — so a real click is given one before
        # edbrowse is sent back to look.
        navigated = settle_after(tab, before, real ? @press_settle : @navigation_watch)
        @log.try(&.write("edb.activate", {
          "tab"       => JSON::Any.new(number.to_i64),
          "id"        => JSON::Any.new(what),
          "real"      => JSON::Any.new(real),
          "within"    => record.within ? JSON::Any.new(record.within.not_nil!.to_i64) : JSON::Any.new(nil),
          "how"       => JSON::Any.new(result.how),
          "navigated" => JSON::Any.new(navigated),
        }))
        # Back to where it was pressed, unless pressing it took the page
        # somewhere — a bot check that clears takes its own frame with it, and
        # sending the reader back to a frame that no longer exists would tell
        # them it had failed when it had just worked.
        redirect(context, navigated ? tab_url(number) : back_to(number, record.within))
      end

      # f<id>: a frame, rendered as its own page
      private def frame_page(context : HTTP::Server::Context, tab : TabEnv, number : Int32,
                             what : String, base : String) : Nil
        registry = @tabs.registry(number)
        id = what[1..].to_i?
        record = id ? registry.get(id) : nil
        unless record
          return ours(context, "stale",
            "<p>That frame is from an older version of this page. Type rf.</p>")
        end
        parent = document_of(tab, registry, record.within)
        frame = parent ? frame_for(parent, record.desc) : nil
        unless frame
          return ours(context, "gone", "<p>That frame is not there any more.</p>")
        end
        # Everything on this page belongs to that frame, and the page's ids
        # have to say so or acting on one would look in the wrong document.
        # The same walk runs here, so a frame read on its own page has its own
        # frames spliced into it.
        walked = read_tree(frame, registry, within: id)
        send_html(context, 200,
          Edb.tokens_to_html(walked.to_json_any, registry, base, number, id))
      end
    end

    # Where the plugin looks for this server.
    def self.endpoint_path : String
      base = ENV["XDG_DATA_HOME"]? || File.join(Path.home.to_s, ".local", "share")
      File.join(base, "tawb", "edb.json")
    end

    def self.write_endpoint(record : Hash(String, JSON::Any)) : String
      file = endpoint_path
      Dir.mkdir_p(File.dirname(file))
      File.write(file, record.to_json)
      file
    end

    def self.read_endpoint : Hash(String, JSON::Any)?
      JSON.parse(File.read(endpoint_path)).as_h
    rescue
      nil
    end
  end
end
