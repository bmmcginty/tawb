# tui-browser

A terminal browser for reading the web from the command line, built for a
blind user. It drives an ordinary Chrome, Chromium or Firefox and
presents each page as a linear list of lines — the model a screen reader's
browse mode uses — instead of trying to draw the page as text art.

The terminal cursor itself marks your position, so whatever already reads
your terminal (a screen reader, a braille display, Speakup on the console)
tracks it without this program needing to speak.

```
cd tui-browser
npm install
npm start -- https://en.wikipedia.org/wiki/Braille
```

## It drives a real browser, not an automated one

This starts an ordinary Chrome, Chromium or Firefox and watches it. It does not let
Playwright launch the browser, because a Playwright-launched browser
advertises itself as automated — `navigator.webdriver` is true — and sites
that react to that leave you parked on pages which never load. Measured
against the Cloudflare check pastebin.com puts in front of `/login`:

| How the browser is started | Result |
| -------------------------- | ------ |
| Playwright, headless        | never clears |
| Playwright, headed          | never clears |
| Started normally, attached to | clears in ~4s |

There is no fallback to an automated browser. A browser that cannot load
the page is not a degraded mode, it is a broken one.

Nothing here spoofs a User-Agent or patches headers. A real browser sends
correct, self-consistent headers on its own; forging them is only necessary
when disguising a headless browser, and we do not run one.

A headless browser fails those checks even when started normally, so with no
`DISPLAY` the browser runs under Xvfb — a real browser drawing to a virtual
screen. Install `xvfb` if you are not in a graphical session.

That screen is 1280x1024. `xvfb-run` defaults to 640x480, and 640x480 is not
a small window, it is a different web: pages serve their narrow layout,
sticky bars cover most of what is left, and the browser window came out
620x373 in Chromium and 576x347 in Firefox. On a desktop-sized screen they
open at 1050x917 and 1152x836 without being told to.

Your profile persists between runs, so logins and cookies survive:

```
npm start -- --profile ~/.local/share/tui-browser/profile https://example.com
npm start -- --connect 9222 https://example.com   # attach to a browser you started
```

To use a browser you are already running, start it with
`--remote-debugging-port=9222` and pass `--connect 9222`.

## Firefox

```
npm start -- --browser firefox https://example.com
npm run compare -- https://example.com      # read it in both, diff the result
```

Firefox is driven over WebDriver BiDi, because Mozilla removed CDP and
Playwright cannot attach to a Firefox you started yourself — only launch a
patched build of its own, which is the automated browser this project exists
not to use.

The same rule applies as everywhere else here: **a browser that fails bot
checks is not a degraded reader, it is a broken one.** Firefox makes that
harder in exactly one way, and it is worth being precise about which. Against
a probe collecting what anti-bot scripts actually read — automation globals,
document attributes, plugins, permissions state, hover and pointer media
queries, window against screen geometry, WebGL strings, whether patched
getters still report native code — an automated Firefox 147 differs from an
ordinary one in a single boolean:

```
navigator.webdriver: false -> true
```

Nothing else. Not one other field. And that boolean has one source: the
parent process publishes a shared-data key when the remote agent starts
listening, and content reads it back — once, at startup, not per session. So
it is cleared, through privileged JavaScript in the parent using Marionette's
chrome context, and Marionette is then shut down behind us.

Nothing in any page is touched. No getter is redefined and no `toString` is
patched, so there is nothing for a site to catch: the browser simply stops
announcing something about itself. Startup then asks a real page what it sees
and **refuses to run** if the answer is not `false`, so a browser that would
fail bot checks cannot slip through unnoticed.

All four views work. Three of them are injected JavaScript and care nothing
for the engine; the accessibility tree is computed by `ax_own.js`, used only
where Playwright is not there to do it. **Chromium keeps using Playwright's**,
so the path that works is not put at risk by a second implementation of the
hardest thing here — and having both means `compare` can hold them against
each other on real pages, which is how three bugs in ours were found.

