# tui-browser

A terminal browser for reading the web from the command line, built for a
blind user. It drives an ordinary Chrome or Chromium and
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

This starts an ordinary Chrome or Chromium and watches it. It does not let
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

Your profile persists between runs, so logins and cookies survive:

```
npm start -- --profile ~/.local/share/tui-browser/profile https://example.com
npm start -- --connect 9222 https://example.com   # attach to a browser you started
```

To use a browser you are already running, start it with
`--remote-debugging-port=9222` and pass `--connect 9222`.

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

## Three views of a page

Backslash (`\`) cycles between them. The current one is shown at the start
of the address line.

| View     | What it shows                                                        |
| -------- | -------------------------------------------------------------------- |
| `[AX]`   | The accessibility tree — what a screen reader sees.                   |
| `[PAGE]` | Visible text derived from the DOM, for when the AX tree is wrong.     |
| `[HTML]` | Tags and attributes, including URLs the other two views never expose. |

The views disagree more than you would hope, and AX is the lossy one. A
`<video>` with a perfectly playable source often reports only its fallback
text — "Your browser does not support videos." — because that text is the
element's content; the actual media URL appears nowhere in the AX tree.
`HTML` view shows the URL. That is what the third view is for.

Switching views keeps your place: position is matched by content, since the
three views have completely different line counts.

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
| `Ctrl+L` | Address bar (scrolls sideways for long URLs; `Esc` cancels)      |
| `\`      | Cycle view: AX → PAGE → HTML                                     |
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
purpose, being the view for seeing what is actually there.

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

## When something changes elsewhere

Pressing a button often updates a part of the page you are not looking at.
When that happens the status line says so — *"3 areas changed, press c to
jump"* — and `c` walks through them. Nothing moves you automatically.

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
