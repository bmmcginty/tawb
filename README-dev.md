# tawb

A terminal browser for reading the web from the command line, built for a
blind user. It drives an ordinary Chrome, Chromium or Firefox and
presents each page as a linear list of lines — the model a screen reader's
browse mode uses — instead of trying to draw the page as text art.

The terminal cursor itself marks your position, so whatever already reads
your terminal (a screen reader, a braille display, Speakup on the console)
tracks it without this program needing to speak.

```
cd tawb
npm start -- https://en.wikipedia.org/wiki/Braille
```

There is nothing to install. This has no dependencies: it speaks the
DevTools protocol and WebDriver BiDi to the browsers directly, over a
WebSocket, and everything else it needs is in Node.

## It drives a real browser, not an automated one

This starts an ordinary Chrome, Chromium or Firefox and watches it. It never
lets an automation harness launch one, because a browser launched that way
advertises itself as automated — `navigator.webdriver` is true — and sites
that react to that leave you parked on pages which never load. Measured
against the Cloudflare check pastebin.com puts in front of `/login`:

| How the browser is started | Result |
| -------------------------- | ------ |
| Launched by Playwright, headless | never clears |
| Launched by Playwright, headed   | never clears |
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

Under `xvfb-run` the browser's stderr is not its own: Debian's wrapper runs
its command as `"$@" 2>&1`, so everything the browser says arrives on stdout.
Both streams are captured at launch for that reason — watching stderr alone on
a machine with no display is watching a stream that is empty by construction,
and that is why headless Ubuntu once reported startup timeouts with no
explanation attached to them.

A Snap-packaged browser reaches non-hidden files under `$HOME` and nothing
else, so `~/.local/share` is invisible to it and `/tmp` is private to it. Such
a browser is given a profile under `~/snap/<name>/common/tawb/` instead, and an
unreachable `--profile` is refused before launch rather than after the timeout:
told to use a profile it cannot open, Firefox does not exit, it waits on a
window drawn to a screen nobody is looking at.

`TAWB_BROWSER_TIMEOUT`, in seconds, replaces the startup wait (25s for
Chromium, 45s for Firefox). It exists to tell a slow first launch apart from
one that was never going to finish.

Your profile persists between runs, so logins and cookies survive:

```
npm start -- --profile ~/.local/share/tawb/profile https://example.com
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

All four views work, and none of them cares which engine is underneath.
Three are injected JavaScript; the accessibility tree is computed by
`ax_own.js`, in the page, on both browsers.

It was Playwright's on Chromium for as long as ours was unproven, and the two
were held against each other on real pages until they agreed — which is how
three bugs in ours were found. On Wikipedia's Braille article the two trees
were 1632 blocks each and agreed line for line for the first 58. Where they
differed ours was sometimes the better: it folds a sentence's trailing full
stop onto the link it follows, which Playwright did inconsistently with
itself two lines later, and it names a frame from its `title` where
Playwright emitted a bare `<frame>`. `compare` now holds the two engines
against each other instead.

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

A native `<video controls>` or `<audio controls>` also exposes the controls the
browser actually laid out beneath the player's status line in AX view: Play,
Mute, the position and volume sliders, fullscreen, and whichever overflow
controls fit. Chromium supplies them from its user-agent shadow roots over
CDP. Firefox's privileged shadow-root helper describes the same controls,
since page script is forbidden from reading those roots directly. Only
controls with a visible box are included. If the browser lays out two visible
versions, both are retained rather than guessing which one a sighted user
meant. Native buttons and menu choices — including individual playback speeds
— remain controls, so Enter or `m` acts on the browser's own item. Enter on a
position or volume slider starts control mode; arrows, Home, End, Page Up and
Page Down are sent as trusted keys to the focused browser control, and Esc
returns to reading. This is tested by observing the media element's elapsed
time change in both engines.

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

### Browsers that outlive their session

A browser is a process group, not a process. Chromium is a main process, a
zygote, a GPU process and a renderer per site; and with no display neither
engine is even started directly — `xvfb-run` wraps it, starting an X server
and running the browser as its own foreground child. A shell waiting on a
foreground command does not pass a signal on to it, so signalling the process
we spawned used to kill the wrapper and leave the browser, its X server and
every renderer running with no parent. Every session that quit left about
thirteen processes behind. Browsers are now started detached, leading a group
of their own, and taken down as a group.

That covers every session that gets to finish. One that does not — `SIGKILL`,
or an out-of-memory kill — never runs its cleanup, so every browser tweb
starts is also recorded under `browsers/` in the state directory, and every
launch sweeps that list first. A browser is taken down when the session that
started it has gone, no other reader has claimed a tab in it, and it was not
left running on purpose; anything else is somebody's and is left alone. The
recorded process is only signalled while its command line still names the
profile it was started with, so a reused process id is forgotten rather than
killed.

This matters more than it sounds. One Chromium on an idle profile holds about
1.3GB, so on a machine without swap a few left behind is an out-of-memory
kill — which is how all of this came up.

```
npm run browsers            # what is running, its memory, and whose it is
npm run browsers -- --sweep # take down the ones nobody is using
npm run browsers -- --all   # take down every browser tweb started
```

### Throwaway profiles clean themselves

Every browser test file makes a profile of its own, and several make a state
or config directory too. They are removed when the run finishes — but the
system temporary directory here is a tmpfs, so a profile left by a run that
*did not* finish is not clutter on a disk, it is resident memory. Interrupted
runs had built up 3.4GB of them.

Nothing can be done from inside the process being killed, so each directory
carries the pid that made it in its own name and the next run sweeps the ones
whose owner has gone. The name is also what makes it safe: a directory tweb
did not create has no pid in its name and is never touched, which matters
because `--profile /tmp/something` of your own is a perfectly ordinary thing
to pass. The directory itself is handed back empty and stays that way.

Browsers are swept before directories, because a profile is not free while a
browser is still reading it. A browser found holding an abandoned profile is
taken down with it — that one is not reachable any other way, since a test
file that points `XDG_DATA_HOME` at a directory of its own records the browser
it starts in a registry that goes when that directory goes.

Measured: a run stopped with `SIGKILL` mid-flight strands 13 browser processes
and two profiles; the next run starts by clearing all of it.

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

None of that is free on Firefox, which serves exactly one WebDriver session
per browser and publishes no way to join the one it has — a second connection
is told "Session already started", a second session is refused as "Maximum
number of active sessions", and the session's own websocket path is
registered only for sessions made through the http flow a BiDi client does
not use. So a broker holds that single session and speaks BiDi to as many
readers as ask for one, rewriting command ids so replies find their way home
(`src/broker.js`). A reader runs the ordinary driver pointed at the broker and
nothing above the driver knows the difference; joining a browser this way
takes about 400ms against five seconds for a cold start.

The broker starts with the first reader, is recorded beside the browser in the
profile directory so later readers find the same one, and ends five seconds
after the last reader leaves. It reads as little as it can of what it carries:
a snapshot comes back as a 97KB accessibility tree, and parsing every message
to find its id costs about 7ms of a snapshot that takes 83ms, so it reads the
id out of the head of the frame and forwards the rest untouched, which costs
nothing measurable. `node tools/brokerbench.js` is that measurement.
`--connect` bypasses it: an endpoint you named yourself is connected to
directly.

One thing must be decided centrally rather than left to the readers. An
intercept belongs to the session and not to the connection, so a password
challenge raised anywhere in the browser could be told to all of them. It goes
to the reader who did something most recently — the one with their hands on
the keyboard — and if no reader is listening for it at all, the broker cancels
it, which loads the 401's own body rather than leaving a tab that never
finishes.

Whoever launched the browser is its first user, not its owner: quitting leaves
it running while another reader is still in it, and the last one out closes
it.

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

## What is on the screen

| Row        | What it holds                                                   |
| ---------- | --------------------------------------------------------------- |
| 1          | The page's title                                                 |
| 2          | The current view and the address — `[AX] https://example.com/`   |
| 3          | The hint line: the keys worth knowing, or what a prompt wants    |
| 4          | Blank                                                            |
| 5 … *n-2*  | The page                                                         |
| *n-1*      | Blank                                                            |
| *n*        | The status line                                                  |

