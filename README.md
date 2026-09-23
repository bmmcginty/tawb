# TAWB

TAWB (pronounced “taub”) is a terminal interface to the modern web. It opens a
real Chrome, Chromium, or Firefox browser, then presents each page as a linear,
keyboard-driven list of headings, links, controls, and text.

It is intended primarily for blind Linux users who already use a terminal with
a screen reader or braille display. The terminal cursor marks the current
reading position, so TAWB does not provide speech itself: Orca, Speakup, a
terminal screen reader, or a braille setup can read it in the usual way.

Unlike traditional text browsers, TAWB does not attempt to implement today's
web platform. The installed browser handles JavaScript, cookies, media,
authentication, extensions, and the rest of the modern browser environment.
TAWB supplies a text interface to what that browser loads.

## Why use TAWB?

TAWB is useful when you want:

- a terminal-first way to read and operate JavaScript-heavy websites;
- one predictable line of content at a time, with no visual layout to decode;
- keyboard navigation by heading, link, button, field, paragraph, or text;
- access through a screen reader, braille display, the Linux console, or SSH;
- alternatives when a site's accessibility information is incomplete or
  incorrect;
- browser features such as persistent logins, password filling, bookmarks,
  history, downloads, tabs, file uploads, and extension dialogs;
- key bindings you can change without rebuilding your browser, screen reader,
  desktop, or accessibility libraries.

The last point is central to the project. TAWB reads pages through browser
control protocols and page content rather than requiring the entire desktop
accessibility stack to define the reading experience. It still uses Linux
AT-SPI when available for browser-owned windows, such as permission and
extension-installation dialogs, but ordinary page reading and navigation do
not depend on that route alone.

## Requirements

TAWB currently targets Linux. You need:

- a current Node.js release and npm;
- Chrome, Chromium, Firefox, Firefox ESR, or LibreWolf;
- a terminal that reports its key sequences correctly through `$TERM`;
- `xvfb-run` if no graphical `$DISPLAY` is available.

On Debian and Ubuntu, `xvfb-run` is supplied by the `xvfb` package. Package
names for Node.js and browsers vary by distribution.

TAWB has no npm runtime dependencies. It controls the browser directly using
Chrome DevTools Protocol or WebDriver BiDi.

## Quick start

Clone the repository and start with Chromium, the default engine:

```sh
git clone https://github.com/bmmcginty/tawb.git
cd tawb
npm link
cd /where/you/keep/files
tawb https://example.com
```

The `tawb` command keeps the directory where it was invoked as its working
directory, so relative paths in an upload prompt begin there rather than in the
source checkout. `npm start -- https://example.com` remains available when
working in the checkout.

Use Firefox instead:

```sh
tawb --browser firefox https://example.com
# From the source checkout:
npm run firefox -- https://example.com
```

You may omit the scheme or enter search terms:

```sh
tawb wikipedia.org
tawb "linux braille displays"
```

