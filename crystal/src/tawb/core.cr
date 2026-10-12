# The native port of the buffer half of src/core.js: everything about a page
# that is not about a terminal and not about a browser.
#
# The reader in src/index.js owns a terminal — a width to wrap to, a cursor on
# a row, a scroll position, four prompt modes. None of that is true of
# edbrowse, which owns its own buffer and its own line numbers, and none of it
# would be true of a port that kept this program and threw the front end away.
# What both front ends need is the same: a page, a view of it, a list of blocks
# with stable identity, and the policy that decides when that list is allowed
# to change under a reader.
#
# That is what lives here. The dividing line is deliberately drawn at the
# *block*, not the line:
#
#   blocks  — one per thing on the page (a link, a heading, a paragraph).
#             Core. Width-independent. Carries the item behind it, which is
#             what activation resolves against.
#   lines   — blocks wrapped to a terminal width, with continuations.
#             Front end. A block may be one line or nine; edbrowse would
#             wrap differently, or not at all.
#
# Every position that crosses this boundary is therefore a block index. The
# front end maps it to and from its own lines, and nothing here ever needs to
# know how wide anything is.
#
# ## The shadow cursor
#
# Several of the rules this program exists for need to know where the reader
# is: a text patch must never rewrite the line under them, a rebuild must
# re-anchor rather than teleport, and a change region is only worth
# reporting relative to somewhere. The cursor belongs to the front end — it
# is a terminal artefact, and edbrowse's would be its own — so the core
# cannot read it, and asking for it per decision would make the boundary
# chatty in exactly the place it must not be.
#
# Instead the front end *tells* the core, with `at(block_index)`, whenever
# the reader moves. It is one-way and unacknowledged. The core keeps the last
# one it was told and uses it to make its decisions. A stale shadow cursor
# costs at worst one refused patch, which is the safe direction to be wrong
# in.
#
# ## What is not here yet
#
# Item activation and tabs are here, on top of the Firefox handle and action
# layers; typing's front-end orchestration and live updates' page observer and
# refresh loop still live in the JavaScript originals and move here as the
# front end work proceeds. File attachment bookkeeping is here: paths remain
# outside the page and survive snapshots only while the browser reports
# matching names.

require "json"
require "set"
require "uri"
require "./actions"
require "./aria"
require "./firefox_driver"
require "./frames"
require "./fields"
require "./live"
require "./remap"
require "./session"