The title is what the page calls itself, and is read when the buffer is
rebuilt rather than on every keystroke — the banner is meant to stay
untouched while reading, because a repainted row is re-read by a screen
reader whether or not it now says anything different. A page with no title
of its own leaves the row empty rather than repeating the address below it.

**The status line says where the link under the cursor goes.** Arrow onto a
link and its target appears there; step off it and the last message comes
back. This is exactly what a graphical browser does, and where it does it: the
address bar goes on saying where you *are* and the corner of the window says
where the thing under the pointer would *take* you. Two questions, two places,
and row 2 is not one of them — it is the tab's own address and nothing else.

The target is the resolved address rather than the attribute, so `href="../b"`
reads as somewhere the browser could actually be sent, and an element that
merely says `role="link"` has no target to show and changes nothing. A message
wins while it is news — anything that calls `setStatus` writes over the target
whatever the cursor is standing on — and the next move brings back whichever
of the two the new line calls for.

`u` switches the whole thing off, and `--no-link-address` or
`TAWB_LINK_ADDRESS=off` starts it that way. A graphical browser has no such
switch because its status bar costs nothing to ignore, but a row that is
*spoken* costs a sentence every time the cursor lands on a link, and on a page
that is mostly links that is a great deal of speech to sit through for
something the reader may not have wanted. Switched off, the row goes back to
holding the last message, which is what it held before any of this existed.
Like the search template it is a preference rather than something to retype
every launch, so it can be said once in the environment.

`U` shortens a link that stays on this site to its path alone, and starts that
way under `--short-links` or `TAWB_SHORT_LINKS=on`. The host is news only when
it changes: repeating `https://example.com` on every link of a page from
example.com is a sentence of nothing, spoken over and over, and a link into
this same page is shorter still — `#notes` rather than the path the reader is
already standing in. A link that *leaves* the site keeps its full address,
because leaving is the most important thing about it and the host is what
carries that news. It is off by default because a graphical browser's status
bar shows the whole address, and this row is meant to read like one. Anything
that will not parse as an address — `mailto:`, or a href the browser could not
resolve — is handed back untouched rather than guessed at.

It is the one thing outside the reading area that an arrow key touches, and it
costs nothing on the keystrokes that do not change it: the row is written only
when its text is actually different, and the cursor goes straight back to the
reader's own line, which is where a screen reader follows it. The find, sign-in
and path prompts are drawn on this row and own it while they are up. `SOURCE`
is left out of this deliberately — its lines *are* the markup, so the href is
already in the text under the cursor and saying it again below would say
nothing new.

## Four views of a page

