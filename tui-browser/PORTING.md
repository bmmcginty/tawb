# The seam

What in this program is tied to JavaScript, what is tied to Playwright, and
what is tied to owning a terminal — written down before any of it is moved,
because the answers are not what the file layout suggests.

Two questions prompted it: whether to rewrite the reader in Crystal, and
whether it should instead become something edbrowse drives. They are
different questions and they cut the program in different places, so the
useful thing to establish first is where the cuts actually fall.

Line counts below are measured, not estimated, and include comments — 26% of
this codebase is comment, and those comments are the design record. A port
that drops them keeps the code and loses the reasons.

## The three layers

| Layer | Lines | Ported by |
| --- | --- | --- |
| Runs **inside the browser** (JavaScript, always) | ~970 | Copying it |
| Talks to the **browser protocol** (CDP, BiDi, Marionette) | ~1,800 | Rewriting against the same wire format |
| The **reader**: buffer, policy, terminal | ~4,050 | Rewriting, or discarding entirely |

### Layer 1: the code that cannot be ported

Just under a thousand lines run in the page, evaluated over the protocol.
They are JavaScript because the page is JavaScript. No rewrite touches them
— a Crystal or C port ships them as string assets and evaluates them exactly
as today.

| What | Where | Lines |
| --- | --- | --- |
| Accessibility tree | `ax_own.js` `extractAxItems` | 302 |
| Visible-content walk (PAGE) | `render_html.js` `extractVisible` | 140 |
| Mutation observer for live updates | `live.js` `OBSERVER_SCRIPT` | 136 |
| Markup serialiser (SOURCE) | `source_html.js` `extractSource` | 104 |
| Hit-test check before a real click | `click.js` `prepareRealClick` | 61 |
| DOM walk (HTML) | `dom.js` `extractDom` | 70 |
| Feed scrolling | `index.js` `SCROLL_TO_BOTTOM` / `RESTORE_SCROLL` | 45 |
| Fragment target lookup | `index.js` `TEXT_AT_FRAGMENT` | 32 |
| Aiming a click at the deepest child | `click.js` `clickThrough` | 30 |
| Cross-view element identity | `place.js` `describeElement` / `locateElement` | 41 |
| Change fingerprint | `live.js` `PULSE_SCRIPT` | 9 |

These are also the *hardest* lines in the program. `extractAxItems` alone
implements accessible-name computation, implicit roles, hidden-subtree rules
and prose merging — three bugs in it were found by holding it against
Playwright's tree on real pages, which is what `tools/compare.js` exists for.

Keeping them is therefore the single largest reason a port is feasible at
all: the part that took the longest to get right is the part that does not
move.

**What a port must add around them:** they are currently JavaScript function
objects passed to `evaluate()`, which serialises them with `toString()`. In
another language they become string constants. Two consequences worth
planning for — there is no syntax checking at build time any more, so they
need a smoke test that evaluates each one against a real page and asserts a
non-empty result; and the closure-free discipline they already follow (every
one is self-contained, taking only serialisable arguments) becomes a hard
requirement rather than a convention.

### Layer 2: the protocol

Two engines, two protocols, and they are in very different states.

**Firefox is already portable.** `driver_firefox.js` (733 lines) speaks
WebDriver BiDi over a WebSocket with no Playwright at all: `session.new`,
`browsingContext.*`, `script.callFunction`, `script.disown`,
`input.performActions`, `input.releaseActions`, plus a handful of events.
`bidi.js` (136 lines) is the client. `firefox.js` (412) launches the browser,
writes profile preferences, clears the automation flag through Marionette and
recovers stranded sessions — Marionette being a raw TCP socket carrying
length-prefixed JSON, which any language can speak in fifty lines.

This is the proof that the protocol layer ports. It also means Firefox is the
sensible first target for any rewrite: there is no dependency to replace,
only a translation to make.

**Chromium is where the work is.** `driver_chromium.js` is 121 lines because
Playwright does the rest. The whole dependency surface:

| Playwright call | CDP underneath |
| --- | --- |
| `chromium.connectOverCDP(url)` | `GET /json/version` for the WebSocket URL, then `Target.setDiscoverTargets`, `Target.attachToTarget {flatten: true}` per tab |
| `context.pages()`, `newPage()` | `Target.getTargets`, `Target.createTarget` |
| `page.close()` | `Target.closeTarget` |
| `page.evaluate()` / `evaluateHandle()` | `Runtime.callFunctionOn` with `awaitPromise`, `returnByValue` on or off; handles are `RemoteObject.objectId` |
| `frame.evaluate()` in a child frame | `Page.getFrameTree` plus `Runtime.executionContextCreated` to map frame → execution context |
| `frame.$$('iframe, frame')` + `contentFrame()` | `DOM.querySelectorAll`, `DOM.describeNode` → `frameId` |
| `handle.click()` | `DOM.scrollIntoViewIfNeeded`, `DOM.getContentQuads` (already in top-level viewport coordinates), `Input.dispatchMouseEvent` ×3 |
| `page.keyboard.press()` / `type()` | `Input.dispatchKeyEvent`, with `text` set for insertion |
| `page.waitForLoadState()` | `Page.lifecycleEvent` |
| `page.on('framenavigated')` | `Page.frameNavigated` |
| `context.on('page')` | `Target.attachedToTarget` |
| `context.newCDPSession()` | already CDP |
| `locator('body').ariaSnapshot()` | **nothing** — replace with our own `ax_own.js` |
| `getByRole(...).elementHandle()` | **nothing** — unnecessary once the tree carries `axIndex`, as the Firefox path already proves |
| `chromium.executablePath()` | drop it; it is only a last-resort way to find a browser binary |

The last three rows matter: two of Playwright's five real contributions
disappear the moment Chromium uses `ax_own.js` for its accessibility tree,
which is a change that can be made *today*, in JavaScript, and validated with
`compare` before any port begins. Doing that first turns "replace Playwright"
into "write a CDP client", which is a bounded, well-documented job of roughly
the size `driver_firefox.js` already is.

**The one genuinely hard piece is out-of-process iframes.** In Chrome a
cross-origin iframe is a separate target with its own session; Playwright
hides that. A port needs `Target.setAutoAttach` with `flatten` and a session
per frame target, and must route evaluations to the right one.
`frames.js` (166 lines) is written against the "frames are frames" model, and
its ordering assumption — the Nth frame element belongs to the Nth child
context — is exactly what BiDi forced on us already, so the shape survives.

### Layer 3: the reader

Roughly 4,050 lines, and the internal split is the thing that decides how
much a port costs — because one part of it is throwaway and the other part is
the program's actual value.

| Part | Where | Lines | Status in a port |
| --- | --- | --- | --- |
| Terminal drawing and cursor | `index.js` (draw*/render/repaint/park/scroll region) | ~350 | Discarded or rewritten |
| Key handling and prompts | `index.js` (four `handle*Key` functions) | ~300 | Rewritten |
| Line layout and wrapping | `layout.js` | 100 | Rewritten, mechanical |
| Buffer model, blocks, roles | `blocks.js`, `aria.js`, `remap.js` | ~500 | Rewritten, mechanical |
| Place-keeping across views | `place.js` | 358 | Rewritten — **read the comments first** |
| Live-update policy | `live.js` + `runLiveRefresh`, `onLiveEvent`, `pulseLive` | ~600 | Rewritten — **policy, not mechanism** |
| Re-anchoring after an update | `index.js` `reanchorQuietly`, `restoreAnchor` | ~130 | Rewritten — **policy** |
| Tabs, sessions, claims | `index.js` tab functions, `session.js`, `endpoint.js` | ~340 | Rewritten, mechanical |
| Startup, shutdown, logging | `index.js` `main`/`shutdown`, `log.js` | ~350 | Rewritten, mechanical |

The rows marked *policy* are the expensive ones, and they are expensive in a
way that has nothing to do with the language. They encode decisions that took
real pages to discover:

- The buffer freezes while keys are being pressed and thaws about 2.5s after
  the last one, because a list that reflows under a reader moves them
  mid-sentence.
- Text that only rewrites itself (a clock) is patched in place without a
  snapshot, and never on the line the reader is on.
- `aria-live` announcements are never delayed, whatever the freeze is doing.
- After a rebuild the cursor moves by *comparing* old and new line lists, not
  by searching for its line — and if the line is gone, it stays put rather
  than teleporting somewhere proportional.
- Position across views is matched by **element**, never by line number or
  text, with an exact text match beating an inexact element match.
- Only rows whose text changed are repainted, whoever changed them.

**A port that reimplements the mechanisms and re-derives these rules from
scratch will be worse than this program, in ways its author will not notice
for months.** They are the part to copy deliberately, comments and all.

## Damage models and back buffers

Since the terminal layer is the part most likely to be rewritten — or deleted
— here is precisely what it does today and what a full implementation of the
idea would add.

### The vocabulary

A **front buffer** is what the terminal is actually showing. A **back buffer**
is the program's own copy of what it believes the terminal is showing —
usually a grid of cells, each holding a character and its attributes.
**Damage** is the difference between the two: the set of cells, runs or rows
that need to change for the terminal to match the model. A **damage model** is
the bookkeeping that tracks it, and the painter's job is to emit the smallest
sequence of escape codes that repairs the damage.