On Wikipedia's Braille article the two trees are 1632 blocks each and agree
line for line for the first 58. Where they differ, ours is sometimes the
better: it folds a sentence's trailing full stop onto the link it follows,
which Playwright does inconsistently with itself two lines later, and it names
a frame from its `title` where Playwright emits a bare `<frame>`. Neither is
authoritative — `compare` surfaces the difference so you can judge it.

Child frames work by position, because BiDi offers no element-to-context link:
the Nth frame element in a document belongs to the Nth child context of it.
That is the same ordering assumption the AX path has always relied on. Live updating, the clock's fast text patch and the reading freeze all
work identically — 28 patches and no snapshots on a one-second clock, the
same as Chromium.

### Playing media

Firefox would not play audio a link started: `NotAllowedError: The play
method is not allowed by the user agent` on a Bandcamp album that played in
Chrome. That is autoplay blocking, and it is not wrong about what it saw —
activation here goes through the element's own default action rather than a
mouse driven at coordinates, and a script-initiated click carries no user
activation.

The gesture it is looking for did happen: the reader pressed Enter on the
play button. It simply cannot be conveyed over the protocol. So the profile
is configured the way a user who ticked Firefox's own **Allow Audio and
Video** would have it — `media.autoplay.default`, its blocking policy, and
`media.block-autoplay-until-in-foreground`, that last one because the tab
being read is not always the tab on screen and playback that waits for the
foreground never starts.

These are profile preferences, not page tampering, and they are written to
`user.js` before launch since Firefox reads them at startup. A Firefox that
is already running is rejoined as it is, so a change here takes effect the
next time one is started.

### Startup, and why it looks worse than it is

A cold start is 3.7s for Chromium and 5.3s for Firefox, the difference being
the automation clear. What makes Firefox *look* far slower is that a browser
already running is rejoined in tens of milliseconds, and Chromium has usually
left one running:

| | cold start | rejoin |
| --- | --- | --- |
| chromium | ~3.7s | ~50ms |
| firefox | ~5.3s | ~35ms |

`--keep-browser` leaves the browser running when you quit, so the next session
rejoins it instead of paying the cold start again.

### One reader at a time, and what happens when one dies

Firefox serves **one WebDriver session at a time**, so unlike Chromium a second
reader cannot share one Firefox. It is refused by name — *"Another reader
(process 1234) is already using this Firefox"* — rather than left to time out.

Worse, closing a connection does not end its session: Firefox only unregisters
the connection. There is no reattaching by session id, no ending it from
another connection and no expiry, so a reader that dies without saying
`session.end` used to lock every later reader out until Firefox was restarted.

Two things stop that being your problem. Exits are bounded and always tell the
browser — `SIGINT`, `SIGTERM`, `SIGHUP`, uncaught exceptions and unhandled
rejections all end the session before going, so only `SIGKILL`, an OOM kill or
losing power can strand one. And when one is stranded anyway, Marionette
releases it: it shares the same session slot and deletes the session whenever a
connection to it closes, so connecting and hanging up is the whole operation.
Measured against a reader stopped with `SIGKILL`, the next reader detects the
orphan, names the dead owner, releases it and starts in 36ms.

A session is only ever taken from an owner whose process is gone, which is why
the owning reader records its process id. Marionette cannot tell whose session
it is deleting, so that check is the only thing standing between recovery and
pulling the page out from under a reader that is still using it.

This is why Marionette is left listening for the browser's whole life rather
than shut down once the automation flag is cleared. Local port exposure is out
of scope here — anything that can reach Marionette can reach the browser's own
protocol port and drive it anyway — but there is a robustness consequence worth
knowing: while it listens, anything that connects to it and disconnects will
drop this reader's session too.

## Running more than one at a time

Chrome allows one browser per profile, so a second session joins the browser
the first one started rather than launching its own. What it will not do is
join the first session's *tab*: two sessions reading one tab navigate each
other around. A second session takes an unclaimed tab if there is one and
opens its own otherwise, and each gets its own timing log.

A session started with a URL always opens its own tab. Only a session
started without one adopts what is already on screen.

## Reading holds still while you move — this is deliberate

**The page stops updating while you are navigating, and resumes about 2.5
seconds after you stop.**