Backslash (`\`) cycles between them. The current one is shown at the start
of the address line.

| View       | What it shows                                                        |
| ---------- | -------------------------------------------------------------------- |
| `[AX]`      | The accessibility tree — what a screen reader sees.                  |
| `[PAGE]`    | Visible text derived from the DOM, for when the AX tree is wrong.    |
| `[INSPECT]` | Each AX item beside the element or native control that produced it.  |
| `[SOURCE]`  | The live markup, tag by tag, including privileged shadow trees.      |

The views disagree more than you would hope. `INSPECT` makes that disagreement
concrete rather than asking the reader to align two unrelated lists. A native
scrubber may appear as `[Position: 0:12 / 3:04] <input type="range">`; where
Firefox cannot expose its browser-owned node safely, the same line carries an
honest synthetic `<native-control role="slider" name="Position">` instead.

`PAGE` names a control by whatever names it — its own text, its value, or
the label it carries — rather than by text alone. A play button is an icon
and an `aria-label` and nothing else, so a view that reads only text drops it
completely: every play button on that Bandcamp album was missing from `PAGE`
while the accessibility view listed all twelve. `role="button"` counts as a
button too, whatever tag it was built from, which is how most of them are
built.

`INSPECT` is accessibility-first: generated text with no backing element is
marked `<generated-accessibility-node>`, and items inside closed or user-agent
shadow roots say so on their line. `SOURCE` is markup-first:

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
it. `SOURCE` marks boundaries as `#open-shadow-root`, `#closed-shadow-root`
or `#user-agent-shadow-root`. Chromium supplies actual browser-owned markup;
Firefox supplies explicit `<native-control>` descriptors where its internal
nodes cannot safely cross the privilege boundary.

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
`<a aria-label=Play Weird Fish>` paired with its AX line in `INSPECT`, while
`SOURCE` shows `<a role="button" aria-label="Play Weird Fish">` and its
`<div class="playbutton">` child on separate lines.

Every view already knows which element each of its lines came from, because
that is how a line is activated. So switching asks the view you are leaving
which element you are on, and the view you are entering which of its lines
that element produced. Standing on the play button in any view and cycling
all the way round lands you back on the play button.

Two cases need more than that, and the status line says `nearest place`
rather than leaving you to work out why you are somewhere else:

- **Prose has no element of its own.** It is a text node, and the views
  number elements. The nearest element above you is the anchor, and your own
  line is then found again by its text, searched *down from where that
  element landed* — so repeated text does not throw you across the page.
- **The `AX` view keeps a reference to every element it read**, on both
  engines, because we compute that tree ourselves. So all four views match
  exactly: a line knows which node it came from, and moving between views is
  a question about elements rather than a search for text that looks
  similar.

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

## An address bar that is not an address bar

Every graphical browser's address bar takes an address when it is given one
and searches when it is not, and the second half is most of what it is used
for. This one used to do only the first half: anything without a scheme had
`https://` put in front of it, so three words became `https://three words` and
a name that does not resolve. That is not a degraded address bar, it is a
broken one.

`address.js` is the guess a browser makes, and it is made from the text alone
— no DNS lookup, nothing asked of the network first, because the reader is
waiting on the keystroke and a browser does not ask either:

| What was typed | Where it goes | Why |
| -------------- | ------------- | --- |
| `https://a.test/`, `about:blank`, `file:///tmp/x` | as typed | it already says |
| `wikipedia.org`, `example.com:8443/x` | `https://` | a dotted host, and this is the web now |
| `localhost:8080`, `127.0.0.1`, `printer.local`, `192.168.1.5` | `http://` | none of these normally has a certificate |
| `myhost:3000` | `http://` | a host and a port and no dot is a development server, not a scheme called `myhost` |
| `braille dots`, `braille` | the search engine | no host in it |

The dotless-host-and-port rule is the one that needs care: written as "a name,
a colon and digits" it also matches `example.com:8443`, which would send every
explicit port over plaintext. The dot is excluded from that pattern so a
dotted host falls through to the https rule instead.

A search says it was a search — *Searching for "braille dots"…* — since a
reader who mistyped a host name is otherwise handed a results page with no
account of how they got there.

**Which engine is a preference, not a discovery.** A browser asks its own
settings; neither CDP nor BiDi will tell us what the reader chose there, and
reading it out of the profile is the thing this project does not do. So it is
said on the command line — `--search`, or `TAWB_SEARCH` — with `%s` for where
the words go, and DuckDuckGo when nobody has said anything.

The command line is read the same way, so `tawb wikipedia.org` is an address.

`edb_server.js` had its own copy of these rules and now defers to this one.
What it does with the answer still differs, deliberately: the terminal
searches, and edbrowse offers a link to the search instead, because a page is
somewhere a reader can leave and come back to and a redirect they did not ask
for is one they cannot undo.

## Keys

The named terminal keys are not assumed to have one universal escape
sequence. At startup tweb asks the current terminal's terminfo entry through
`tput` for PageUp, PageDown, arrows, Alt+Left, Alt+Right, Home and End, and
keeps the common xterm-compatible sequences as fallbacks. `$TERM` therefore
needs to describe the terminal accurately; a missing `tput` or terminfo entry
does not prevent tweb from starting.

Press `Alt+?` to open the keyboard wizard while reading, or open it without
starting a browser:

```
npm start -- --keyboard
```

The wizard uses a temporary terminal screen, so leaving it restores exactly
what was underneath rather than dropping into an empty window. It lists every
browse-mode and editing action with its bindings. Move with the
arrow or page keys, press `Enter` to replace an action's binding, or `Alt+A`
to add another. The next complete keystroke is recorded. `Esc` cancels a
capture, and `Backspace` during replacement leaves the action unbound. A new
binding is removed from any other action on the same keyboard, so one key never
silently performs two actions in the same mode.

Browsing and editing are two keyboards on the same keys, and the wizard treats
the two keyboards separately. An action prefixed `edit-` is reachable only
while a field is being edited. Every other action is reachable only while a
page is being read. The four movements a field shares with a line — start of
line, end of line, previous character, next character — belong to both
keyboards. A key already held on the other keyboard is therefore not a clash:
the wizard binds it without a question, and the other action keeps it. `Ctrl+D`
files a bookmark while reading and deletes a character while typing, and
`Alt+D` downloads the link under the cursor while reading and deletes the next
word while typing, for exactly this reason.

While a binding or confirmation answer is being read, the terminal cursor moves
from the selected row to that prompt, marking where the next key will take
effect.

Choose `Exit keyboard wizard` at the bottom to leave. The wizard then accepts
only `y` or `n` at its save prompt and ignores every other key. Saved bindings
are written atomically to `$XDG_CONFIG_HOME/tawb/keys.json`, or
`~/.config/tawb/keys.json` when `XDG_CONFIG_HOME` is unset. Standard
keys such as `PageDown` are stored by name and resolved through terminfo on
each machine; an unusual sequence recorded by the wizard is retained exactly.

### Moving

| Key            | Action                                                       |
| -------------- | ------------------------------------------------------------ |
| `j` / `k`, `↓` / `↑` | Next / previous line (down at the end asks for more)   |
| `→` / `←`      | Next / previous character, carrying on to the next line       |
| `PgDn` / `PgUp`| Next / previous screen                                        |
| `g` / `G`      | Top / bottom of the page                                      |
| `Home` / `End` | Start / end of the current line                               |

### Jumping (the JAWS vocabulary; uppercase goes backwards except `L`, which toggles live updates)

| Key   | Jumps to                                                          |
| ----- | ----------------------------------------------------------------- |
| `h`   | Heading                                                           |
| `l`   | Link (JAWS uses `k`, which is taken by line movement here)         |
| `f`   | Form field                                                        |
| `b`   | Button                                                            |
| `n`   | Non-link text                                                     |
| `p`   | Paragraph                                                         |

`Tab` and `Shift+Tab` move between all three kinds of control at once — the
next link, button or form field, whichever comes first — which is what they do
in a graphical browser. The single-letter jumps stay, because knowing that the
next thing is a *button* is worth a key of its own; `Tab` is for when it does
not matter which it is.

`Tab` is the same byte as `Ctrl+I`, and is bound and displayed as `Tab`.
`Shift+Tab` has no single sequence every terminal agrees on, so terminfo's
back-tab (`kcbt`) is asked for first and `\e[Z` is the fallback.

### Everything else

| Key      | Action                                                          |
| -------- | --------------------------------------------------------------- |
| `Enter`  | Activate the link, button or field on this line                  |
| `/` / `?`| Find text forward / backward (empty repeats the last search)     |
| `Ctrl+G` | Find the same text again                                        |
| `m`      | Send a real click — trusted, carries user activation             |
| `Ctrl+L` | Address bar — an address, or words to search for (`Esc` cancels)  |
| `Alt+-` / `Alt++` | Back / forward in this tab's page history              |
| `Alt+?`  | Open the keyboard binding wizard                               |
| `\`      | Cycle view: AX → PAGE → INSPECT → SOURCE                         |
| `Ctrl+T` | Open and follow a new tab                                        |
| `Ctrl+O` | Bookmarks                                                        |
| `Ctrl+D` | Bookmark this page                                              |
| `Alt+H`  | History                                                          |
| `Alt+J`  | Downloads                                                        |
| `>` / `<`| Next / previous tab                                              |
| `Shift+F4`| Close this tab (never the last one)                              |
| `c` / `C`| Jump to the next / previous area that changed                    |
| `r`      | Rescan the current view without reloading the page                |
| `F5`     | Reload the page in the browser                                   |
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
[*Account, collapsed]   a control that opens something, closed
[*Account, expanded]    the same control, with its menu now on the page
```

A control only says `collapsed` or `expanded` if the page says so, through
`aria-expanded`. Most controls say nothing, and nothing is what they get: a
plain button is not a closed anything. The distinction is the difference
between "press this to see the menu" and "the menu is already here, further
down" — which, with no screen to glance at, is otherwise invisible.

AX and `INSPECT` know this. `PAGE` and `SOURCE` are DOM walks with no notion
of a control's accessibility state. It is also one of the two reasons
we compute that tree ourselves rather than asking Playwright for it:
`ariaSnapshot` marks a control that is open and has no way to say that one is
closed, so it can report `expanded` and never `collapsed`.

Separator punctuation (`|`, `,`) is folded onto the end of the preceding
link rather than taking a line of its own, since a lone `|` says nothing.

One item per line applies to items, not to words. A bold or italic word is
a node of its own in the accessibility tree, so `teenagers are just
<em>really</em> dumb` would otherwise become three lines — and a one-word
line reads as a heading or a link when you are arrowing through, a
structural break that is not in the page. Runs of prose are joined back
into one line; links are not, so their position stays predictable, and a
paragraph boundary still ends the line. `[INSPECT]` keeps AX's item boundaries
so each semantic line stays paired with its producer, and `[SOURCE]` shows the
emphasis itself.

A line longer than the terminal wraps, and each wrapped row is navigable in
its own right — so several rows in a row of plain prose are wrapping, while
a lone short word between full ones is not.

Text fields, the address bar and the find prompt accept the usual readline
editing keys: `Ctrl+A`/`Ctrl+E` for the ends, `Ctrl+B`/`Ctrl+F` by character,
`Alt+B`/`Alt+F` by word, `Ctrl+H` or Backspace and `Ctrl+D` or Delete,
`Ctrl+W`/`Alt+D` to delete a word, and `Ctrl+U`/`Ctrl+K` to delete to the start
or end. Arrow, Home and End keys continue to work as well. All of these
bindings appear in the keyboard wizard and can be replaced or extended there.

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

Page history remembers the line, column and scroll position where each entry
was left. Returning with Back or Forward resumes there instead of starting at
the top of the restored page.

A link with `target="_blank"` opens a tab and the browser moves to it. **So do
we** — the browser has already gone there and you should be where the browser
is. The status line says so: *"Followed a new tab — tab 3 of 3: Page B"*.

A tab that opens *behind* is announced and left alone, because nothing moves
you without saying so. `Ctrl+T` opens a new blank tab and follows it. `>` and
`<` step through everything open, wrapping at either end.

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
arrives as F14. With `--log`, any escape sequence nothing claims is written
to the diagnostic log with its bytes, so a terminal speaking a fifth dialect
can be added by reading the log.

## The browser's own lists

Bookmarks, history and downloads are not pages, and neither protocol will
answer for them. CDP and BiDi describe documents; a record of where you have
been is not a document. Nothing here reads the profile either — the files those
records are kept in are the browser's private business, and a reader that
parsed them would be reimplementing the browser's own schema, version by
version, for data the browser will hand over if you ask it properly.

So each engine is asked the way that engine can be asked, and the two answers
look nothing alike.

### Chromium: its own pages, over CDP

Chrome has a page for each of the three, and they are ordinary tabs that CDP
can attach to and run script in. A background tab is opened on the page that
owns the list, the page's own API is called, and the tab is closed again.

All three are calls into an interface the browser implements in C++ for its own
UI. The page is how we reach it, and the page's own module — importable, since
we are on that page — is where the binding to it is published:

| List | What is called |
| ---- | -------------- |
| bookmarks | `chrome.bookmarks.getTree()` — the real extension API, which that WebUI is granted |
| history   | `queryHistory(term, max)` on the handler from `BrowserProxyImpl`, exported by `chrome://history/history.js` |
| downloads | `getDownloads()` on the handler from `browserProxyFactory`, exported by `chrome://downloads/downloads.js` |

Two of the three answer the caller. Downloads does not: it answers *into* the
page, and only with what has changed since the handler last spoke — ask a
second time and the reply is an empty insert, because the page already has
them. So the call is made and the list is read off the element that has been
accumulating it since the page loaded, which by then is every download there
is. That is the one place here that touches a page's own field rather than an
interface.

Folder names arrive already in the browser's own words, because the browser is
the one saying them. There is nothing here to relabel.

The tab used for this is **internal**: created in the background so the browser
does not move to it, kept out of `pages()`, never announced as a new tab, and
closed as soon as the answer is in hand. Its target is marked before the tab is
waited for, which is soon enough — a tab is announced only once it has been
wired up, and wiring it costs several round trips after the response that names
it. So the reader is never told a tab opened, and never finds one in the list
that was not theirs.

### Firefox: a privileged agent, installed at startup

Firefox has no equivalent page. Places lives in the parent process behind APIs
only privileged code may call, and the Library is a chrome window rather than a
document, so there is nothing for content to be pointed at.

While we legitimately hold the WebDriver session in chrome context at startup,
an agent is installed in the parent process. It calls `PlacesUtils` and
`Downloads`, the APIs the Library and downloads panel are themselves built on,
and answers TAWB over an ephemeral loopback-only raw TCP socket. The endpoint
is recorded beside Firefox's BiDi endpoint.

The socket uses Firefox's own DevTools transport: decimal byte length, colon,
then JSON. This is also the security boundary. A webpage can issue HTTP and
open WebSockets to loopback, but cannot open raw TCP; both start with a `GET` or
`POST` request line that the packet reader rejects before dispatch. Local
programs acting as the user need no secret. Requests are limited to the four
known operations and their arguments are bounded.

The listener belongs to the parent process and is anchored there, so it
survives the Marionette installer, BiDi sessions, brokers, and a TAWB process
leaving a browser under `--keep-browser`. No function, token, or property is
installed in content windows. An arbitrary Firefox reached with `--connect`
still has no agent, because the one opportunity to install privileged code was
its TAWB startup; a Firefox TAWB kept retains both the agent and its recorded
endpoint.

Firefox stores its own five folders under internal names — `toolbar`,
`unfiled` — and shows them under translated ones, so those four are relabelled
on the way out. A tag is stored as a bookmark too, under the tags root,
pointing at the page it tags; that subtree is skipped, because listing it shows
every tagged page once per tag, filed under folders the reader never made.

### What both answers become

Entries of one shape — title, url, when, and whatever else that kind has —
which `library.js` orders and writes on a line. History and downloads are
newest first, which is the only order a record of what happened has; bookmarks
keep the order they are filed in, because a bookmark's place in its folder is
something the reader chose.

One thing there is policy rather than shape. **A long address wraps and buries
the list**: one entry of a real history — a tracking link carrying a base64
payload — filled twelve of a twenty-two row screen. An address over a hundred
characters is cut back to its host and path and marked with an ellipsis, and a
title that is itself an address gets the same treatment, because a page that
never titled itself is titled by its address. Enter still goes to the address
the browser gave us; only the line is short.

The list itself is a buffer like any other: the same lines, cursor, wrapping
and repainting, so a braille display tracks a bookmark exactly as it tracks a
paragraph. What it borrows is the dropdown's *mode* rather than the page's.
Typing filters instead of jumping, because a reader looking for a page they saw
yesterday knows a word of its title and not its position, and every
space-separated word has to appear somewhere in the entry — `wiki braille`
finds the article without knowing which order they come in. Live rebuilds are
held while a list is open, for the same reason the dropdown holds them: a
refresh would replace the block list, and the block list is not the page's. The
core is not told where the reader is standing either, since block twelve of a
list of bookmarks is not block twelve of the tab, and a text patch aimed there
would land where they are not. Escape puts the reader back on the line, column
and screen they left, because closing a list is not a navigation and must not
read as one.

### Filing one

Reading those lists and writing to them are the same road travelled twice.
`chrome.bookmarks.create` on a background `chrome://bookmarks` tab;
`PlacesUtils.bookmarks.insert` in the privileged agent, which now answers a
fourth question. Nothing goes near the file either browser keeps them in, for
the reason nothing else here does: that schema is the browser's business, and a
bookmark the browser does not know about is a note in a second program rather
than a bookmark.

Three things about it are policy rather than mechanism.

**The reader names it before it is filed, not after.** A graphical browser
saves on Ctrl+D and puts an editable bubble in front of you afterwards; Escape
there dismisses the bubble and keeps the bookmark. Here the name is asked for
first, with the page's title already in the buffer, so Enter is the same one
keystroke — and Escape files nothing, because Escape has meant "leave this
alone" on every other prompt in this program, including the browser's own
dialogs, and a reader who cannot reopen a bubble to undo it needs the key that
backs out to actually back out. A page that never titled itself is offered its
address, since a bookmark with no name is one nobody finds again.

**A page already filed is reported, not filed again.** Both browsers open an
editor rather than making a duplicate, so the reader is told the name it is
already under — which is usually the point, since a title they chose months ago
is not the one the page has now. On Chromium the whole tree is already in hand
from the folder lookup, so the question costs nothing; on Firefox it is
`PlacesUtils.bookmarks.fetch({ url })`.

**It says which folder.** New ones go where the browser's own star puts them —
"Other bookmarks", `unfiledGuid` on Firefox and the id `2` that has meant the
same thing in Chrome since before there was an extension API. An id is not a
promise, so it is looked for and the last top-level folder taken when it is
absent. Naming the folder back is the part a sighted user gets by glancing at
the sidebar.

One trap, met on the way: the Chromium half runs in the WebUI page, sent as its
own source, so a constant declared beside it in `library_chromium.js` is a name
the page has never heard of. The ReferenceError lands inside a `getTree`
callback where it settles no promise, and the caller waits out a thirty-second
protocol timeout instead of being told what happened. `readDownloads` already
declares its state table inside itself for the same reason.

### Ctrl+D belonged to something already

Browsers file a bookmark with Ctrl+D and readline deletes the character under
the cursor with it, and both are right. `keys.js` built one map from sequence
to action, so the two could not both have the key: whichever was listed second
would take it, silently, which is the thing that file exists to prevent — and
what it would have taken is `edit-delete`, a binding this program documents.

So `rebuild()` now builds a second map over the actions that mean something
inside a field, and `editAction` asks that one. The set is the `edit-` prefixed
actions plus the four browse movements editing shares on purpose — Home, End
and the two arrows do the same thing in a field as on a line, and rebinding
them once should still move both. Everything else is unchanged: the wizard
still assigns against the flat map, so taking Ctrl+D for a third action still
takes it from both.

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
track was to use the old tag-summary view and activate the bare `<div>` there.

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

Both engines then perform the pointer actions themselves, over the same road
their keyboards take. Chromium asks the protocol where the element's box is
and dispatches a move, a press and a release there; Firefox names the target
by shared reference and lets the browser work the centre out. Either way the
events are the browser's own, so they are trusted and carry activation.

## Signing in

A site that answers 401 with a `WWW-Authenticate` header is not sending a
page. It is asking the browser to put up a dialog — drawn by browser chrome,
outside the document, and so outside everything a reader of the accessibility
tree can see. Before this existed, such an address simply never arrived.

Both engines let a client take that dialog over, and both are answered the
same way: with a username and a password, never with an `Authorization`
header. That distinction is the whole design. Basic would be a base64 of the
pair, but digest is a nonce, a client nonce, a request counter and two rounds
of hashing per request, with a stale nonce starting it again — RFC 7616 in
full. Handing the pair to the network stack means the engine performs the
scheme, so digest costs nothing here, and NTLM and Negotiate work wherever the
platform can do them at all.

The prompt is on the status line: who is asking on the hint line above it,
then a username, then a password, which is not echoed — a terminal keeps
scrollback. `Esc` cancels, and cancelling is not failing: the 401's own body
then loads, which is frequently a page saying what the realm is and how to get
an account.

Who is asking is the origin that raised the challenge, never the page being
read. A challenge can come from an image or a frame belonging to somewhere
else entirely, and being told to sign in to the site you can see while the
password goes elsewhere is the shape of every credential trick there is.

What you type answers this session and goes no further; nothing is written to
disk. A realm is remembered once, so a page with thirty protected images asks
once rather than thirty times. `https://user:password@host` typed into the
address bar is taken apart and used to answer the challenge instead of being
passed on — Chrome strips that form from subresources and Firefox interrupts
it with a confirmation of its own — which also keeps the password out of the
address the session then goes on holding.

Wrong passwords are counted here, because nothing stops the browser retrying
on its own: given one the server refuses, Chromium goes round about thirty
times before `ERR_TOO_MANY_RETRIES` and Firefox goes round for ever. Three
tries, and the challenge is cancelled.

Whatever is still unanswered when the session ends is cancelled on the way
out. The prompt belongs to us from the moment the interception is armed — the
browser stops drawing its own dialog and holds the request instead — so a
challenge left paused in a browser that outlives the reader is a tab loading
for ever with no dialog anybody could answer. It also costs the reader their
terminal back: detaching from a connection with requests paused on it is
itself a wait, measured at over twenty seconds. The same is true of a prompt
whose keyboard disappears, which declines for the same reason.

The engines pay very different prices for this. Firefox's intercept is
auth-only: no ordinary request is paused, so a page that is not asking for a
password pays nothing. Chromium has no such mode — asking for the events
pauses every matching request, and a pattern list that matches nothing gets
neither the events nor the dialog, only a load that fails with
`ERR_INVALID_AUTH_CREDENTIALS`. So everything is intercepted and continued
immediately, measured at 300ms against 250ms over a page of 101 requests. It
is armed per tab, as tabs are taken, because a browser can be shared with
another reader and their passwords are not ours to ask for.

## Reading the browser's own windows

Not everything a browser puts in front of a person is a page. Chrome's "Add
extension?" confirmation is a native dialog: no document, no frame, no target.
Nothing in CDP describes it — `Target.getTargets({filter:[{}]})` with every
type rather than the default subset, plus live `Target.targetCreated` across a
whole install, shows nothing appearing. That is not a rule about browser UI:
the omnibox popup turns up as `browser_ui:chrome://omnibox-popup.top-chrome/`.
That particular dialog is simply not WebUI.

It is, though, a dialog the browser already describes to assistive technology,
because a blind person pressing "Add to Chrome" has to be able to answer it
too. On Linux that description is AT-SPI, which is plain D-Bus method calls —
`GetChildren`, the `Name` property, `GetRoleName`, and `DoAction` to press
something. `src/dbus.js` is the client, hand-written like the other two
protocols here; `src/atspi.js` is what is asked of it.

Two things have to be true, and both are checked rather than assumed:

- **The browser must have been started with platform accessibility on.**
  `--force-renderer-accessibility` does it, and `basic` — the cheapest of its
  three values — is enough. Without it AT-SPI shows the application and the
  window frame and nothing inside either, because
  `AXPlatformNodeAuraLinux::CreateAtkObject()` refuses to build a node for
  anything that is not a top-level window unless `AXMode::kNativeAPIs` is set.
  Nothing else turns it on. Not the `ACCESSIBILITY_ENABLED` environment
  variable that `AtkUtilAuraLinux::ShouldEnableAccessibility()` reads; not
  setting `ScreenReaderEnabled` on `org.a11y.Status`; not registering as an
  AT-SPI event listener the way a screen reader does; not CDP's own
  `Accessibility.enable`, which is about a renderer and not about the browser.
  Chrome's remaining path is `DiscoverOrca()`, which scans `/proc` for an Orca
  process — not something to imitate.
- **There must be an accessibility bus.** A desktop has one, run by
  at-spi2-core, and it is used exactly as it is. A bare terminal — which is
  where this program is most at home, with the browser under Xvfb — has
  neither it nor the session bus it would live on, so one is provided:
  `org.a11y.Bus` is claimed *only if nobody owns it*, and what it hands out is
  the session bus itself, since an accessibility bus is an ordinary bus and
  the separate one a desktop runs is for isolation rather than for a different
  protocol. With no session bus at all, `dbus-daemon` is started for the
  browser and taken down with it. The name is released when the session ends.
  Verified against a browser with at-spi2-core's daemons not running at all,
  which registered with ours and described its windows through it.

  at-spi2-registryd is not needed either way: applications are found by asking
  the bus what is connected to it and asking each of those for its own tree,
  and identified by pid rather than by the registry's desktop listing.

The application is identified by its process, not by its name: the bus knows
the pid behind every connection, and a browser we started leads a process
group of its own, so `GetConnectionUnixProcessID` and that group name it
exactly. A desktop with three browsers open is the ordinary case, and reading
somebody else's dialog would be worse than reading none. A browser reached
with `--connect` has no pid of ours to match, so there the application name is
all there is to go on.

A dialog is a top-level of the application, beside the window rather than
inside it, which is why finding one is a single `GetChildren` and not a search.
Reading one drops the empty panels a views dialog nests — four of them, each
answering with the name of what it wraps — so what comes back is the few lines
the dialog actually says and the buttons it offers.

### Where each engine puts one

Chromium hangs its confirmation off the application, beside the window rather
than inside it. Firefox hangs its install doorhanger off the browser window.
So both places are watched — the application's children, and each window's —
which is one level of looking rather than a search of a tree with a whole
browser's chrome in it.

The two engines also differ on how accessibility gets turned on. Chromium
needs the startup flag and will describe nothing without it. Firefox turns it
on by itself as soon as a bus says it is wanted, so nothing is passed to it at
all — and that means Firefox's dialogs can be answered even in a browser
reached with `--connect`, which Chromium's cannot.

A dialog is more than lines and buttons where the engine offers more. Firefox's
doorhanger carries "Allow extension to run in private windows"; that arrives as
a check box, is shown as `[ ]` or `[x]`, and Enter on it ticks it and leaves the
question up, because it is part of the question rather than an answer to it.
Its state is read back from the browser afterwards rather than assumed.

### Answering one

A dialog is offered to the reader as a buffer of its own, the way the
browser's lists are: the lines it says, then the buttons it offers as lines to
move to and press. Enter presses the one under the cursor. That shape is
deliberate — a permission list is the reason the question is being asked, and
a yes/no on the status line would put the answer in front of the reader before
the question had been read.

Escape presses nothing at all. It used to press whichever button the dialog
had focused, on the grounds that this was the browser's own safe answer — and
on Chrome's extension prompt it is, since that focuses Cancel. Then the
save-password prompt arrived, which focuses **Save**: escaping would have
saved a password the reader was trying to walk away from. A key that means
"leave this alone" has to leave it alone, so the question stays open and
`Alt+Q` goes back to it, re-read rather than replayed in case the browser has
changed what it says.

Which button a dialog has focused is still worth knowing, and it is still
read — it is why driving these dialogs with synthetic keystrokes is a bad
idea. Pressing Return at Chrome's install prompt with xdotool dismisses it and
installs nothing, which from the outside looks exactly like an install that
silently failed.

A dialog is read for what it is *about*, not only for what it says. Chrome's
"Save password?" holds the credential in two entries, so a reading that took
only names said "Username" twice and never said whose password was being
saved. Controls that hold a value are read through the Text interface, which
is also how the password arrives already masked — the browser masks it, and
what the reader hears is what is on the screen:

```
Save password?
Passwords are saved to Password Manager on this device.
Username: reader
Password: ••••••••••••••
Never
No thanks
Save
```

A press is checked rather than trusted. The accessibility action answers "yes,
pressed" whether or not anything happened, so after pressing, the dialog is
looked for again: if it is still there, the reader is told the press did not
take rather than told their answer went in. That is not hypothetical.
Chromium discards input arriving within about half a second of a dialog
appearing — its protection against clickjacking — and discards it silently,
which is exactly what a test pressing the instant it hears will see, and what
a reader reading the question never will.

What else arrives this way, on Chromium: a site's permission request, with
all four of the browser's own answers ("Allow while visiting the site",
"Allow this time", "Never allow", "Close"), and a page's own `alert` box,
which is a modal that stops the page's script until somebody answers it —
before this, a page that had quietly stopped for no reason a reader could
discover. Firefox's page dialogs do not appear, because the WebDriver session
attached to it dismisses them before anything else sees them; its install
doorhanger is not dismissed that way, which is the one this feature is for.