The reason any of this exists is that terminals are slow and dumb: you cannot
ask them what they are showing, so you must remember it, and every byte you
send costs time on a serial line, an SSH connection or a braille display's
refresh.

In this program there is a third reason that outranks both: **a repainted row
is re-read.** A screen reader announcing changes, or a braille display
tracking the cursor, reacts to a row being rewritten whether or not its text
differs. Repainting the whole screen to change one line is not merely wasteful
here, it is *noise in the user's ear.*

### What this program does now

A **transient, row-level damage model with no persistent back buffer.**

Immediately before an update, `screenBefore()` records the text of the rows
currently visible — a sparse array indexed by line number, only as wide as the
viewport, since the buffer behind it can be 17,000 lines. After the update,
`repaintList()` compares each visible row against what the model now says it
should be, and `patchVisibleRows()` writes only the rows that differ. The
"back buffer" therefore lives for the duration of one update and is thrown
away.

Two things make that cheap and sufficient:

- The content is a **flat list of lines**, one item per line, with no colour
  and no attributes. A cell-level model would have nothing to say that a
  row-level one does not.
- **Scrolling is already handled by the terminal.** `moveSelection()` sets a
  scroll region (DECSTBM) and emits a single IND or RI when the view moves by
  one line, so stepping through a page costs one row of output, not a screen.

Measured on a 24-row terminal, activating a play button: 19 rows and 904 bytes
before, 2 rows and 183 bytes after. A rescan that changes nothing costs 35
bytes. Falling back to a full repaint is deliberate in exactly four cases — a
navigation, a view switch, any scroll (every row moved, so a row-by-row
comparison means nothing), and a resize.

### What a real back buffer would add

A persistent implementation — what ncurses, notcurses or blessed give you —
keeps the grid between updates and adds:

1. **Draw-anywhere freedom.** Any code path could paint without first
   recording what was on screen. Today every caller has to capture
   `screenBefore()` and hand it along; forgetting to means a full repaint (the
   safe failure, but still a failure). A persistent buffer removes that
   obligation, and with it a whole class of "who owns the previous screen"
   bugs.
2. **Scroll detection.** With both screens in hand you can notice that rows
   3–19 are now rows 1–17 and emit a region scroll plus two rows, instead of
   the full repaint we currently fall back to. This is the one case where our
   model measurably loses: `PgDn` and `G` repaint everything.
3. **Cell-level runs.** Repainting only the changed *columns* of a row. Worth
   almost nothing here — our rows are prose that changes wholesale — and
   actively unhelpful for a braille display, which re-reads the row anyway.
4. **Resize handling for free**, by re-flowing into the new grid and letting
   the diff sort out the rest.
5. **Attribute tracking**, if colour or emphasis ever arrived. Note that this
   program deliberately has none: it is read through a screen reader, and a
   colour is not something it can say.

Of those, only (1) and (2) are real gains, and (2) is worth perhaps 500 bytes
on a page-down. That is why the recommendation stands: **do not build a back
buffer in JavaScript.** In a Crystal or C port the calculus changes, because
you do not build it — a curses layer hands it to you, and rows (1) and (2)
come along.

### If a port does use curses, one rule is not optional

Curses libraries own the cursor. They move it wherever their last write left
it, or to a position you set at refresh time. In this program **the terminal
cursor is the user interface** — it is what a screen reader and a braille
display follow, and it must end every operation on the reader's line, at the
reader's column, with nothing printed to mark it (a marker would shift every
line sideways and cost a braille cell per row).

Any curses port must therefore treat "park the cursor" as the last act of
every paint, exactly as `parkCursor()` does, and must never let the library's
own cursor placement stand. This is the single most likely thing for a port to
get subtly wrong, because on a sighted developer's screen it looks fine.

## If it becomes an edbrowse backend

edbrowse is C, line-oriented, and has its own JavaScript engine and its own
browse mode. Embedding this into it means the reader layer — all 650 lines of
terminal and key handling — **disappears**, along with the address bar, the
find prompt, the scroll region and the cursor parking. That is a strong
argument against investing further in any of them.

What survives is everything that makes this program worth embedding: the
drivers, the in-page extractors, place-keeping across views, the live-update
policy, and tab handling.

### The recommended shape: a subprocess, not a library

A JSON-lines protocol over stdio, with this program as the child. The reasons
are not stylistic:

- The browser is the thing most likely to hang, and a hang must not take the
  editor with it. Every operation here is already bounded by a timeout for the
  same reason.