This is the behaviour most likely to look like a bug, so it is worth saying
plainly. A live page — a clock, a news ticker, anything with ads — rewrites
itself continuously. Every rewrite replaces the list of lines, and the
program then has to work out where your cursor went. That answer is not
always right, and getting it wrong once yanks you somewhere else in the
document mid-sentence.

Screen readers solve this the same way: a virtual buffer does not reflow
underneath you while you move through it. It holds still, announces live
regions, and rebuilds when you are done.

So the rule here is:

- **While you are pressing keys**, the buffer is frozen. What you are
  reading stays exactly where it is, even if the page changes underneath.
- **Once you stop for a couple of seconds**, updates flow again.
- **Text that only rewrites itself is exempt.** A clock or a counter
  replaces text without moving anything, so it keeps ticking even while you
  read — unless it is on the line you are actually on, which is frozen like
  everything else.
- **Announcements are never delayed.** `aria-live` regions — status
  messages, errors, "42 results found" — reach the status line immediately
  whether you are reading or not.

This is why watching a clock works without any special mode: watching means
not touching keys, so the page is idle-updating and the clock ticks. The
moment you start arrowing, it freezes so you can read.

Press `L` to turn live updating off entirely; `r` refreshes on demand.

When an update does land, your cursor is moved by comparing the old and new
line lists rather than by searching for your line again — so an insertion
above you shifts you by exactly that many lines, and a line that rewrites
itself (a clock) keeps you on it.

## Only what changed is repainted

A repainted row is re-read by a screen reader and re-flashed by a braille
display whether or not it says anything new, so the screen is redrawn by
comparing rows and touching only the ones whose text differs.

That rule used to apply to updates the *page* made and not to updates *you*
made. Pressing `Enter` on a play button repainted all 19 rows of a 24-row
terminal — 904 bytes — where two rows had changed and cost 52. Activating,
sending a real click, `r`, leaving a text field, submitting a form in place
and asking a feed for more all take the same path now:

| | bytes written |
| --- | --- |
| `Enter` on the play button | 904 → 183 |
| `r` (rescan, nothing changed) | 849 → 35 |
| `m` (real click) | 904 → 138 |

A full repaint is still the right answer when a row-by-row comparison cannot
mean anything, and those cases fall back to one deliberately: a navigation, a
view switch, a scroll (every row moved), and a terminal resize.

## Four views of a page