module Tawb
  class Core
    # The views of a page, cycled by backslash. AX and INSPECT share the
    # driver's accessibility extraction; PAGE and SOURCE are DOM-derived.
    ALL_SOURCES   = ["ax", "render", "inspect", "source"]
    SOURCE_LABELS = {"ax" => "AX", "render" => "PAGE", "inspect" => "INSPECT", "source" => "SOURCE"}
    # SOURCE keeps its own page-side node array and is activated through it,
    # rather than by matching role and name. INSPECT carries AX's own references.
    DOM_SOURCES = %w[source]

    # How far from the old position a re-anchor will look. A live update must
    # never relocate the reader across the page: past this, staying put is the
    # better answer.
    REANCHOR_WINDOW = 250
    # How many neighbours on each side identify a position. Block text is
    # routinely duplicated — a markup view is full of repeated <svg> and
    # <option> — so what tells two identical blocks apart is what sits around
    # them.
    CONTEXT_RADIUS = 3

    # How long something that changed stays worth being told about, how many
    # such places are remembered, and what separates news from a thing that
    # simply ticks.
    #
    # The last is the one that matters. Every path used to *replace* the record
    # of what had changed, so a clock rewriting itself once a second erased the
    # fact that a menu had opened at the other end of the page — press c and you
    # went to the clock, every time, for ever. A block that has changed this many
    # times inside this window is a clock, a countdown or a view counter: it goes
    # on being patched and goes on being readable, it just stops being reported
    # as news.
    CHANGE_MEMORY_MS = 60000
    CHANGE_LIMIT     = 20
    TICKER_WINDOW_MS = 10000
    TICKER_REPEATS   = 3

    # Nothing the reader triggers may block the interface indefinitely — a
    # control that cannot resolve, an element that vanished mid-page, must
    # report the failure to whoever asked instead of freezing the terminal.
    # The page itself is given longer, because a load is allowed to take longer
    # than a control is allowed to take to answer.
    ACTION_TIMEOUT_MS     = 6000
    OPERATION_TIMEOUT_MS  = 8000
    NAVIGATION_TIMEOUT_MS = 20000
    LOAD_MORE_TIMEOUT_MS  = 2500
    LOAD_MORE_SETTLED_MS  = 800
    SCROLL_TO_BOTTOM = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/scroll_to_bottom.js") }})
    RESTORE_SCROLL = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/restore_scroll.js") }})
    TEXT_AT_FRAGMENT = Actions.asset_source(
      {{ read_file("#{__DIR__}/../../assets/text_at_fragment.js") }})

    # How far past a text match the context has to agree before a re-anchor
    # believes it: the normal case for a block whose own content is what
    # changed, where the text can never match but the neighbours did not move.
    MIN_CONTEXT_SCORE = 3

    # One block: a line's worth of page, and the item behind it, which is what
    # activation resolves against. The item stays JSON — the shape the in-page
    # extractors hand back — open-ended by design, and read for whatever field
    # the policy needs.
    class Block
      property text : String
      property item : JSON::Any

      def initialize(@text : String, @item : JSON::Any = JSON::Any.new(nil))
      end
    end

    # Where the reader is, described well enough to find again in a buffer
    # that has been rebuilt. See anchor().
    record Anchor, text : String, name : String?, identity : String?,
      block : Int32, context : Array(String), ratio : Float64
    # Where a re-anchor left the reader: the block, and whether the arithmetic
    # remap answered exactly or something fuzzier had to.
    record Settled, block : Int32, exact : Bool
    # A run of consecutive blocks that changed together.
    record Region, start : Int32, stop : Int32
    # One entry of the change memory: where the change was, what its text was
    # at the time, and when it happened. The text travels with the position
    # because the next rebuild renumbers everything; see change_targets().
    record Change, start : Int32, stop : Int32, text : String, at : Int64
    # A change resolved against the buffer as it stands now.
    record Target, block : Int32, size : Int32, at : Int64
    # How often one place has changed lately, so a ticker can be told from
    # news. Keyed by block index, which holds still for as long as only text
    # is being replaced — which is exactly the case this is about.
    record Ticker, count : Int32, last : Int64
    # What the page looked like the last time asking it for more produced
    # nothing. See no_more_to_load?().
    record Exhausted, url : String, blocks : Int32
    # What a patch undoes: the block, its text, and the name it had — null
    # when the item behind the block had none worth restoring.
    record Undo, block : Block, text : String, name : String?
    # What a successful patch reports: the blocks it touched, the buffer
    # generation it belongs to, and the undo that puts it back.
    record PatchResult, touched : Array(Int32), generation : Int32, undo : Proc(Nil)
    # Paths supplied to one file control, and the only part the browser lets
    # a page read back to prove those paths are still selected.
    record AttachedFile, paths : Array(String), names : Array(String)
    # A tab's one-based position in the browser and the number of tabs there.
    record TabPosition, position : Int32, of : Int32
    # A completed whole-buffer rebuild and the information the front end needs
    # to put its cursor back and report changed regions.
    record RebuildResult, settled : Settled, regions : Array(Change),
      previous_texts : Array(String)

    # An open dropdown, whose entries are spliced into the block list under
    # the control they belong to. See open_chooser().
    class Chooser
      property block_index : Int32
      property at : Int32
      property count : Int32
      property filter : String
      property shown : Array(Int32)
      property options : Array(JSON::Any)
      property multiple : Bool

      def initialize
        @block_index = 0
        @at = 0
        @count = 0
        @filter = ""
        @shown = [] of Int32
        @options = [] of JSON::Any
        @multiple = false
      end
    end

    # -----------------------------------------------------------------------
    # Questions about the buffer, answered without a page
    # -----------------------------------------------------------------------

    # Identity of the element behind a block, where the view has one. The
    # DOM-derived views number the nodes they walk, which survives a re-snapshot
    # as long as the document structure has not shifted — far stronger evidence
    # than the block's text, which is routinely duplicated.
    def self.identity_of(block : Block?) : String?
      return nil unless block
      return nil if block.item.raw.nil?
      item = block.item.as_h? || return nil
      dom = item["domIndex"]?
      render = item["renderIndex"]?
      index = if dom && !dom.raw.nil?
                dom.as_i64?
              elsif render && !render.raw.nil?
                render.as_i64?
              end
      return nil unless index
      frame_url = item["frame"]?.try(&.as_h?).try { |frame| frame["url"]?.try(&.as_s?) } || ""
      "#{frame_url}##{index}"
    end

    def self.diff_blocks(previous_texts : Array(String), blocks : Array(Block)) : Array(Region)
      before = previous_texts.to_set
      changed = [] of Int32
      blocks.each_with_index do |block, index|
        changed << index unless before.includes?(block.text)
      end

      # Collapse consecutive indices into regions; one edit usually replaces a
      # run of lines and should be reported as a single place to go.
      regions = [] of Region
      changed.each do |index|
        last = regions.last?
        if last && index == last.stop + 1
          regions[regions.size - 1] = Region.new(last.start, index)
        else
          regions << Region.new(index, index)
        end
      end
      regions
    end

    # Where a piece of text sits in the buffer, but only if it sits in exactly
    # one place. Ambiguity is the whole risk in patching by content: "12:04"
    # appearing twice means we cannot say which one the page rewrote.
    def self.sole_block_containing(blocks : Array(Block), needle : String) : Int32
      found = -1
      blocks.each_with_index do |block, index|
        at = block.text.index(needle) || next
        # Twice inside one line is just as ambiguous as once in two lines.
        if found >= 0 || block.text.index(needle, at + needle.bytesize)
          return -1
        end
        found = index
      end
      found
    end

    # The block holding a piece of text, searched by content in both directions:
    # the buffer's line can be longer than the snippet (prose runs together) or
    # shorter (a link renders as just its name).
    def self.find_block_with_text(blocks : Array(Block), needle : String) : Int32
      trimmed = needle.strip
      return -1 if trimmed.empty?

      direct = blocks.index { |block| block.text.includes?(trimmed) }
      return direct.not_nil! if direct

      # Long enough that a common word cannot match the wrong place.
      found = blocks.index do |block|
        text = block.text.strip
        text.size >= 10 && trimmed.includes?(text)
      end
      found || -1
    end

    # Whether two URLs are the same document reached at a different fragment.
    def self.same_document_fragment(before : String, after : String) : Bool
      a = URI.parse(before)
      b = URI.parse(after)
      # JavaScript's URL constructor accepts absolute URLs only; anything
      # without a scheme throws and the answer is false.
      return false if a.scheme.nil? || a.scheme.not_nil!.empty?
      return false unless b.fragment
      a.fragment = nil
      b.fragment = nil
      a.to_s == b.to_s
    rescue
      false
    end

    # Internal helpers on the class, not private: the instance methods below
    # call them as Core.js_number and friends, and Crystal's private class
    # methods cannot be reached through an explicit receiver.

    # JavaScript's Number(), far enough for the strings a slider's attributes
    # carry: null is zero, the empty string is zero, anything unparseable is
    # NaN. (Hex and Infinity are not the shapes the page answers with.)
    def self.js_number(raw : JSON::Any?) : Float64
      case value = raw.try(&.raw)
      when Nil      then 0.0
      when Bool     then value ? 1.0 : 0.0
      when Int64    then value.to_f
      when Float64  then value
      when String
        trimmed = value.strip
        return 0.0 if trimmed.empty?
        return Float64::NAN unless trimmed.matches?(/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/)
        trimmed.to_f
      else Float64::NAN
      end
    end

    # Which value a slider's advertised range puts a key at. A custom ARIA
    # slider may advertise a range and ignore every standard key; this is what
    # maps the key onto the track so the pointer can be used as a fallback.
    def self.slider_target(state : JSON::Any, key : String) : Float64?
      object = state.as_h? || {} of String => JSON::Any
      present = ->(name : String) { object[name]? && !object[name].raw.nil? }
      low = present.call("min") ? js_number(object["min"]) : 0.0
      high = present.call("max") ? js_number(object["max"]) : 100.0
      # A missing value is Number(undefined): NaN, and no answer at all.
      current = present.call("value") ? js_number(object["value"]) : Float64::NAN
      return nil unless low.finite? && high.finite? && current.finite? && high > low

      step = js_number(object["step"]?)
      small = step > 0 ? step : (high - low) / 20
      large = Math.max(small, (high - low) / 10)
      target = current
      case key
      when "Home"                then target = low
      when "End"                 then target = high
      when "ArrowRight", "ArrowUp"   then target += small
      when "ArrowLeft", "ArrowDown"  then target -= small
      when "PageUp"              then target += large
      when "PageDown"            then target -= large
      else return nil
      end
      Math.min(high, Math.max(low, target))
    end

    # JavaScript's String.prototype.replace with a string pattern: the first
    # occurrence, with the replacement's $ patterns — $$, $&, $`, $' —
    # substituted. ($1 and friends belong to regular expressions; with a
    # string pattern they stay literal.) The byte walk is UTF-8 safe because
    # the $ byte never appears inside a multi-byte character.
    def self.js_replace(text : String, from : String, to : String) : String
      at = text.index(from)
      return text if at.nil?
      prefix = text.byte_slice(0, at)
      tail = text.byte_slice(at + from.bytesize)
      replacement = IO::Memory.new
      bytes = to.to_slice
      i = 0
      while i < bytes.size
        if bytes[i] == '$'.ord && i + 1 < bytes.size
          case bytes[i + 1].chr
          when '$'    then replacement << '$'
          when '&'    then replacement << from
          when '`'    then replacement << prefix
          when '\''   then replacement << tail
          else             replacement.write_byte(bytes[i]); i += 1; next
          end
          i += 2
        else
          replacement.write_byte(bytes[i])
          i += 1
        end
      end
      prefix + replacement.to_s + tail
    end

    # A JavaScript Math.round: half towards positive infinity, not half away
    # from zero. Only the proportional fallback can land on a negative half,
    # and where the reader lands there must not depend on the language.
    def self.js_round(value : Float64) : Int32
      (value + 0.5).floor.to_i32
    end

    # -----------------------------------------------------------------------
    # The buffer
    # -----------------------------------------------------------------------

    getter source : String
    property blocks : Array(Block)
    # Bumped whenever the block list is replaced wholesale. A front end that
    # holds its own copy — which every front end does, and a front end
    # across a socket must — needs to know that a patch it is being handed
    # was computed against the buffer it still has. Patches name the
    # generation they belong to; one that names an older generation is
    # dropped rather than misapplied.
    getter generation : Int32
    property rendered_url : String
    # Where the front end last said the reader was, as a block index. See
    # the shadow cursor note above; -1 means it has not said yet.
    getter cursor_block : Int32
    property exhausted : Exhausted?
    getter chooser : Chooser?
    property change_index : Int32
    getter live : Live::State
    getter page : FirefoxDriver::Page?
    getter snapshot_cost_ms : Int64

    def initialize(source : String = "ax", layout : Bool = false,
                   driver : FirefoxDriver::BrowserSession? = nil,
                   page : FirefoxDriver::Page? = nil,
                   browser_port : Int32? = nil)
      @source = source
      @driver = driver
      @page = page
      @browser_port = browser_port
      # Whether the extraction records the inline-flow and table-cell placement
      # the Lynx display lays a page out with. Nothing else reads it, so a
      # reader who has not asked for Lynx does not pay for it.
      @layout = layout
      @blocks = [] of Block
      @generation = 0
      @rendered_url = ""
      @cursor_block = -1
      @changes = [] of Change
      @change_index = -1
      @tickers = {} of Int32 => Ticker
      @live = Live.create_state
      @snapshot_cost_ms = 0_i64
      @live_watcher = Live::Watcher.new
      @chooser = nil
      @typing_handle = nil.as(FirefoxDriver::Handle?)
      @attached_files = {} of String => Hash(String, AttachedFile)
      # The popup the reader has open, if any, named by the id its control
      # points at. See relocate_popup().
      @popup = nil
      @exhausted = nil
    end

    # The reader did something. Live refreshes hold off while this is recent,
    # so the buffer is never swapped mid-keystroke. A socket front end treats
    # request arrival as this same one-way signal.
    def mark_input(now : Int64 = Time.utc.to_unix_ms) : Nil
      @live.last_input_ms = now
    end

    def reading?(now : Int64 = Time.utc.to_unix_ms) : Bool
      now - @live.last_input_ms < Live::INPUT_GRACE_MS
    end

    # Install the page-side observer for this tab. The same watcher owns the
    # preload registration, armed-frame set, queue drains, and pulse baseline.
    def attach_live(page : FirefoxDriver::Page? = @page) : Live::InstallResult
      target = page || raise IO::Error.new("this core has no page")
      @live_watcher.install(target)
    end

    # Drain every armed rendered document and immediately apply the core's
    # classification policy. A front end receives only decisions, never raw
    # browser payloads, so disabled updates and refresh-in-flight protection
    # cannot be accidentally bypassed.
    def collect_live(page : FirefoxDriver::Page? = @page) : Array(JSON::Any)
      target = page || raise IO::Error.new("this core has no page")
      @live_watcher.collect(target).map { |payload| classify(payload) }
    end

    def arm_live_frames(frames : Array(FirefoxDriver::Frame), limit = 8) : Int32
      @live_watcher.arm_rendered_frames(frames, limit)
    end

    def pulse_live(page : FirefoxDriver::Page? = @page,
                   now : Int64 = Time.utc.to_unix_ms) : Live::PulseResult?
      target = page || raise IO::Error.new("this core has no page")
      @live_watcher.pulse(target, @live, now)
    end

    # What a mutation batch means, without acting on it. Announcements remain
    # immediate while enabled; pure text replacements can be patched only when
    # no whole-buffer refresh is already replacing the same blocks.
    def classify(payload : JSON::Any?) : JSON::Any
      unless payload && !payload.raw.nil?
        return JSON::Any.new({
          "announcements" => JSON::Any.new([] of JSON::Any),
          "patches"       => JSON::Any.new(nil),
        })
      end

      @live.notifies += 1
      object = payload.as_h? || {} of String => JSON::Any
      announcements = @live.enabled ? (object["announcements"]?.try(&.as_a?) || [] of JSON::Any) : [] of JSON::Any
      unless @live.enabled
        return JSON::Any.new({
          "announcements" => JSON::Any.new(announcements),
          "patches"       => JSON::Any.new(nil),
        })
      end

      patches = if object["pureText"]?.try(&.as_bool?) == true && !@live.refreshing
                  object["patches"]? || JSON::Any.new(nil)
                else
                  JSON::Any.new(nil)
                end
      JSON::Any.new({
        "announcements" => JSON::Any.new(announcements),
        "patches"       => patches,
        "mutations"     => JSON::Any.new(object["mutations"]?.try(&.as_i64?) || 0_i64),
      })
    end

    # Read the current native Firefox document into a fresh block buffer. AX
    # is the extraction currently available to the interactive native core;
    # other view extractors remain separate release work rather than silently
    # returning AX under the wrong label.
    def rescan(page : FirefoxDriver::Page? = @page) : Array(Block)
      target = page || raise IO::Error.new("this core has no page")
      unless @source == "ax"
        raise IO::Error.new("native interactive extraction for #{@source} is not ported")
      end
      started = Time.monotonic
      tree, documents = target.accessibility_documents(@layout)
      built = Frames.build(tree, documents)
      @blocks = built.map do |entry|
        object = entry.as_h
        Block.new(object["text"]?.try(&.as_s?) || "",
          object["item"]? || JSON::Any.new(nil))
      end
      restore_attached_files(target.context_id)
      @generation += 1
      @rendered_url = target.url
      relocate_popup
      # The extraction visited these contexts. Arming is best effort: a frame
      # may detach between its snapshot and this call.
      frames = target.all_frames
      arm_live_frames(frames)
      @snapshot_cost_ms = (Time.monotonic - started).total_milliseconds.to_i64
      @live.snapshot_cost_ms = @snapshot_cost_ms
      @blocks
    end

    # Re-read, re-anchor without proportional guesses, and remember all new
    # regions as one operation so callers cannot compare mismatched generations.
    def rebuild(anchor : Anchor, page : FirefoxDriver::Page? = @page,
                keep_place = true) : RebuildResult
      previous = texts
      rescan(page)
      settled = keep_place ? reanchor(anchor, previous) : Settled.new(-1, false)
      regions = record_changes(Core.diff_blocks(previous, @blocks))
      RebuildResult.new(settled, regions, previous)
    end

    # The front end reporting a move. One way, no reply, cheap enough to send
    # on every arrow key.
    def at(block_index : Int32) : Nil
      @cursor_block = block_index
    end

    def block(index : Int32) : Block?
      return nil if index < 0 || index >= @blocks.size
      @blocks[index]
    end

    def texts : Array(String)
      @blocks.map(&.text)
    end

    def block_text(index : Int32) : String
      block = self.block(index)
      block ? block.text : ""
    end

    # Whether asking this page for more has already been tried and answered no.
    #
    # Without this, every press of the down key at the last line paid the full
    # scroll-and-wait again — measured at 2.5 seconds per keypress, for ever,
    # on any page at all. The trap is that "can this page scroll" is nearly
    # always yes: a document taller than the window scrolls, which is most
    # documents, and it has nothing to do with whether more content exists.
    # The buffer already holds the whole document either way, because the walk
    # reads the DOM and not the viewport. Only lazily loaded content is ever at
    # stake, and the only way to find out is to try — so try once, and remember.
    #
    # The answer stops applying the moment the page is a different page or has
    # a different number of blocks in it, which covers both a navigation and a
    # feed that finally delivered something.
    def no_more_to_load? : Bool
      return false unless exhausted = @exhausted
      exhausted.url == @rendered_url && exhausted.blocks == @blocks.size
    end

    # Ask a lazy feed for more once, restoring its visual scroll position if
    # no elements arrive. Ordinary long documents are already fully present
    # in the buffer; only a growing DOM counts as more content.
    def ask_for_more(page : FirefoxDriver::Page? = @page) : JSON::Any
      target = page || raise IO::Error.new("this core has no page")
      probe = target.evaluate(SCROLL_TO_BOTTOM).as_h
      scrollable = probe["scrollable"]?.try(&.as_bool?) || false
      moved = probe["moved"]?.try(&.as_bool?) || false
      before = Core.js_number(probe["elements"]?)
      grew = false
      if scrollable
        timeout = moved ? LOAD_MORE_TIMEOUT_MS : LOAD_MORE_SETTLED_MS
        deadline = Time.monotonic + timeout.milliseconds
        while Time.monotonic < deadline
          count = Core.js_number(target.evaluate(
            "() => document.getElementsByTagName('*').length"))
          if count > before
            grew = true
            break
          end
          sleep 250.milliseconds
        end
      end
      unless grew
        target.evaluate(RESTORE_SCROLL) rescue nil
        @exhausted = Exhausted.new(@rendered_url, @blocks.size)
      end
      JSON::Any.new({
        "grew"       => JSON::Any.new(grew),
        "scrollable" => JSON::Any.new(scrollable),
        "moved"      => JSON::Any.new(moved),
        "target"     => JSON::Any.new(probe["target"]?.try(&.as_s?) || "nothing"),
      })
    end

    # -----------------------------------------------------------------------
    # Keeping the reader's place
    #
    # All of this used to be worked out in line space, over the terminal's
    # wrapped lines. It is worked out in block space now, which is not merely
    # tidier: a block is what the page produced, so the same buffer re-read at a
    # different terminal width gives the same answer, and the arithmetic remap
    # below can no longer be thrown off by a line that rewrapped when nothing
    # about the page had changed at all.
    # -----------------------------------------------------------------------

    # Where the reader is, described well enough to find again in a buffer
    # that has been rebuilt: by the element if the view knows one, by the text
    # otherwise, by the neighbours when the text repeats, and by proportion
    # when nothing else survived.
    def anchor : Anchor
      index = @cursor_block
      block = self.block(index)
      Anchor.new(
        text: block ? block.text : "",
        name: anchor_name(block),
        identity: Core.identity_of(block),
        block: index,
        context: (-CONTEXT_RADIUS..CONTEXT_RADIUS).map { |offset| block_text(index + offset) },
        ratio: @blocks.empty? ? 0.0 : index / @blocks.size,
      )
    end

    # JavaScript answers '' when there is no block or no item behind one, and
    # undefined — which travels as null — when the item carries no name.
    private def anchor_name(block : Block?) : String?
      return "" unless block
      return "" if block.item.raw.nil?
      return nil unless object = block.item.as_h?
      object["name"]?.try(&.as_s?)
    end

    # How much of the remembered neighbourhood a candidate still agrees with.
    def context_score(index : Int32, anchor : Anchor) : Int32
      score = 0
      (-CONTEXT_RADIUS..CONTEXT_RADIUS).each do |offset|
        next if offset == 0
        expected = anchor.context[offset + CONTEXT_RADIUS]
        score += 1 if expected && !expected.empty? && expected == block_text(index + offset)
      end
      score
    end

    # Searched outward from where the reader was, so the nearest of several
    # identical blocks wins and context breaks the tie. `accept` returns a
    # score, or nil for "not a candidate at all".
    #
    # Outward rather than from the top is the whole point. Block text repeats
    # constantly — two buttons both called "Open", a page of <option value=30>
    # — and the first match from the top can be the length of the document away
    # from the one the reader was actually standing on.
    def search_outward(start : Int32, limit : Int32 = REANCHOR_WINDOW,
                       &accept : Int32 -> Int32?) : NamedTuple(index: Int32, score: Int32)?
      best = nil
      (0..limit).each do |distance|
        candidates = distance == 0 ? [start] : [start - distance, start + distance]
        any_in_range = false
        candidates.each do |index|
          next if index < 0 || index >= @blocks.size
          any_in_range = true
          score = accept.call(index)
          next if score.nil?
          candidate = {index: index, score: score.not_nil!}
          best = candidate if best.nil? || candidate[:score] > best.not_nil![:score]
          return best if best.not_nil![:score] == CONTEXT_RADIUS * 2
        end
        # Both ends have run off the buffer; nothing further to visit.
        break if !any_in_range && distance > 0
      end
      best
    end

    # Putting the reader back after a change they asked for — a view switch, a
    # refresh they pressed for, the page redrawing after they pressed
    # something. Always answers with somewhere, falling back to the same
    # proportion of a buffer whose block count may be wildly different, because
    # the reader asked for this and has to arrive somewhere.
    #
    # The search spans the whole buffer, because they asked and it must find
    # the thing if the thing is there — but it still runs outward from where
    # they were, so that of two blocks reading exactly the same it chooses the
    # one they were standing on rather than the first one on the page.
    def restore(anchor : Anchor) : Int32
      return 0 if @blocks.empty?
      needle = (anchor.name.presence || anchor.text.presence || "").strip
      start = Math.min(Math.max(anchor.block, 0), @blocks.size - 1)
      whole = @blocks.size

      unless needle.empty?
        exact = search_outward(start, limit: whole) do |index|
          @blocks[index].text == anchor.text ? context_score(index, anchor) : nil
        end
        return exact[:index] if exact

        partial = search_outward(start, limit: whole) do |index|
          @blocks[index].text.includes?(needle) ? context_score(index, anchor) : nil
        end
        return partial[:index] if partial
      end

      Math.min(Core.js_round(anchor.ratio * @blocks.size), @blocks.size - 1)
    end

    # Putting the reader back after a change they did not ask for.
    #
    # Unlike restore(), this never falls back to a proportional guess, and
    # answers -1 for "stay exactly where you are": if what they were reading
    # has gone, standing still is far less disorienting than being silently
    # moved somewhere proportional. Nor does it search from the top of the
    # document — block text is often not unique, so the first match can be
    # thousands of blocks from where the reader actually is.
    #
    # In order: the arithmetic answer, which is right whenever the page
    # rewrote one contiguous region and is the only thing that gets a ticking
    # clock right; then the element itself; then the nearest matching text,
    # searched outward; then the surroundings alone.
    def reanchor(anchor : Anchor, previous_texts : Array(String)? = nil) : Settled
      if previous_texts
        remap = Remap.remap_index(previous_texts, texts, anchor.block)
        return Settled.new(remap.index, true) if remap.exact
      end

      if identity = anchor.identity
        found = @blocks.index { |block| Core.identity_of(block) == identity }
        # Node numbering comes from walk order, so inserting an element earlier
        # in the document renumbers everything after it and the same number can
        # name a different node. Trust the match only when a second signal
        # agrees: the text is unchanged, or it is somewhere plausibly nearby.
        if found
          same_text = @blocks[found].text == anchor.text
          if same_text || (found - anchor.block).abs <= REANCHOR_WINDOW
            return Settled.new(found, false)
          end
        end
      end

      start = Math.min(Math.max(anchor.block, 0), Math.max(@blocks.size - 1, 0))

      # Matching a single block is not enough when the text repeats — a page of
      # <option value=30> entries offers dozens of equally good candidates. The
      # neighbours disambiguate: the right one sits in the same surroundings it
      # did before.
      by_text = search_outward(start) do |index|
        @blocks[index].text == anchor.text ? context_score(index, anchor) : nil
      end
      return Settled.new(by_text[:index], false) if by_text

      by_context = search_outward(start) do |index|
        score = context_score(index, anchor)
        score >= MIN_CONTEXT_SCORE ? score : nil
      end
      return Settled.new(by_context[:index], false) if by_context

      Settled.new(-1, false)
    end

    # -----------------------------------------------------------------------
    # What is worth being told about
    # -----------------------------------------------------------------------

    # Whether this place has changed often enough lately to be a ticker rather
    # than news.
    private def ticking?(index : Int32, now : Int64) : Bool
      entry = @tickers[index]?
      fresh = if entry && now - entry.last <= TICKER_WINDOW_MS
                Ticker.new(entry.count + 1, now)
              else
                Ticker.new(1, now)
              end
      @tickers[index] = fresh
      fresh.count > TICKER_REPEATS
    end

    # Add to what is known to have changed, rather than replacing it. Returns
    # only what was worth reporting, which is what the reader is told about.
    #
    # Each entry remembers its text as well as its position, because the next
    # rebuild renumbers everything; the position is where to start looking and
    # the text is what to look for. See change_targets().
    def record_changes(regions : Array(Region)) : Array(Change)
      now = Time.utc.to_unix_ms
      news = [] of Change
      regions.each do |region|
        next if ticking?(region.start, now)
        news << Change.new(region.start, region.stop, block_text(region.start), now)
      end
      return [] of Change if news.empty?

      superseded = news.map(&.text).to_set
      kept = @changes.reject do |entry|
        superseded.includes?(entry.text) || now - entry.at >= CHANGE_MEMORY_MS
      end
      @changes = (kept + news).last(CHANGE_LIMIT)
      @change_index = -1
      news
    end

    def note_changes(previous_texts : Array(String)) : Array(Change)
      record_changes(Core.diff_blocks(previous_texts, @blocks))
    end

    # The nearest block to `start` whose text still matches, or -1.
    def find_near(start : Int32, text : String) : Int32
      return -1 if @blocks.empty?
      from = Math.min(Math.max(start, 0), @blocks.size - 1)
      (0...@blocks.size).each do |distance|
        candidates = distance == 0 ? [from] : [from - distance, from + distance]
        candidates.each do |index|
          next if index < 0 || index >= @blocks.size
          return index if @blocks[index].text == text
        end
      end
      -1
    end

    # Everywhere worth going, in document order, resolved against the buffer as
    # it stands now. Entries whose text is nowhere to be found have been
    # overwritten again since, and are dropped rather than pointing somewhere
    # arbitrary.
    def change_targets : Array(Target)
      now = Time.utc.to_unix_ms
      out = [] of Target
      @changes.each do |entry|
        next if now - entry.at >= CHANGE_MEMORY_MS
        block = find_near(entry.start, entry.text)
        next if block < 0
        out << Target.new(block, entry.stop - entry.start + 1, entry.at)
      end
      out.sort_by!(&.block)
      out
    end

    # -----------------------------------------------------------------------
    # Splicing text in without a snapshot
    # -----------------------------------------------------------------------

    # Splices replaced text straight into the buffer, skipping the snapshot.
    #
    # A clock costs a whole-page snapshot per tick otherwise — 150ms on a
    # plain page and seconds on a heavy one — to change eight characters. When
    # the page tells us the exact text it replaced, and that text names one
    # block and one block only, we can rewrite that block for a fraction of a
    # millisecond.
    #
    # Returns the block indices it changed together with the undo that puts
    # them back, or nil if the patches could not be accounted for. The undo
    # matters because the caller has one more test to apply that cannot be
    # made here: a patch whose new text wraps to a different number of lines
    # would reflow the buffer, and reflowing the buffer moves the reader,
    # which is the one thing a live update may not do. Only the front end
    # knows how wide a line is, so only the front end can see that coming —
    # and it needs a way back when it does.
    def patch_text(patches : Array(JSON::Any), protect : Bool = true) : PatchResult?
      return nil if patches.empty? || @blocks.empty?

      undo_log = [] of Undo
      touched = [] of Int32
      undo = -> do
        undo_log.reverse_each do |entry|
          entry.block.text = entry.text
          if name = entry.name
            entry.block.item.as_h["name"] = JSON::Any.new(name)
          end
        end
        undo_log.clear
      end

      patches.each do |patch|
        object = patch.as_h? || {} of String => JSON::Any
        from = object["from"]?.try(&.as_s?) || ""
        to = object["to"]?.try(&.as_s?) || ""
        if from.empty? || to.empty? || from == to
          undo.call
          return nil
        end

        # Resolved one at a time, against the buffer as the previous patch
        # left it: two patches can land on the same block.
        index = Core.sole_block_containing(@blocks, from)
        if index < 0
          undo.call
          return nil
        end

        block = @blocks[index]
        item = block.item.as_h?
        had_name = nil
        if item && (name = item["name"]?.try(&.as_s?)) && name.includes?(from)
          had_name = name
        end
        undo_log << Undo.new(block, block.text, had_name)

        block.text = Core.js_replace(block.text, from, to)
        # The name is what activation resolves against, so it cannot be left
        # describing text that is no longer on the page.
        if had_name
          item.not_nil!["name"] = JSON::Any.new(Core.js_replace(had_name.not_nil!, from, to))
        end
        touched << index unless touched.includes?(index)
      end

      # The block the reader is on is theirs while they are reading it. A
      # clock elsewhere on the page may tick — that moves nothing — but
      # rewriting the words under them mid-sentence is exactly what the freeze
      # exists to prevent. This is the shadow cursor's whole job.
      if protect && @cursor_block >= 0 && touched.includes?(@cursor_block)
        undo.call
        return nil
      end

      PatchResult.new(touched, @generation, undo)
    end

    # -----------------------------------------------------------------------
    # Acting on an item
    # -----------------------------------------------------------------------

    # Resolve the element retained by whichever view produced this item. The
    # page-side extractors keep arrays under stable symbols; an item carries
    # its position in the corresponding array and the frame that owns it.
    def handle_for(item : JSON::Any, page : FirefoxDriver::Page? = @page) : FirefoxDriver::Handle
      acting = page || raise IO::Error.new("this core has no page")
      object = item.as_h
      scope = item_scope(object["frame"]?, acting)
      index_name, symbol = if DOM_SOURCES.includes?(@source)
                             {"domIndex", "tweb.dom"}
                           elsif @source == "render"
                             {"renderIndex", "tweb.render"}
                           else
                             {"axIndex", "tweb.ax"}
                           end
      index = object[index_name]?.try(&.as_i?)
      # An index of zero is a real position — the first thing on the page —
      # so only its absence refuses; JS's `axIndex == null` semantics.
      raise IO::Error.new("this line carries no element reference to activate") if index.nil? && object[index_name]?.nil?
      raise IO::Error.new("this line carries no element reference to activate") unless index
      scope.evaluate_handle(
        "(i) => (window[Symbol.for('#{symbol}')] || [])[i]",
        JSON::Any.new(index.not_nil!.to_i64))
    end

    # The item's policy chooses trusted input only where default activation is
    # insufficient: a pierced challenge and a button submitting credentials
    # the browser filled itself. Everything else keeps the DOM's own action.
    def activate(item : JSON::Any, page : FirefoxDriver::Page? = @page) : JSON::Any
      acting = page || raise IO::Error.new("this core has no page")
      object = item.as_h
      if object["nativeControl"]?
        pressed = native_control(item, acting, "tweb.nativeControl")
        return JSON::Any.new({
          "how" => JSON::Any.new("native-control"),
          "status" => pressed ? JSON::Any.new(nil) : JSON::Any.new(
            "The browser's #{object["name"]?.try(&.as_s?) || "media"} control is no longer visible."),
        })
      end
      held = object["pressFrame"]? ? nil : handle_for(item, acting)
      Actions.activate_item(acting.protocol, acting.context_id, item, held)
    end

    def focus_control(item : JSON::Any, page : FirefoxDriver::Page? = @page) : Bool
      if item.as_h["nativeControl"]?
        acting = page || raise IO::Error.new("this core has no page")
        return native_control(item, acting, "tweb.focusNativeControl")
      end
      handle = handle_for(item, page)
      Actions.focus_control(handle)
      true
    ensure
      handle.try(&.dispose)
    end

    def adjust_control(item : JSON::Any, key : String,
                       page : FirefoxDriver::Page? = @page) : JSON::Any
      acting = page || raise IO::Error.new("this core has no page")
      if item.as_h["nativeControl"]?
        FirefoxDriver::Keyboard.new(acting.protocol, acting.context_id).press(key)
        return JSON::Any.new({"changed" => JSON::Any.new(true),
                              "fallback" => JSON::Any.new(false)})
      end
      handle = handle_for(item, acting)
      role = item.as_h["role"]?.try(&.as_s?)
      keyboard = FirefoxDriver::Keyboard.new(acting.protocol, handle.context_id)
      Actions.adjust_control(keyboard, handle.context_id, role, handle, key)
    ensure
      handle.try(&.dispose)
    end

    def attach_files(item : JSON::Any, paths : Array(String),
                     page : FirefoxDriver::Page? = @page) : Bool
      acting = page || raise IO::Error.new("this core has no page")
      handle = handle_for(item, acting)
      attached = acting.set_files(handle, paths)
      remember_attached_files(item, paths, acting.context_id)
      attached
    ensure
      handle.try(&.dispose)
    end

    def hover(item : JSON::Any, page : FirefoxDriver::Page? = @page) : JSON::Any
      acting = page || raise IO::Error.new("this core has no page")
      handle = handle_for(item, acting)
      Actions.hover(acting.protocol, handle.context_id, handle)
    ensure
      handle.try(&.dispose)
    end

    # Give a link to the browser's own download manager without navigating
    # the tab away from the page (src/core.js Core.prototype.downloadLink).
    # Both engines implement this as their native Alt-click gesture, so
    # cookies, proxy settings, filename selection and the downloads list
    # remain the browser's rather than being reimplemented here.
    def download_link(item : JSON::Any, page : FirefoxDriver::Page? = @page) : JSON::Any
      role = item.as_h["role"]?.try(&.as_s?)
      unless role && Aria::LINK_ROLES.includes?(role)
        return JSON::Any.new({
          "ok"     => JSON::Any.new(false),
          "reason" => JSON::Any.new("this line is not a link"),
        })
      end
      acting = page || raise IO::Error.new("this core has no page")
      handle = handle_for(item, acting)
      ready = handle.evaluate(Actions::PREPARE_REAL_CLICK)
      ok = ready.as_h?.try(&.["ok"]?.try(&.as_bool?)) || false
      unless ok
        reason = ready.as_h?.try(&.["reason"]?.try(&.as_s?)) ||
                 "could not be found on the page"
        return JSON::Any.new({
          "ok"     => JSON::Any.new(false),
          "reason" => JSON::Any.new(reason),
        })
      end
      Actions.download_link(acting.protocol, handle.context_id, handle)
      JSON::Any.new({"ok" => JSON::Any.new(true)})
    ensure
      handle.try(&.dispose)
    end

    # The href of the element we are about to activate, so a fragment link can
    # be followed even when the page cancels the click and handles it in
    # script — in which case the URL never changes and there is nothing else
    # to go on (src/core.js Core.prototype.fragmentOf).
    def fragment_of(item : JSON::Any, page : FirefoxDriver::Page? = @page) : String?
      if DOM_SOURCES.includes?(@source)
        href = item.as_h["attrs"]?.try(&.as_h?).try(&.["href"]?).try(&.as_s?)
        return fragment_hash(href)
      end
      handle : FirefoxDriver::Handle? = nil
      begin
        handle = handle_for(item, page)
        fragment_hash(handle.not_nil!.evaluate("(el) => el.getAttribute('href')").as_s?)
      rescue
        nil
      ensure
        handle.try(&.dispose)
      end
    end

    # Which block a fragment points at, found through the text at the target:
    # the buffer has no ids in it, and the anchor itself is usually an empty
    # element with nothing to match on (src/core.js Core.prototype.blockAtFragment).
    def block_at_fragment(hash : String, page : FirefoxDriver::Page? = @page) : Int32
      acting = page || raise IO::Error.new("this core has no page")
      snippet = acting.evaluate(TEXT_AT_FRAGMENT, JSON::Any.new(hash)).as_s?
      return -1 unless snippet && !snippet.empty?
      Core.find_block_with_text(@blocks, snippet)
    rescue
      -1
    end

    # The Core-side policy of src/index.js onExternalNavigation: classify a
    # URL the browser reports against the one the buffer was built from.
    # Nothing to do when it is the address we already described; a fragment
    # is the same document, so the buffer stands and only the baseline
    # advances (activation moves the reader to the target itself, and the
    # observer catches any real change); anything else replaced the document
    # and the front end owes a rebuild with the cursor reset.
    def external_navigation(url : String) : Symbol
      return :same if url == @rendered_url
      if Core.same_document_fragment(@rendered_url, url)
        @rendered_url = url
        return :fragment
      end
      @rendered_url = url
      :navigated
    end

    # One live-update cycle, start to finish: the core half of
    # src/index.js's onLiveEvent and its refresh tick. A collected batch is
    # classified; a batch that was nothing but text replacements is spliced
    # into the buffer — with the caller's line-count guard, because a patch
    # that reflows the buffer would move the reader, and moving the reader is
    # the one thing a live update may not do — and when the accounting says a
    # refresh is due the buffer is rebuilt and re-anchored. The accounting is
    # the policy: a patch that lands ends the event, a patch that misses and
    # every other change mark the buffer dirty, and dirty state is cleared
    # only once a refresh has actually replaced it.
    def live_cycle(payload : JSON::Any?, page : FirefoxDriver::Page? = @page,
                   wraps : Proc(Array(Int32), Bool)? = nil,
                   keep_place : Bool? = nil) : JSON::Any
      classified = classify(payload).as_h
      announcements = classified["announcements"].as_a
      mutations = classified["mutations"]?.try(&.as_i64?) || 0_i64
      patched : Array(Int32)? = nil
      if (raw = classified["patches"]?) && !raw.raw.nil? && !@live.refreshing
        if applied = patch_text(raw.as_a? || [] of JSON::Any, protect: reading?)
          if wraps && !wraps.call(applied.touched)
            applied.undo.call
          else
            patched = applied.touched
            record_changes(applied.touched.map { |index| Region.new(index, index) })
          end
        end
      end

      if patched.nil?
        @live.mutations += mutations
        @live.dirty = true
      end

      rebuilt : RebuildResult? = nil
      if Live.refresh_due?(@live)
        was_navigation = @live.navigated
        keep = keep_place.nil? ? (!was_navigation && reading?) : keep_place.not_nil!
        @live.refreshing = true
        @live.refreshes += 1
        @live.navigated = false
        begin
          rebuilt = rebuild(anchor, page, keep_place: keep)
          @live.dirty = false
          @live.mutations = 0
          @live.last_refresh_ms = Time.utc.to_unix_ms
        rescue
          # Navigating again already; the next batch will catch up.
          nil
        ensure
          @live.refreshing = false
        end
      end

      JSON::Any.new({
        "announcements" => JSON::Any.new(announcements),
        "patched"       => JSON::Any.new(patched ?
          patched.not_nil!.map { |index| JSON::Any.new(index.to_i64) } : nil),
        "dirty"         => JSON::Any.new(@live.dirty),
        "refreshed"     => JSON::Any.new(!rebuilt.nil?),
        "settled"       => JSON::Any.new(rebuilt ? {
          "block" => JSON::Any.new(rebuilt.not_nil!.settled.block.to_i64),
          "exact" => JSON::Any.new(rebuilt.not_nil!.settled.exact),
        } : nil),
        "regions"       => JSON::Any.new(rebuilt ? rebuilt.not_nil!.regions.map { |change| JSON::Any.new({
          "start" => JSON::Any.new(change.start.to_i64),
          "end"   => JSON::Any.new(change.stop.to_i64),
        } of String => JSON::Any) } : nil),
      })
    end

    # A fragment href names a place in this document; anything else is not
    # ours to follow. Malformed escapes are refused rather than raised, since
    # the page, not the reader, wrote the href.
    private def fragment_hash(href : String?) : String?
      return nil unless href && href.starts_with?('#') && href.size >= 2
      # URI.decode leaves '+' alone, exactly like decodeURIComponent; the
      # www-form variant would turn it into a space.
      URI.decode(href[1..])
    rescue
      nil
    end

    def real_click(item : JSON::Any, page : FirefoxDriver::Page? = @page) : JSON::Any
      acting = page || raise IO::Error.new("this core has no page")
      if item.as_h["nativeControl"]?
        pressed = native_control(item, acting, "tweb.nativeControl")
        return JSON::Any.new({"ok" => JSON::Any.new(pressed),
          "reason" => pressed ? JSON::Any.new(nil) : JSON::Any.new(
            "the browser's #{item.as_h["name"]?.try(&.as_s?) || "media"} control is no longer visible")})
      end
      handle = handle_for(item, acting)
      Actions.real_click(acting.protocol, handle.context_id, handle)
    ensure
      handle.try(&.dispose)
    end

    private def native_control(item : JSON::Any, page : FirefoxDriver::Page,
                               symbol : String) : Bool
      object = item.as_h
      token = object["nativeControl"]? || return false
      scope = item_scope(object["frame"]?, page)
      scope.evaluate("(token) => { const press = window[Symbol.for('#{symbol}')]; return typeof press === 'function' && press(token.media, token.index); }", token).as_bool? || false
    rescue
      false
    end

    private def item_scope(frame : JSON::Any?, page : FirefoxDriver::Page) : FirefoxDriver::Frame | FirefoxDriver::Page
      return page unless frame
      context_id = if value = frame.as_s?
                     value
                   else
                     object = frame.as_h? || return page
                     object["id"]?.try(&.as_s?) || object["contextId"]?.try(&.as_s?) ||
                       object["context"]?.try(&.as_s?)
                   end
      context_id ? FirefoxDriver::Frame.new(page.protocol, context_id, page) : page
    end

    # -----------------------------------------------------------------------
    # Tabs
    #
    # Which tabs exist, which one is ours, and taking one over. What a tab
    # switch then means — that the buffer describes a different document now,
    # so there is no place to keep — is decided by whoever asked for it.
    # -----------------------------------------------------------------------

    def tabs : Array(FirefoxDriver::Page)
      driver = @driver || return [] of FirefoxDriver::Page
      driver.list_pages.reject(&.closed?)
    end

    def tab_label(page : FirefoxDriver::Page) : String
      title = page.title.gsub(/\s+/, " ").strip
      value = title.empty? ? page.url : title
      value = "untitled" if value.empty?
      value[0, Math.min(value.size, 60)]
    rescue
      "untitled"
    end

    # A background document reports itself hidden, which asks the same
    # question on every browser without needing a protocol feature of its own.
    def foreground?(page : FirefoxDriver::Page) : Bool
      page.foreground?
    end

    def where(page : FirefoxDriver::Page? = @page) : TabPosition
      all = tabs
      position = page ? (all.index(page) || -1) + 1 : 0
      TabPosition.new(position, all.size)
    end

    # The tab > or < would move to, or nil when there is only one.
    def next_tab(direction : Int32) : FirefoxDriver::Page?
      all = tabs
      return nil if all.size < 2
      current = @page.try { |page| all.index(page) } || -1
      from = current < 0 ? 0 : current
      all[(from + direction + all.size) % all.size]
    end

    # Closing repeatedly walks forward rather than doubling back.
    def tab_after(page : FirefoxDriver::Page) : FirefoxDriver::Page?
      all = tabs
      return nil if all.size < 2
      index = all.index(page) || -1
      all[((index < 0 ? 0 : index) + 1) % all.size]
    end

    # Take a tab as ours. The process-wide claim moves with us, so another
    # reader avoids this one and is free to use the tab we left.
    def adopt_tab(page : FirefoxDriver::Page) : String?
      target_id = @driver.try(&.target_id_for(page))
      if target_id && (port = @browser_port)
        Session.claim_tab(port, target_id)
      end
      # Intercept only this tab's chooser. Taking one from somebody else's tab
      # suppresses the browser's own dialog and leaves them unable to answer.
      page.arm_file_chooser rescue nil
      page.set_default_timeout(OPERATION_TIMEOUT_MS)
      page.set_default_navigation_timeout(NAVIGATION_TIMEOUT_MS)
      @page = page
      target_id
    end

    def new_tab : FirefoxDriver::Page
      driver = @driver || raise IO::Error.new("this core has no browser")
      driver.create_page
    end

    def close_tab(page : FirefoxDriver::Page) : Nil
      page.close
    end

    # -----------------------------------------------------------------------
    # File attachments
    #
    # A page can read the names of selected files but never their full shell
    # paths. Keep those paths outside the page, by frame and stable control
    # identity, and put them back into fresh blocks only while the browser's
    # names prove that the same selection remains.
    # -----------------------------------------------------------------------

    def remember_attached_files(item : JSON::Any, paths : Array(String), page_key : String) : Nil
      object = item.as_h
      file = object["file"].as_h
      frame = attachment_frame_key(object["frame"]?, page_key)
      controls = @attached_files[frame]? || begin
        made = {} of String => AttachedFile
        @attached_files[frame] = made
        made
      end
      controls[file["key"].as_s] = AttachedFile.new(
        paths.dup, paths.map { |path| File.basename(path) })
    end

    # Reconcile after a snapshot. A mismatching name means the page cleared or
    # replaced the selection, so forget the private paths rather than showing
    # something the input no longer contains.
    def restore_attached_files(page_key : String, blocks : Array(Block) = @blocks) : Array(Block)
      blocks.each do |block|
        item = block.item.as_h? || next
        file = item["file"]?.try(&.as_h?) || next
        key = file["key"]?.try(&.as_s?) || next
        frame = attachment_frame_key(item["frame"]?, page_key)
        controls = @attached_files[frame]? || next
        remembered = controls[key]? || next
        names = file["names"]?.try(&.as_a?).try(&.map(&.as_s)) || [] of String
        if names != remembered.names
          controls.delete(key)
          next
        end
        item["value"] = JSON::Any.new(remembered.paths.join(", "))
        block.text = Aria.render_line(block.item)
      end
      blocks
    end

    private def attachment_frame_key(frame : JSON::Any?, page_key : String) : String
      return page_key unless frame
      if value = frame.as_s?
        return value
      end
      object = frame.as_h? || return page_key
      object["id"]?.try(&.as_s?) || object["contextId"]?.try(&.as_s?) ||
        object["context"]?.try(&.as_s?) || page_key
    end

    # -----------------------------------------------------------------------
    # Popups that are not where their control is
    #
    # A menu or listbox is very often rendered into the end of <body> rather
    # than next to the button that opens it — a "portal", done so that no
    # ancestor's overflow or stacking can clip it. On a screen that is
    # invisible: the menu appears under the mouse. In a line list it is
    # catastrophic, because the reader presses a button and the thing they
    # asked for appears hundreds of lines below them with nothing to say it is
    # theirs. Re-reading the page finds it; it does not help them reach it.
    #
    # So it is moved. The extractor tags everything inside a popup with the id
    # its control points at, and this puts those blocks back where the reader
    # is standing. Nothing about the page changes — this is the buffer's
    # reading order, which is the only thing here that was ever the reader's.
    # -----------------------------------------------------------------------

    # Start following a popup. Deliberately does not move anything yet: this is
    # called the moment the control is pressed, when the buffer still describes
    # the page as it was before, and the popup it names does not exist in it.
    # The next read is what finds it.
    def follow_popup(controls : String?) : String?
      @popup = controls && !controls.empty? ? controls : nil
      @popup
    end

    def forget_popup : Nil
      @popup = nil
    end

    # Move the open popup's blocks to sit directly after the control that owns
    # them. Answers how many blocks moved, and forgets the popup when the page
    # has closed it.
    def relocate_popup : Int32
      id = @popup
      return 0 unless id && !id.empty?

      owned = [] of Int32
      control = -1
      @blocks.each_with_index do |block, index|
        object = block.item.as_h?
        next unless object
        if object["popup"]?.try(&.as_s?) == id
          owned << index
        elsif object["controls"]?.try(&.as_s?) == id
          control = index
        end
      end

      if owned.empty?
        # Nothing of it in the buffer. That is either "the page has closed it",
        # which the control will say, or "we have not read the page since it
        # opened", which is the ordinary case one read after pressing — and
        # forgetting on that would mean never finding it at all.
        closed = control >= 0 && @blocks[control].item.as_h?.try do |object|
          object["expanded"]? == JSON::Any.new(false)
        end
        @popup = nil if closed || control < 0
        return 0
      end
      return 0 if control < 0
      # Already in the right place: the popup is not portaled on this page, or
      # we moved it on a previous read.
      return 0 if owned[0] == control + 1

      moved = owned.map { |index| @blocks[index] }
      owned.reverse_each { |index| @blocks.delete_at(index) }
      before = owned.count { |index| index < control }
      moved.each_with_index do |block, offset|
        @blocks.insert(control - before + 1 + offset, block)
      end
      return moved.size
    end

    # Where the open popup's entries begin, or -1.
    def popup_controls : String?
      @popup
    end

    def popup_at : Int32
      id = @popup
      return -1 unless id && !id.empty?
      @blocks.index do |block|
        block.item.as_h?.try { |object| object["popup"]?.try(&.as_s?) == id }
      end || -1
    end

    # -----------------------------------------------------------------------
    # Dropdowns
    #
    # A native <select> is not a text field and never was, and the popup it
    # opens is drawn by the browser rather than by the page — no click can
    # reach it and no amount of walking the DOM will find it. What *is* in the
    # DOM is the list of options, all of it, always. So there is nothing to
    # open: the entries are read straight off the element and spliced into the
    # buffer underneath the control, where they can be moved through and
    # filtered like anything else the reader can see.
    # -----------------------------------------------------------------------

    # The entries of a native select, read from the element while its browser
    # popup remains closed.
    def options_for(item : JSON::Any, page : FirefoxDriver::Page? = @page) : JSON::Any?
      handle = handle_for(item, page)
      begin
        answer = handle.evaluate(<<-'JS')
          (el) => {
            if (!el || el.tagName !== 'SELECT') return null;
            return {
              multiple: !!el.multiple,
              selectedIndex: el.selectedIndex,
              options: Array.from(el.options).map((option) => ({
                text: (option.textContent || '').replace(/\s+/g, ' ').trim() || option.value,
                disabled: !!option.disabled,
                selected: !!option.selected,
              })),
            };
          }
          JS
        answer.raw.nil? ? nil : answer
      ensure
        handle.dispose rescue nil
      end
    end

    def choose_option(item : JSON::Any, index : Int32,
                      page : FirefoxDriver::Page? = @page) : JSON::Any
      target = page || raise IO::Error.new("this core has no page")
      handle = handle_for(item, target)
      begin
        key = handle.evaluate(<<-'JS', JSON::Any.new(index.to_i64))
          (el, target) => {
            if (!el || el.tagName !== 'SELECT') return null;
            el.focus();
            if (el.selectedIndex === target) return 'already';
            el.selectedIndex = target > 0 ? target - 1 : target + 1;
            return target > 0 ? 'ArrowDown' : 'ArrowUp';
          }
          JS
        return JSON::Any.new({"changed" => JSON::Any.new(false),
                              "reason" => JSON::Any.new("not a select")}) if key.raw.nil?
        return JSON::Any.new({"changed" => JSON::Any.new(false),
                              "reason" => JSON::Any.new("already chosen")}) if key.as_s == "already"
        FirefoxDriver::Keyboard.new(target.protocol, target.context_id).press(key.as_s)
        JSON::Any.new({"changed" => JSON::Any.new(true)})
      ensure
        handle.dispose rescue nil
      end
    end

    def field_for_typing(item : JSON::Any,
                         page : FirefoxDriver::Page? = @page) : JSON::Any?
      handle = handle_for(item, page)
      editable = handle.evaluate(<<-'JS').as_bool? || false
        (el) => {
          const tag = el && el.tagName;
          return !!el && !el.disabled && !el.readOnly &&
            (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable);
        }
        JS
      unless editable
        handle.dispose rescue nil
        return nil
      end
      handle.evaluate("(el) => el.focus()")
      info = Fields.read_field_state(handle)
      @typing_handle.try { |old| old.dispose rescue nil unless old.same?(handle) }
      @typing_handle = handle
      info
    rescue error
      handle.try(&.dispose) rescue nil
      raise error
    end

    def read_typing_field : JSON::Any?
      handle = @typing_handle || return nil
      Fields.read_field_state(handle)
    end

    def release_typing_field : Nil
      handle = @typing_handle
      @typing_handle = nil
      handle.try(&.dispose) rescue nil
    end

    # Splice a dropdown's entries into the buffer under its control. They are
    # ordinary blocks from here on, so moving through them, wrapping them and
    # finding text in them all work without knowing anything about dropdowns.
    def open_chooser(block_index : Int32, listing : JSON::Any) : Chooser
      close_chooser
      object = listing.as_h? || {} of String => JSON::Any
      chooser = Chooser.new
      chooser.block_index = block_index
      chooser.at = block_index + 1
      chooser.count = 0
      chooser.filter = ""
      chooser.shown = [] of Int32
      chooser.options = object["options"]?.try(&.as_a?) || [] of JSON::Any
      chooser.multiple = object["multiple"]?.try(&.as_bool?) || false
      @chooser = chooser
      show_chooser
      chooser
    end

    # (Re)draw the entries, honouring the filter. Filtering happens here and
    # never at the page: these are our lines, and typing at the control would
    # reach a widget that may have no key handler at all.
    def show_chooser(filter : String? = nil) : Int32
      chooser = @chooser || return 0
      chooser.filter = filter unless filter.nil?
      @blocks.delete_at(chooser.at, chooser.count) if chooser.count > 0

      needle = chooser.filter.strip.downcase
      shown = [] of Int32
      blocks = [] of Block
      chooser.options.each_with_index do |option, index|
        object = option.as_h? || {} of String => JSON::Any
        option_text = object["text"]?.try(&.as_s?) || ""
        next if !needle.empty? && !option_text.downcase.includes?(needle)
        selected = object["selected"]?.try(&.as_bool?) || false
        disabled = object["disabled"]?.try(&.as_bool?) || false
        shown << index
        blocks << Block.new(
          "    #{selected ? "(*)" : "( )"} #{option_text}" + (disabled ? " — unavailable" : ""),
          JSON::Any.new({
            "role"         => JSON::Any.new("option"),
            "name"         => JSON::Any.new(option_text),
            "chooserIndex" => JSON::Any.new(index.to_i64),
            "disabled"     => JSON::Any.new(disabled),
          })
        )
      end

      blocks.each_with_index { |entry, offset| @blocks.insert(chooser.at + offset, entry) }
      chooser.count = blocks.size
      chooser.shown = shown
      blocks.size
    end

    def close_chooser : Nil
      if chooser = @chooser
        @blocks.delete_at(chooser.at, chooser.count) if chooser.count > 0
      end
      @chooser = nil
    end

    # Whether a block index is one of the open dropdown's entries.
    def in_chooser?(block_index : Int32) : Bool
      chooser = @chooser || return false
      block_index >= chooser.at && block_index < chooser.at + chooser.count
    end
  end
end