One question at a time. The watch does not go looking for another while a
reader is answering one, a dialog is offered once rather than once per poll,
and one that goes away by itself — dismissed in the browser, or answered by
somebody else — is forgotten rather than pressed.

Finding one is a poll rather than an event: `GetChildren` on the application
every half second, which is a single round trip on a unix socket, and nothing
else is asked unless the answer changed. AT-SPI's event signals would be
cheaper still, but applications emit them only when the registry says
something is listening, and not depending on the registry daemon is worth more
than the round trip.

### Adding an extension, end to end

The reader goes to the Chrome Web Store and presses "Add to Chrome" — an
ordinary page button, activated the way any other is. The store calls
`chrome.webstorePrivate.beginInstallWithManifest3`, Chrome raises its consent
dialog, and that dialog arrives on the terminal with its own heading and its
own permission list. Enter on "Add extension" presses Chrome's button; Chrome
downloads the signed CRX and installs it.

What that gets, and what the shortcuts do not: this is a real Web Store
install. It survives a restart, `from_webstore` is true in the profile, and it
updates like any other extension. `Extensions.loadUnpacked` over CDP works
and raises no prompt at all, but it takes a directory, it is gone at the next
launch, and it never asks the reader anything — which is the whole objection
to it. The consent is not an obstacle in front of the feature, it *is* the
feature.

