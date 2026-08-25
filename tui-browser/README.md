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

A native `<video controls>` or `<audio controls>` also exposes the controls the
browser actually laid out beneath the player's status line in AX view: Play,
Mute, the position and volume sliders, fullscreen, and whichever overflow
controls fit. Chromium supplies them from its user-agent shadow roots over
CDP. Firefox's privileged shadow-root helper describes the same controls,
since page script is forbidden from reading those roots directly. Only
controls with a visible box are included. If the browser lays out two visible
versions, both are retained rather than guessing which one a sighted user
meant. Native buttons and menu choices — including individual playback speeds
— remain controls, so Enter or `m` acts on the browser's own item.

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
binding is removed from any other browse action that used it, so one key never
silently performs two actions. While a binding or confirmation answer is being
read, the terminal cursor moves from the selected row to that prompt, marking
where the next key will take effect.

Choose `Exit keyboard wizard` at the bottom to leave. The wizard then accepts
only `y` or `n` at its save prompt and ignores every other key. Saved bindings
are written atomically to `$XDG_CONFIG_HOME/tui-browser/keys.json`, or
`~/.config/tui-browser/keys.json` when `XDG_CONFIG_HOME` is unset. Standard
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
| `Ctrl+L` | Address bar (scrolls sideways for long URLs; `Esc` cancels)      |
| `Alt+-` / `Alt++` | Back / forward in this tab's page history              |
| `Alt+?`  | Open the keyboard binding wizard                               |
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
[*Account, collapsed]   a control that opens something, closed
[*Account, expanded]    the same control, with its menu now on the page
```

A control only says `collapsed` or `expanded` if the page says so, through
`aria-expanded`. Most controls say nothing, and nothing is what they get: a
plain button is not a closed anything. The distinction is the difference
between "press this to see the menu" and "the menu is already here, further
down" — which, with no screen to glance at, is otherwise invisible.

Only the accessibility view knows this. `PAGE`, `HTML` and `SOURCE` are DOM
walks with no notion of a control's state, and Playwright's own accessibility
snapshot marks a control that is open but says nothing about one that is
closed, so a Chromium session still on that snapshot reports `expanded` and
never `collapsed`.

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

Firefox's page also carries `{View the site's certificate}`, which is its own
certificate viewer and is read like any other page. Chromium's warning has no
equivalent: there, a certificate is inspected through the padlock in browser
chrome, which is not part of the page and is not reachable from here.

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

It prints a tab list address and writes `~/.local/share/tui-browser/edb.json`
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
three views (`ax`, `text`, `source` — the reader's own line lists) and to the
tab list. `Shift+F4` has no meaning here; the tab list has a close link per
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
- A password challenge raised inside a cross-origin iframe on Chromium is
  not answered here: site isolation makes that frame its own target, and the
  interception is on the tab's. It behaves as it did before any of this
  existed — a dialog nobody can see. The same goes for a challenge in a tab
  this session has not taken.
- Some sites gate particular endpoints behind bot checks. These now pass,
  because the browser is a real one, but a challenge that demands
  interaction may still need a sighted pass in the same profile — the
  clearance cookie is then reused.