With no address, TAWB opens Google. Searches entered in the address bar use
DuckDuckGo by default; see [Search configuration](#search-configuration) to
change that.

TAWB starts an ordinary, visible browser. If `$DISPLAY` is unset, it runs the
browser on a 1280×1024 virtual X display using `xvfb-run`. It does not use the
browser's headless mode because some sites treat headless or automation-launched
browsers differently.

Each browser is given a display of its own. Where `xvfb-run` offers
`--auto-display`, TAWB uses it, so that the X server picks its own display
number and two browsers starting at the same moment cannot be handed the same
one. An older `xvfb-run` without that option falls back to `--auto-servernum`.

## First steps

When a page opens, the terminal contains the page title, the current view and
address, a short key reminder, and the page itself. Moving onto a link shows
where that link goes on the status line at the bottom, the way a graphical
browser shows it in the corner of the window; `u` turns that off and on again
if you would rather not hear an address on every link. Start with these keys:

| Key | Action |
| --- | --- |
| `↓` / `↑` or `j` / `k` | Read the next or previous line |
| `Tab` / `Shift+Tab` | Move to the next or previous control |
| `Enter` | Follow a link, press a button, or edit a field |
| `Ctrl+L` | Enter an address or search terms |
| `/` / `?` | Find text forward or backward |
| `Alt+-` / `Alt++` | Go back or forward |
| `Ctrl+T` | Open a new tab |
| `>` / `<` | Move between tabs |
| `\` | Switch to another page view |
| `r` | Rescan TAWB's view without reloading the page |
| `F5` | Reload the page in the browser |
| `Alt+?` | Open keyboard help and change bindings |
| `Alt+K` / `Ctrl+\\` | Toggle webpage keyboard mode |
| `q` | Quit |

Useful single-letter navigation keys are `h` for headings, `l` for links, `b`
for buttons, `f` for form fields, `p` for paragraphs, and `n` for non-link
text. Uppercase moves backward where available.

Press `Enter` on a text field or an HTML `contenteditable` region to edit it.
TAWB follows the browser's caret through nested rich text as you type, move, or
delete. While editing, `Tab` or `Shift+Tab` moves to the next or previous
control and continues editing automatically when that control is another text
field. Buttons, links, and select-only controls remain in forms mode without
being activated; press `Enter` to activate one or keep moving with `Tab`.
Press `Escape` to return to browsing. Pressing `Enter` on a native select opens
its choices; select-only ARIA
comboboxes are activated rather than treated as text fields. Press `m` when a
site requires a real pointer click, for example to grant user activation to a
media control or open a file chooser.

Press `Alt+K` to enter webpage keyboard mode. In that separate mode, keys are
sent as trusted browser input instead of running TAWB commands: for example,
Instagram Reels accepts `Space` to play or pause, `m` to mute or unmute, and
the arrow or page keys to scroll in either direction. Even `Escape`, `Ctrl+L`,
and `q` go to the webpage while this mode is active. Press `Alt+K` again to
return to reading. `Ctrl+\\` is a one-byte alternative that remains reliable
when a slow SSH connection separates an Alt key's two bytes. Both bindings can
be changed in the keyboard wizard. Leaving is immediate; any page changes are
rescanned through normal live updating after you pause, or with `r` when live
updates are disabled.

Custom ARIA sliders appear as fields with their current value. Press `Enter`
on one to start control mode, use arrows, Home, End, Page Up or Page Down, and
press `Escape` to stop. If a site advertises a slider but ignores those
standard keyboard commands, TAWB uses trusted pointer input on the visible
track and verifies that its value changed. Independently focusable controls
remain reachable even when a site incorrectly nests them inside another
button or field.

All browse and editing bindings are configurable. Press `Alt+?`, select an
action, and replace or add a key. TAWB stores the result in
`$XDG_CONFIG_HOME/tawb/keys.json`, or `~/.config/tawb/keys.json` when
`XDG_CONFIG_HOME` is not set.

## Four ways to read a page

Press backslash (`\`) to cycle through four views:

| View | Purpose |
| --- | --- |
| `AX` | A semantic accessibility view and the best default for most pages |
| `PAGE` | Visible page content derived from the DOM, useful when accessibility markup is wrong |
| `INSPECT` | Semantic items alongside the elements that produced them |
| `SOURCE` | The page's live HTML, including shadow DOM where the browser exposes it |

These alternatives are an escape hatch. If a control is missing from the AX
view, it may still be available in PAGE or SOURCE. INSPECT can reveal whether
a misleading name or role came from the site. Switching views attempts to keep
you on the same element rather than the same line number.

This does not make every inaccessible website accessible automatically. It
does make failures inspectable and often provides another route to the
content or control.

## Live pages

TAWB briefly freezes its page buffer while you navigate. About 2.5 seconds
after you stop pressing keys, updates resume. This prevents advertisements,
feeds, clocks, and other live content from moving the current line while it is
being read.

ARIA live announcements are delivered immediately. Simple text changes that
do not reflow the page may also be updated in place. Press `r` for an immediate
refresh, or `L` to disable or enable automatic updates.

At the end of a feed, press Down again. TAWB scrolls the browser, waits for
more content, and adds any newly loaded items.

## Browser data and prompts

TAWB uses a persistent browser profile, so cookies and logins survive between
runs. It also exposes the browser's own data rather than maintaining separate
copies:

| Key | Browser feature |
| --- | --- |
| `Ctrl+O` | Bookmarks |
| `Ctrl+D` | Bookmark the current page |
| `Alt+H` | History |
| `Alt+J` | Downloads |
| `Alt+D` | Download the link under the cursor |

Typing in one of these lists filters it. Press `Enter` to open the selected
entry or `Escape` to return to the page. The `Alt+D` action uses the browser's
own download manager, so authenticated requests, filenames, and download
history behave as they do for an Alt-click in the graphical browser. Plain
letters are reserved for moving through the page, so every command that acts on
something carries `Alt` or `Ctrl`.

The browser's password manager remains responsible for saved credentials.
TAWB can present its save-password prompt and identifies fields the browser
has filled. Password values are not copied into TAWB.

Browser-owned questions—such as extension installation, site permissions, and
JavaScript alerts—are shown in the terminal when the browser and Linux
accessibility bus expose them. Move to an answer and press `Enter`. `Escape`
leaves the question unanswered; `Alt+Q` returns to it later.

Pressing `Enter` on a file control opens a terminal path prompt. `Tab` completes
file names, `Enter` attaches the file, and `Escape` cancels.

## Common options

### Defaults for every run

Put command-line options in `$XDG_CONFIG_HOME/tawb/settings`, or
`~/.config/tawb/settings` when `XDG_CONFIG_HOME` is not set. The file accepts
the same option syntax as the command line, including quotes, escapes, blank
lines, and comments beginning with `#`. For example, this selects Firefox and
leaves it running so later sessions can rejoin it quickly:

```text
--browser firefox
--keep-browser
```

Command-line options are applied after these defaults and therefore take
precedence. Use `--no-keep-browser` for a single run that should close a browser
even when the settings file contains `--keep-browser`.

### Keep or select a profile

TAWB creates its default profile under the XDG data directory, normally
`~/.local/share/tawb/`. Choose another profile with:

```sh
npm start -- --profile ~/browser-profiles/tawb https://example.com
```

Chrome and Firefox use separate default profile directories. Snap-packaged
browsers can access only paths allowed by Snap confinement; TAWB chooses a
reachable default automatically.

Leave a browser running for a faster next start:

```sh
npm start -- --keep-browser https://example.com
```

### Attach to an existing browser

For Chromium, start the browser with a remote debugging port, then attach:

```sh
chromium --remote-debugging-port=9222
npm start -- --connect 9222
```

Attaching has limitations. In particular, Chromium's native dialogs may be
unavailable unless accessibility was enabled when the browser started, and
Firefox cannot add its bookmarks, history, and downloads agent to an arbitrary
already-running instance. An instance previously started with `--keep-browser`
retains that agent and makes all three lists available when TAWB rejoins it.

### Search configuration

Set a search URL template with `%s` where the encoded query belongs:

```sh
npm start -- --search 'https://www.google.com/search?q=%s'
export TAWB_SEARCH='https://html.duckduckgo.com/html/?q=%s'
```

### Link addresses

The status line says where the link under the cursor goes. `u` switches that
off and on while reading. To start with it off every time:

```sh
npm start -- --no-link-address
export TAWB_LINK_ADDRESS=off
```

`U` shortens a link that stays on the site you are reading to its path alone,
so a link from `/a/b/c` to `/b` is announced as `/b` rather than repeating the
host every time. Links that leave the site keep their full address. To start
with the short form every time:

```sh
npm start -- --short-links
export TAWB_SHORT_LINKS=on
```

### Unicode on a physical Linux console

Speakup can receive many Unicode characters as they are first written, but
screen review on a physical virtual console is limited by the loaded console
font, and supplementary code points cannot pass through Speakup's 16-bit text
buffers. To keep webpage text stable when it is reviewed later, represent every
non-ASCII page character with an ASCII Unicode escape:

```sh
npm start -- --escape-unicode https://example.com
```

For example, `é`, `中`, and `😀` are displayed as `\u00E9`, `\u4E2D`, and
`\U0001F600`. This applies to all four page views, page titles, text shown while
editing a webpage field, live announcements, and page text repeated on the
status line. Browser interaction and submitted field values retain their
original Unicode. Put `--escape-unicode` in the settings file to enable it for
every run; `--no-escape-unicode` overrides that setting for one run.

### Diagnostic logging

TAWB does not create a diagnostic log by default. Add `--log` when
investigating a problem:

```sh
npm start -- --log https://example.com
```

The log is written to your home directory with a name such as
`~/.tawb.20260827140509.1234.log`. Choose another directory with `--log-dir`
or `TAWB_LOG_DIR`; TAWB creates it when possible. This is useful for a directory
mounted out of a container:

```sh
docker run -v "$PWD/tawb-logs:/logs" IMAGE npm start -- --log --log-dir /logs
```

Logs may contain addresses and other browsing details; inspect them before
sharing.

For a Firefox startup problem on a machine that cannot be inspected directly,
create a self-contained report with a fresh temporary profile:

```sh
npm run diagnose:firefox -- --log-dir /logs
```

Note the `--` before `--log-dir`: without it, `npm run` keeps the argument for
itself and the diagnostic never sees it. `--log-dir` is the only argument the
diagnostic takes, and anything else is refused rather than ignored, so a
mistyped flag cannot leave the report inside a container you cannot reach. The
diagnostic always writes a log, so it has no `--log` of its own.

The report records the OS and runtime, Firefox's WebDriver capabilities,
automation state around session creation, bounded browser output on a bot
check failure, and `navigator.webdriver` from several document lifetimes. Set
`TAWB_IMAGE_REVISION` in a container image to include its build identifier.

If a browser is unusually slow to create its profile, increase the startup
timeout:

```sh
TAWB_BROWSER_TIMEOUT=120 npm start -- https://example.com
```

Do not run TAWB as root. Modern browsers require their security sandbox and
normally refuse this mode of operation as root.

## Comparison with alternatives

### Lynx, ELinks, and w3m

Traditional text browsers are smaller, faster, easy to use over slow SSH
connections, and excellent for documents and simple forms. They can run
without a graphical browser or virtual display.

TAWB is much heavier because a complete desktop browser runs behind it. In
return, the browser—not TAWB—implements modern JavaScript and web APIs. Sites
that require client-side rendering, browser storage, complex authentication,
media controls, or modern component frameworks are therefore more likely to
work.

### edbrowse

edbrowse combines a line-oriented browser with an editor and is especially
powerful for users who prefer command-driven workflows. It is mature, compact,
and does not require a full graphical browser for every task.

TAWB instead offers immediate cursor navigation in a full-screen terminal and
delegates current web-platform behavior to Chrome or Firefox. It will consume
more memory and CPU, but avoids having to reproduce every browser API as sites
adopt it. An experimental edbrowse backend is also present for users interested
in combining the approaches; its integration details are documented in
`README-dev.md`.

### A graphical browser with Orca or another screen reader

A conventional browser and desktop screen reader provide the most integrated
and widely tested experience, including browser chrome, desktop dialogs, and
platform accessibility conventions. TAWB is not a replacement for every part
of that stack.

TAWB's advantage is control: a terminal-native linear buffer, configurable
bindings, low dependence on desktop UI conventions for page reading, and
multiple views when the site's accessibility tree fails. Its disadvantages are
a younger and less polished interface, fewer browser-chrome features, and the
need to understand terminal key behavior.

### Browser-backed terminal interfaces and automation tools

Projects such as Browsh also use a real browser, often aiming to reproduce the
visual page in character cells. TAWB instead presents semantic lines designed
for speech, braille, and direct keyboard navigation; it is not a visual text
rendering of the page.

Many automation tools launch a special headless or instrumented browser. That
is convenient for testing, but some bot-detection systems reject it. TAWB
starts a normal headed browser and attaches to it. This improves compatibility,
but requires a display or Xvfb and uses roughly the resources of an ordinary
browser.

## Limitations

Before choosing TAWB, be aware that:

- it is Linux-focused and currently distributed as source rather than as a
  system package;
- it uses substantially more memory and CPU than a traditional text browser;
- a graphical display or Xvfb is required even though the user interface is in
  the terminal;
- no alternative view can recover information that a site never provides or
  make every custom control operable;
- CAPTCHAs, bot protection, canvas-only applications, drag-and-drop interfaces,
  and browser-specific UI can still be difficult;
- native browser dialogs depend partly on Linux D-Bus and AT-SPI availability;
- terminal emulators disagree about some modified and function-key sequences,
  although bindings can be changed in the keyboard wizard;
- Firefox and Chromium expose different browser internals, so a few profile and
  attached-browser features differ between engines.

For implementation details, design decisions, tests, and the edbrowse backend,
see `README-dev.md` and `PORTING.md`.

## Getting help

Report public issues at https://github.com/bmmcginty/tawb/issues or email
`git@bmcginty.us`.

Private problem URLs are welcome by email. The maintainer will keep the details
of emailed reports confidential and will not judge anyone's browsing habits.