Firefox reaches the same place by its own road. The reader presses "Add to
Firefox" on addons.mozilla.org, the page calls
`navigator.mozAddonManager.createInstall(...).install()`, and Firefox raises
the panel it would raise for anybody — permissions, data collection, the
private-windows option, Cancel and Add. Answering it installs the signed
`.xpi` into the profile. Note what is *not* used: `AddonManager
.installTemporaryAddon()` works from the privileged agent already installed at
startup and raises no prompt at all, and it is the wrong answer for the same
reason `Extensions.loadUnpacked` is — a temporary add-on is gone at the next
launch, and nobody was asked.

There is no way to make Chrome answer that dialog by itself, and this was
checked before the accessibility route was built. The auto-confirm is
`extensions::ScopedTestDialogAutoConfirm`, a process-global set by a C++
scoped object in `extension_dialog_auto_confirm.cc`; it reads no switch, no
environment variable, no preference and no policy, and the webstore path
guards each branch of it with `CHECK_IS_TEST()`, so a release browser would
abort rather than honour it. Chrome's own tests link the browser into the test
binary and flip that global — there is no external client, and ChromeDriver
never presses the button either. `ExtensionInstallForcelist` installs without
any prompt at all, from a policy file under `/etc/chromium/policies/managed`
that needs root, which is not answering the question, it is deleting it.