- Linking would mean a Crystal or C ABI *and* a shared event loop with
  edbrowse's own JS engine. Two JavaScript runtimes in one process, one of
  them driving a browser, is a debugging surface nobody wants.
- The data crossing the boundary is small: a list of lines, and commands
  naming a line.

A sufficient verb set, from what the key handlers actually do today:

| Request | Meaning |
| --- | --- |
| `open <url>` | Navigate this tab |
| `buffer` | The current view as lines: text, role, level, and a stable id per line |
| `view <ax\|page\|html\|source>` | Switch view, keeping the place by element |
| `activate <id>` | What `Enter` does — the DOM's own default action |
| `click <id>` | What `m` does — a trusted click carrying user activation |
| `type <id> <text>` / `submit <id>` | Field editing through real key events |
| `more` | What pressing down at the last line does: ask a feed for the rest |
| `refresh`, `live <on\|off>` | Rescan; enable or disable live updating |
| `tabs`, `tab <n>`, `close` | Tab list, switch, close (never the last) |

And unsolicited events, which is the part a request/response protocol usually
forgets: `announce` for `aria-live` regions, `changed` for areas that rewrote
themselves, `navigated`, `tab-opened`, `tab-closed`.

### The freeze policy needs no cooperation

The one piece of behaviour that looks like it needs edbrowse's help does not.
Today the buffer freezes while keys are pressed and thaws 2.5s after the last
one. A backend cannot see keystrokes — but it does not need to: **freeze on
every request, thaw 2.5 seconds after the last one.** A reader moving around
issues commands; a reader who has stopped issues none. The behaviour falls out
of the same timer, driven by request arrival instead of key arrival.

### What edbrowse would have to accept

Its buffer becomes ours. Line numbers must map to our ids, and a rebuild
renumbers — which is precisely the problem `place.js` and `reanchorQuietly()`
already solve, and would have to solve again on edbrowse's side unless the ids
travel with the lines. Hand it ids, not just text.

## A staged order, if it happens

1. **Drop Playwright's accessibility tree on Chromium first, in JavaScript.**
   Switch `driver_chromium.js` to `ax_own.js` and use `compare` to hold the
   two against each other on real pages until they agree. This removes two of
   the five things Playwright does for us, in the language where it is cheap
   to iterate, and it is worth doing even if no port ever happens.
2. **Build a fixture set.** Saved pages served locally, so two
   implementations can be run over identical bytes. `tools/compare.js` already
   diffs two line lists; point it at implementation-versus-implementation
   rather than engine-versus-engine, and the JavaScript version becomes the
   oracle the port is measured against.
3. **Port the Firefox driver.** No dependency to replace, a wire format
   already spoken here, and a working reference implementation next to it.
   Crystal needs nothing beyond its standard library for this: `HTTP::WebSocket`
   for BiDi, `JSON` for the messages, a plain `TCPSocket` for Marionette, and
   `Process` for launching the browser. No C bindings, no curses yet.
4. **Write the CDP client.** The table above is the specification. Budget for
   out-of-process iframes; everything else is mechanical.
5. **Then, and only then, choose the front end** — own terminal or edbrowse
   backend. Both consume the same core, and by this point the core is proven
   against the oracle.

Stopping after stage 3 leaves a working Firefox-only reader in the new
language, which is a real thing to have and a reasonable place to pause.

## What would be lost with Playwright

Named honestly, since it is the dependency a rewrite removes:

- **Auto-waiting and actionability.** Its `click()` waits for an element to be
  stable, visible and unobscured. We already replaced the parts we needed with
  `prepareRealClick()`, which is stricter about what it reports and does not
  wait.
- **The accessibility tree.** Replaced by `ax_own.js`, which is already the
  Firefox path and is validated against Playwright's by `compare`.
- **Out-of-process iframe plumbing.** Not replaced. This is the real cost.
- **Protocol churn absorption.** Chrome changes CDP; Playwright tracks it. A
  hand-written client inherits that maintenance — though the domains used here
  (`Runtime`, `Page`, `DOM`, `Input`, `Target`) are the oldest and most stable
  in the protocol.

## The rule underneath all of it

The reason this program works is not any of its code. It is that it drives an
**ordinary browser** — started normally, attached to, never launched by an
automation harness, never announcing itself as automated — because a browser
that fails bot checks is not a degraded reader, it is a broken one.

Every layer above bends to that. It is why there is no headless mode, why
Firefox's automation flag is cleared through Marionette and Marionette is left
listening, why the profile persists, why the virtual screen is a desktop's
size. **A port that quietly reintroduces a Playwright-launched or headless
browser to make its own life easier has failed no matter how clean the code
is**, and it will fail in a way that only shows up on the sites that matter.