Backslash (`\`) cycles between them. The current one is shown at the start
of the address line.

| View       | What it shows                                                        |
| ---------- | -------------------------------------------------------------------- |
| `[AX]`     | The accessibility tree — what a screen reader sees.                   |
| `[PAGE]`   | Visible text derived from the DOM, for when the AX tree is wrong.     |
| `[HTML]`   | Tags and attributes, including URLs the other two views never expose. |
| `[SOURCE]` | The markup itself, as written, tag by tag.                            |

The views disagree more than you would hope, and AX is the lossy one. A
`<video>` with a perfectly playable source often reports only its fallback
text — "Your browser does not support videos." — because that text is the
element's content; the actual media URL appears nowhere in the AX tree.
`HTML` view shows the URL. That is what the third view is for.

`PAGE` names a control by whatever names it — its own text, its value, or
the label it carries — rather than by text alone. A play button is an icon
and an `aria-label` and nothing else, so a view that reads only text drops it
completely: every play button on that Bandcamp album was missing from `PAGE`
while the accessibility view listed all twelve. `role="button"` counts as a
button too, whatever tag it was built from, which is how most of them are
built.

`HTML` is a summary rather than the markup: it lists tags it considers
notable and leaves out the rest, so an `<em>` or a `<strong>` — which carry
no attributes — do not appear in it at all. `SOURCE` is the markup:

```
<p>
teenagers are just
<em>really</em>
dumb in general
</p>
```

Every element opens and closes on its own line unless it fits on one.
Script and style bodies are summarised by size instead of printed, since a
page can carry hundreds of kilobytes of code and none of it is markup. It
reads the live DOM, so it shows the page after its scripts have run — the
same page the other three views describe.

### Web components are part of the page

All four views descend into shadow roots, following the tree the browser
actually renders: an element with a shadow root renders that tree instead of
its own children, and a `<slot>` renders whatever the light DOM assigned to
it. Stopping at `childNodes` stops dead at every web component.

That is not a corner case. On the Bandcamp album page above, `<page-footer>`
is a custom element, and inside its shadow root are the whole page footer
*and* a cookie consent dialog — "We care about your privacy", `Accept all`,
`Accept necessary only` — covering the page with a fixed, 72%-opaque backdrop
on a fresh profile. None of the four views showed a word of it. The reader
could not read the dialog, could not dismiss it, and could not see why a real
click kept being refused.

Now `## We care about your privacy` and `[*Accept all]` are in all four
views, `Enter` dismisses the dialog, and `m` reaches the play button behind
it. `SOURCE` marks the boundary with a `#shadow-root` line and shows the
shadow tree there, then the light children where they are written, since that
view answers what is *there* rather than what is rendered in whose place.

`SOURCE` is not indented, deliberately. Leading spaces shift every line
sideways, and a reader who cannot see the shape of the indentation pays the
whole cost of it — `Home` lands on whitespace, a braille display spends
cells on blanks — for none of the benefit. The tags say what the
indentation would have said.

Links can be followed from any view, `SOURCE` included: `l` finds the next
`<a>` and `Enter` follows it.

### Switching views keeps your place

Position is matched by **element**, not by line number and not by text. The
four views have completely different line counts — a Bandcamp album page is
135 lines of accessibility tree and 1500 lines of markup — so a line number
means nothing across a switch, and the text does not carry either: the play
button that reads `[*Play Weird Fish]` in the accessibility tree is
`<a aria-label=Play Weird Fish>` in `HTML` and
`<a role="button" aria-label="Play Weird Fish">` in `SOURCE`, with the
`<div class="playbutton">` inside it on another line again.

Every view already knows which element each of its lines came from, because
that is how a line is activated. So switching asks the view you are leaving
which element you are on, and the view you are entering which of its lines
that element produced. Standing on the play button in any view and cycling
all the way round lands you back on the play button.

Two cases need more than that, and the status line says so — *"HTML view —
nearest place."* — rather than leaving you to work out why you are somewhere
else:

- **Prose has no element of its own.** It is a text node, and the views
  number elements. The nearest element above you is the anchor, and your own
  line is then found again by its text, searched *down from where that
  element landed* — so repeated text does not throw you across the page.
- **Playwright's accessibility tree carries no element references**, so on
  Chromium the `AX` view can be left by resolving a line's role and name to
  an element, but not entered that way. Entering it matches the element's own
  label — the `aria-label` that gave the AX line its name — and where several
  lines could match, the one nearest that element's position in the document.
  Firefox has no such gap: we compute that tree ourselves and keep the
  references, so all four views match exactly.

An element that simply is not in the view you are entering — `PAGE` lists
only what is visible — puts you on the nearest line above where it would
have been, which is a much smaller move than landing wherever its text first
matched.

## Finding text

`/` searches forward, `?` backward. The cursor lands on the matching text
itself, not merely on the line holding it, so a braille display or screen
reader reads from the match.

Case follows what you type: an all-lowercase search ignores case, one with a
capital in it does not — so `braille` finds the heading and `Braille` finds
the name. Searches wrap, and say so when they do.

There is no `n` for the next match: `n` is non-link text in the JAWS
vocabulary this reader uses, and taking a jump key away to save two
keystrokes is a poor trade. `Ctrl+G` repeats the search, which is Firefox's
key for it, and `/` or `?` with nothing typed repeats the last search in that
direction — which is how you reverse one.

## Keys

### Moving

| Key            | Action                                                       |
| -------------- | ------------------------------------------------------------ |
| `j` / `k`, `↓` / `↑` | Next / previous line (down at the end asks for more)   |
| `→` / `←`      | Next / previous character, carrying on to the next line       |
| `PgDn` / `PgUp`| Next / previous screen                                        |
| `g` / `G`      | Top / bottom of the page                                      |
| `Home` / `End` | Start / end of the current line                               |

### Jumping (the JAWS vocabulary; uppercase goes backwards)

| Key   | Jumps to                                                          |
| ----- | ----------------------------------------------------------------- |
| `h`   | Heading                                                           |
| `l`   | Link (JAWS uses `k`, which is taken by line movement here)         |
| `f`   | Form field                                                        |
| `b`   | Button                                                            |
| `n`   | Non-link text                                                     |
| `p`   | Paragraph                                                         |

### Everything else

| Key      | Action                                                          |
| -------- | --------------------------------------------------------------- |
| `Enter`  | Activate the link, button or field on this line                  |
| `/` / `?`| Find text forward / backward (empty repeats the last search)     |
| `Ctrl+G` | Find the same text again                                        |
| `m`      | Send a real click — trusted, carries user activation             |
| `Ctrl+L` | Address bar (scrolls sideways for long URLs; `Esc` cancels)      |
| `\`      | Cycle view: AX → PAGE → HTML → SOURCE                            |
| `>` / `<`| Next / previous tab                                              |
| `Shift+F4`| Close this tab (never the last one)                              |
| `c` / `C`| Jump to the next / previous area that changed                    |
| `r`      | Refresh now                                                      |
| `L`      | Turn live updating on or off                                     |
| `=`      | Say where you are (line, column, what kind of thing it is)       |
| `q`      | Quit                                                             |

There is no `>` marker on the focused line: the terminal cursor is already
sitting there, and printing a marker would only shift every line sideways.

## How lines are written

One item per line, so positions stay predictable:

```
## History              a heading, at its nesting depth
{Louis Braille}         a link
[*Search]               a button
[Search Wikipedia: dots]a field, with its current value
(image) Wikipedia logo  an image, by its alt text
Braille was based on…   ordinary text
```

Separator punctuation (`|`, `,`) is folded onto the end of the preceding
link rather than taking a line of its own, since a lone `|` says nothing.

One item per line applies to items, not to words. A bold or italic word is
a node of its own in the accessibility tree, so `teenagers are just
<em>really</em> dumb` would otherwise become three lines — and a one-word
line reads as a heading or a link when you are arrowing through, a
structural break that is not in the page. Runs of prose are joined back
into one line; links are not, so their position stays predictable, and a
paragraph boundary still ends the line. `[HTML]` view is left fragmented on
purpose, being the view for seeing what is actually there, and `[SOURCE]`
shows the emphasis itself.

A line longer than the terminal wraps, and each wrapped row is navigable in
its own right — so several rows in a row of plain prose are wrapping, while
a lone short word between full ones is not.

Embedded frames are rendered inline, where they sit in the parent page —
neither the accessibility tree nor a DOM walk descends into them on its own,
so an embedded video or comment thread would otherwise simply be missing.

## Feeds do not have a bottom

A feed has a scroll position instead. On Reddit, a search results page, a
long comment thread, the posts below the fold are not in the document at all
until something scrolls towards them — and this reader never scrolls, since
it reads the document rather than the window onto it. So the last line of
the list is not necessarily the end of the page, and from where you are
sitting the two look identical.

**Pressing down at the last line asks for the rest.** The page is scrolled to
its bottom, given a moment for whatever that sets off, and rebuilt; the new
lines appear below you and you move onto the first of them. The status line
says how many arrived, or `End of page.` if nothing did.

Nothing is rebuilt when nothing arrives — the scroll is put back as it was.
That matters more than it sounds: scrolled to the bottom, a Wikipedia article
collapses its table of contents and the page loses a couple of hundred lines
you had a moment ago.

## Tabs and windows

A link with `target="_blank"` opens a tab and the browser moves to it. **So do
we** — the browser has already gone there and you should be where the browser
is. The status line says so: *"Followed a new tab — tab 3 of 3: Page B"*.

A tab that opens *behind* is announced and left alone, because nothing moves
you without saying so. `>` and `<` step through everything open, wrapping at
either end.

Tabs in separate windows are in that same list. Neither browser's protocol
says which window a tab belongs to, and for reading purposes a window is just
somewhere else a tab can be.

If the tab you are reading closes — the page closes itself, or you close it in
the browser — you are moved to one that still exists rather than left holding
a buffer full of lines that refer to nothing.

**`Shift+F4` closes the tab you are on** and moves you to the next one, so
closing repeatedly walks forward through what is open rather than doubling
back. The last tab is never closed: a reader with no tab has no page, no
buffer and nowhere to be moved to, so the key says so and does nothing.
Quitting is `q`.

Function keys are the least standardised part of terminal input, so four
encodings of Shift+F4 are recognised: `\e[1;2S` (xterm, VTE, kitty,
alacritty, tmux), `\eO2S`, `\e[14;2~`, and `\e[26~` — the Linux console and
rxvt, which send a shifted function key as a higher-numbered one, so Shift+F4
arrives as F14. Any escape sequence nothing claims is written to `tweb.log`
with its bytes, so a terminal speaking a fifth dialect can be added by
reading the log.

## When something changes elsewhere

Pressing a button often updates a part of the page you are not looking at.
When that happens the status line says so — *"3 areas changed, press c to
jump"* — and `c` walks through them. Nothing moves you automatically.

## Where a click lands

`Enter` activates through the element's own default action, not by driving a
mouse at coordinates: a blind user has no viewport, and legitimate targets —
skip links, visually hidden controls — sit off-screen where a pointer could
never reach them.

But `element.click()` fires at that element, and a real click does not. A
mouse lands on the innermost element under the pointer and the event travels
*up* from there, so a handler bound below the labelled control hears a real
click and never heard ours. On a Bandcamp album page the control is

```
<a role="button" aria-label="Play Weird Fish"><div class="play_status"></div></a>
```

and the player listens on the inner `div`. Pressing `Enter` on the play
button did nothing at all, in both browsers, and the only way to play a
track was to switch to `HTML` view and activate the bare `<div>` there.

So the click is aimed the way a mouse would be: at the deepest descendant
covering the middle of the element. Events bubble from there back up through
the element itself, so a handler on either one hears it. The aim uses layout
boxes rather than `elementFromPoint`, which answers only for what is on
screen and would make an off-screen control unclickable again.

## A click the browser accepts as a person's

`Enter` activates through the DOM's own default action. That is the right
default for reading — it needs no viewport, and it reaches controls that are
off-screen, which is where skip links and visually hidden controls live —
but it cannot produce **user activation**. The browser knows perfectly well
that nobody touched anything, so everything gated on a real gesture refuses:
playing audio, going fullscreen, reading the clipboard, opening a window.
No amount of cleverness inside the page changes that, since the gate exists
precisely to tell the two apart.

**`m` sends a real click** — through the browser's own input pipeline, above
content, where the events are trusted and carry activation. Measured on a
Bandcamp play button: `mousedown`, `mouseup` and `click` all arrive with
`isTrusted: true` and `navigator.userActivation.isActive` true, on the inner
element the browser hit-tested to, and the track plays.

It is a separate key rather than a smarter `Enter` because it is a different
act with different costs. A real click goes to a *point on the screen*, so
the element has to be scrolled into view, and whatever is painted on top of
that point receives it. Both are checked first and reported rather than
discovered afterwards from whatever the click did instead:

```
Cannot click "Play Weird Fish": it is covered by <div.overlay-background>.
Enter activates it without a real click.
```

That was a cookie consent dialog dimming the whole page — a real click there
would have hit the modal, and saying so is more use than clicking the wrong
thing. Where the element sits is ours to choose, though, so it is placed four
ways (centre, top, bottom, nearest) and the first placement that leaves it
reachable is the one the click uses; a control under a sticky bar in the
middle of the window is often clear at the top of it.

Hit testing descends through shadow roots, because `elementFromPoint`
retargets to the shadow host — a custom element several hundred pixels away
would otherwise be reported as the thing in the way.

Chromium gets this from Playwright's own click, which is real input over the
DevTools protocol. Firefox performs the pointer actions itself over BiDi,
naming the target by shared reference so the browser computes the element's
centre rather than trusting coordinates we worked out — the same road its
keyboard already takes.

## If an action cannot complete

Activation is bounded at six seconds. Some controls genuinely cannot be
reached — a bot-check widget inside a cross-origin frame, for instance —
and rather than freeze, it gives up and tells you. Cloudflare's
"Performing security verification" pages are the common case; there is no
way in from here, so use the address bar to go somewhere else.

## Timing log

Every run writes `tweb.log` next to the package (override with `TWEB_LOG`),
one JSON record per line, timestamped from process start. A second session
started while the first is still running writes `tweb-<pid>.log` instead, so
neither log overwrites the other:

```json
{"t":1209,"event":"snapshot","source":"ax","ms":396,"blocks":346,"frames":3}
{"t":17950,"event":"live.refresh","source":"ax","totalMs":152,"snapshotMs":151,
 "reanchorMs":1,"drawMs":0,"repainted":18,"remapExact":true,"cursor":15}
```

It records startup phases, every page snapshot with its cost, live refresh
broken down by stage, text splices that avoided a snapshot (`live.patch`),
keypresses that took longer than 20ms, and any frame slower than 100ms with
the URL responsible. It is the fastest way to find
out why something felt slow — ad-heavy pages spawning hundreds of tracking
iframes have been the usual culprit.

## Reading through edbrowse instead

edbrowse renders html, tables, lists and forms better than a line list does,
and it is an editor as well as a browser. What it cannot do is run a page.
So `npm run edb` starts the same browser — ordinary, attached to, never
automation-launched — and serves its tabs to edbrowse as html over loopback
http:

```
npm run edb                       # or: npm run edb -- --browser firefox
```

It prints a tab list address and writes `~/.local/share/tui-browser/edb.json`
so the entry-point plugin can find it. Install the plugin (once):

```
cp edbrowse-plugin/edbrowse-plugin-tweb ~/bin/       # anywhere on your PATH
cat edbrowse-plugin/tweb.rc >> ~/.ebrc               # or include the file
```

Then, in edbrowse:

```
b tweb://https://skt222.bandcamp.com/album/weird-fish
```

From there it is an ordinary web page as far as edbrowse is concerned: `g`
follows a link, `i=` fills a field, `i*` presses a button, `ib` gives a
textarea its own session, `rf` re-renders the tab as it is now, `^` goes
back. The browser keeps your logins and clearance cookies, and the page has
already run its javascript, so what edbrowse renders is the page as it
actually is rather than the markup that arrived from the server.

One line at the top of each page says which site you are really on and links
to the other three views (`ax`, `text`, `source` — the reader's own line
lists) and to the tab list. `Shift+F4` has no meaning here; the tab list has
a close link per tab.

**`m` has no meaning here either**, so a real click — the kind that carries
user activation, which audio needs — is a second address: `<twebclick` on the
line, a function the config fragment installs. Everything else about
activation is the same as in the reader.

What does not survive the trip: live updating and immediate announcements.
edbrowse has no way to be told anything by an idle buffer, so `rf` is the
whole story, and it is cheap and idempotent by design.

`patches/` holds two small changes to edbrowse itself — `rf` keeping your
place, and allowing form submission to plugin protocols. Neither is needed
for any of the above; both are useful on their own and are meant for
upstream. `edb.txt` is the long-form discussion of how the two programs fit
together, including what was measured in edbrowse's source to decide it.

## If this is ever rewritten or embedded elsewhere

[`PORTING.md`](PORTING.md) is the seam: which ~970 lines must stay JavaScript
because they run inside the page, what the Playwright dependency actually
amounts to call by call, which parts are policy that took real pages to
discover and should be copied rather than re-derived, and what changes if this
becomes a backend something else drives instead of a program that owns a
terminal.

## Known rough edges

- Snapshots can spike to a couple of seconds in the first moments after an
  ad-heavy page loads, then settle to roughly 150ms. Input takes priority
  over refreshes, so it should not block you.
- A change that adds or removes anything still costs a whole-page snapshot,
  so a page that appends to a list every second stays as expensive as it
  ever was. Only replaced text takes the cheap path.
- Some sites gate particular endpoints behind bot checks. These now pass,
  because the browser is a real one, but a challenge that demands
  interaction may still need a sighted pass in the same profile — the
  clearance cookie is then reused.