## Passwords the browser remembers

The browser's own password manager is the one worth using: it is where the
reader's passwords already are, it is encrypted with the profile, and nothing
here ever holds a password of theirs. Three things had to be dealt with.

**Firefox has it turned off.** The remote agent's recommended preferences set
`signon.autofillForms` and `signon.rememberSignons` to false — "so that tests
that include forms are not influenced by the presence of the persistent
doorhanger notification", which is right for a test suite and wrong for a
person: the browser never offers to remember a password and never fills one
in, with nothing on screen to explain why. Setting them in `user.js` is
enough, because the agent applies its preferences only where the user has
none (`if (!Services.prefs.prefHasUserValue(k))`, in
remote/shared/RecommendedPreferences.sys.mjs). These are Firefox's own
defaults, not new behaviour. Autofill over plain http stays off, as it is in
an ordinary Firefox.

**A filled field reads as empty.** Both engines fill a saved sign-in visually
and keep the value from page script until a person interacts with the page —
which is what stops a hostile page reading a credential the reader never meant
to give it. So the DOM says the field is empty, and a reader would type a
password they did not need to type. `:autofill` is what a page is allowed to
know, and both engines answer it, so a field the browser filled reads as
`[Password: filled by the browser]`.

**And a filled form will not send itself.** The same protection applies to
submission: a form sent by `element.click()` — no mouse, no key, no user
activation — arrives at the server with those fields empty, and neither the
page nor the reader is told. Measured directly: fields reporting `:autofill`,
and `username=&password=` at the other end. So a button that would send a form
holding an autofilled field is pressed the way a person presses it, at real
coordinates, and the credentials arrive. Where that press cannot be placed —
covered, or off a screen it cannot be brought onto — the default action is
used anyway and the reader is told the password may not have gone with it,
which beats an unexplained refusal.

Which sign-ins Chrome actually fills is Chrome's own business: its classifier
reads the form and the words around it, and it will decline to fill a form it
has decided is a sign-up. tawb reports what the browser did rather than
second-guessing it.

The prompts themselves need nothing of their own. "Save password?" is a native
dialog like any other, so it arrives through the machinery above with its
buttons and — since it holds the credential in two entries — the username and
the masked password it is about to keep.

## Attaching a file

A file input is the one control that cannot be pressed. Pressing one asks the
desktop for a chooser, and that chooser is not the browser's own window: it is
the XDG portal's, in another process, so it is not even in the accessibility
tree the browser publishes — the machinery above cannot see it. Worse, on a
machine with no portal, which is a terminal with the browser under Xvfb,
nothing appears at all. Chromium's log says so plainly: `components/dbus/xdg/
request.cc — Request ended`. Before this, pressing a file input in tawb
reported "no visible change", which was exactly true and completely useless.

Both engines hand the chooser over instead, and that is the whole design:

| | Chromium | Firefox |
| --- | --- | --- |
| hand the chooser over | `Page.setInterceptFileChooserDialog`, then `Page.fileChooserOpened {mode, backendNodeId}` | `input.fileDialogOpened {element, multiple}` — the dialog is suppressed by the WebDriver session anyway |
| give an input its files | `DOM.setFileInputFiles` | `input.setFiles` |
| cancel | `DOM.setFileInputFiles` with none | `input.setFiles` with none |

Nothing is ever drawn, which is what makes this safe: a reader who escapes the
prompt leaves no window anywhere, and the page simply gets no files, which is
what cancelling a chooser has always meant.

**Cancelling is not the same as walking away, and the difference is Firefox's.**
Chromium tolerates a chooser that is never answered — the page goes on, and the
next chooser still arrives. Firefox holds the dialog it did not draw until the
session answers and raises no other meanwhile, so a reader who escaped would
find that uploading had quietly stopped working in that tab. So both are
answered explicitly, with an empty list, and the empty answer fires no `change`
on the page. There is a second Firefox quirk behind it: asked again within
about a second of a cancelled dialog it raises nothing at all, though the
page's own click handler runs. That is the same class of machine-speed artefact
as Chromium discarding a press that lands too soon after a dialog appears, and
a reader typing a path is never near it.

Armed per tab, as tabs are taken, for the reason the password prompt is: a
chooser raised in a tab another reader is reading is not ours to answer — and
an intercepted chooser we do not answer is one the browser has stopped drawing
for them.

### The prompt

What the reader gets is a path, on the status line, with Tab completion — and
a terminal is better at that than any file dialog: this is a person who knows
their own filesystem and has a keyboard. Completion goes as far as the
candidates agree and no further, a directory completes with its separator so
the next Tab carries on inside it, and an ambiguous prefix lists what it
matched rather than choosing. `~` is expanded, and a relative path is relative
to where tawb was started, which is where the reader was standing when they
typed the command.

A path that will not work is refused here rather than passed on, because the
engines are no help about it: Chromium accepts a path that does not exist
without complaint and the page ends up with a file that is not there. So it
must exist, not be a directory, and be readable.

An input marked `multiple` asks until an empty line, and says how many it has
so far. What the reader is told afterwards is the file's name and size, since
"attached" on its own does not say whether the right thing was attached.

Two routes end at the same prompt. The ordinary one needs no chooser at all:
the reader pressed Enter on the input, so the element is already in hand and
the files go straight to it. The handover is for the case with no control to
press — the "Upload" button that clicks a hidden input, which is most of the
upload widgets on the web. Note that tawb's own activation (`element.click()`,
the element's default action) opens no chooser on either engine, because it
carries no user activation; the handover fires for the real click behind `m`.

## When a site's certificate is refused

A bad certificate — self-signed, expired, issued for another name — is not a
page that fails to arrive. Both engines answer it by rendering a warning of
their own, and that warning is the whole of what a sighted person gets,
including the way past it. So it is read like any other page:

```
Privacy error
[AX] chrome-error://chromewebdata/

# Your connection is not private
Attackers might be trying to steal your information from 127.0.0.1 ...
{Learn more about this warning}
[*net::ERR_CERT_AUTHORITY_INVALID, collapsed]
[*Back to safety]
[*Advanced, collapsed]

https://127.0.0.1:8443/ was refused — ERR_CERT_AUTHORITY_INVALID. ...
```

`Tab` to `[*Advanced]` and press `Enter`: it expands to the explanation and a
`{Proceed to … (unsafe)}` link, and activating that loads the site. Firefox
words it differently — *"Be careful. Something doesn't look right"*, then
`[*Proceed to … (Risky)]` — and behaves the same. Nothing here bypasses
anything on the reader's behalf; the browser's own controls do it, because
they are ordinary page controls.

The status line names the engine's own code for the fault —
`ERR_CERT_AUTHORITY_INVALID`, `MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT` — since
the page itself does not always spell out which of the several possible
problems it hit.

Firefox's page also carries `{View the site's certificate}`. Open it with `m`,
the real click, rather than `Enter`: it opens Firefox's own certificate viewer
in a new tab, and Firefox honours that only for a click carrying user
activation — `Enter` reports *"no visible change"* and nothing opens. The
viewer is then read like any other page, and says everything a graphical
browser shows:

```
Followed a new tab — tab 3 of 3: Certificate for localhost

## Validity
Not Before Tue, 25 Aug 2026 07:36:02 GMT Not After Wed, 25 Aug 2027 ...
## Subject Alt Names
DNS Name localhost IP Address 127.0.0.1
## Public Key Info
Algorithm RSA Key Size 2048 Exponent 65537 Modulus ...
```

Chromium's warning has no equivalent. There a certificate is inspected through
the padlock in browser chrome, which is not part of the page and is not
reachable from here — so on Chromium the warning's own explanation of what is
wrong with the certificate is as far as it goes.

An accepted certificate is remembered by the browser profile, so a site let
through once loads directly next time rather than asking again.

This applies to every navigation that the engine refuses outright, not only
to certificates: a refused connection and a name that does not resolve land
on the same kind of page. Before this, such a navigation threw — it killed
the session outright when it was the address tweb started with, and from the
address bar it left the reader on the previous page with a fragment of a
stack trace on the status line and no way to go on.

## If an action cannot complete

Activation is bounded at six seconds. Some controls genuinely cannot be
reached — a bot-check widget inside a cross-origin frame, for instance —
and rather than freeze, it gives up and tells you. Cloudflare's
"Performing security verification" pages are the common case; there is no
way in from here, so use the address bar to go somewhere else.

## Timing log

Logging is off by default. Add `--log` when a run needs diagnosing:

```
npm start -- --log https://example.com
npm run edb -- --log
```

The log is written in the user's home directory as
`~/.tawb.YYYYMMDDhhmmss.<pid>.log`. The timestamp and process id give every
session its own file, so simultaneous readers never overwrite one another.
It contains one JSON record per line, timestamped from process start:

```json
{"t":1209,"event":"snapshot","source":"ax","ms":396,"blocks":346,"frames":3}
{"t":17950,"event":"live.refresh","source":"ax","totalMs":152,"snapshotMs":151,
 "reanchorMs":1,"drawMs":0,"repainted":18,"remapExact":true,"cursor":15}
```

It records startup phases, every page snapshot with its cost, live refresh
broken down by stage, text splices that avoided a snapshot (`live.patch`),
keypresses that took longer than 20ms, saved and restored page-history
positions, and any frame slower than 100ms with the URL responsible. It is
the fastest way to find
out why something felt slow — ad-heavy pages spawning hundreds of tracking
iframes have been the usual culprit.

## Tests

```
npm test                              # about two seconds, no browser
npm run test:browser                  # a real browser and a real page (two at a time)
xvfb-run -a npm run test:browser      # with no display of your own
TWEB_TEST_BROWSER=firefox npm run test:browser
```

The fast suite is everything that can be decided without a browser, which is
more than it sounds: what html the edbrowse server produces from a page's
tokens, what its urls promise, and the rules the core keeps about a reader's
place and about what is worth telling them.

Those last ones are the reason there is a suite at all. A dozen of them encode
decisions that took real pages to discover — the near one of two identical
lines wins, a place that has changed four times in ten seconds is a clock and
not news, a text patch may not touch the block the reader is standing on —
and every one of them looks like an arbitrary choice until the page that
forced it turns up again. They are exactly the rules a later change undoes by
accident.

The routing tests carry something else worth having: the stub page in them is
the complete list of what the edbrowse server asks of a browser, written as
something that has to keep working. It answers each extractor by name and
throws on any it does not know, so a new call into the page cannot be added
without the contract being updated to say so.

`tools/authserve.js` is the other server the browser suite uses: it asks for
a password, in basic and in digest, and verifies the digest response
properly — nonce, client nonce, request counter and all — so an answer the
engine computed wrongly is refused exactly as a real server refuses it. It
also serves a public page whose image is protected, which is how a challenge
arrives for an origin that is not the one being read.

`test/browser/library.test.js` is there for the same reason: what the reader's
bookmarks, history and downloads amount to is entirely the browser answering,
and there is nothing to stub that would prove anything. It starts a browser on
a fresh profile, visits a page, fetches a file, and asks whether the browser
hands them back.

The browser suite reads `tools/testpage.html` through the whole stack, and
checks the things that only a real browser can answer: that a sixty-entry
select arrives with sixty entries, that the collision pair is intact, that a
field with no form around it is still submittable, and that following a
control answers a redirect rather than a page.

## Serving the browser to edbrowse

edbrowse renders html, tables, lists and forms better than a line list does,
and it is an editor as well as a browser. What it cannot do is run a page.
So `npm run edb` starts the same browser — ordinary, attached to, never
automation-launched — and serves its tabs to edbrowse as html over loopback
http:

```
npm run edb                       # or: npm run edb -- --browser firefox
```

It prints a tab list address and writes `~/.local/share/tawb/edb.json`
so the entry-point plugin can find it. **The edbrowse side of this — the
plugin, the `.ebrc` shortcuts, two patches to edbrowse itself, and the
long-form study `edb.txt` — is its own repository, at
[`../edbrowse-plugin`](../edbrowse-plugin).** Install from there; what
follows is what this half provides.

Every page served begins with an address field, so `i=timeanddate.com` then
`i*` on line 1 goes there from anywhere in the buffer, with nothing to
remember and no scheme to type: a host with a dot gets https, localhost gets
http, and something with no host in it gets an offer to search rather than
being quietly sent to a search engine.

The line below it says which site you are really on and links to the other
four representations (`ax`, `text`, `inspect`, `source` — the reader's own
line lists) and to the tab list. `Shift+F4` has no meaning here; the tab list has a close link per
tab.

Everything that acts on a page answers a redirect back to the tab's own
address, and every response says no-cache, so `rf` is a refresh rather than a
repeat of the click that got you there. Element ids name descriptors — a path
through the document, the tag, the accessible name, the position in document
order — resolved in the page, so a link in a buffer from ten minutes ago
still means what it said.

The browser is yours to close, and closing it does not end the session: the
next page asked for starts another one the same way, and the tab you were
reading is offered back by name on the page that says what happened.

What does not survive the trip: live updating and immediate announcements.
edbrowse has no way to be told anything by an idle buffer, so `rf` is the
whole story.

## If this is ever rewritten or embedded elsewhere

[`PORTING.md`](PORTING.md) is the seam: which ~970 lines must stay JavaScript
because they run inside the page, what the two protocol clients amount to
call by call, which parts are policy that took real pages to discover and
should be copied rather than re-derived, and what changes if this becomes a
backend something else drives instead of a program that owns a terminal.

## Known rough edges

- Snapshots can spike to a couple of seconds in the first moments after an
  ad-heavy page loads, then settle to roughly 150ms. Input takes priority
  over refreshes, so it should not block you.
- A change that adds or removes anything still costs a whole-page snapshot,
  so a page that appends to a list every second stays as expensive as it
  ever was. Only replaced text takes the cheap path.
- A password challenge raised inside a cross-origin iframe on Chromium is
  not answered here: site isolation makes that frame its own target, and the
  interception is on the tab's. It behaves as it did before any of this
  existed — a dialog nobody can see. The same goes for a challenge in a tab
  this session has not taken.
- Some sites gate particular endpoints behind bot checks. These now pass,
  because the browser is a real one, but a challenge that demands
  interaction may still need a sighted pass in the same profile — the
  clearance cookie is then reused.
