# tawb

Welcome to TAWB.
TAWB lets a blind user read and operate websites in a text-based terminal using a screen reader or braille display.

TAWB (pronounced taub) is an interface to Chrome and Firefox via the terminal.
This project is designed to provide an experience as close as possible to a GUI browser.
Webpages are rendered in a linearized format.
Email git@bmcginty.us with any questions or problems.

## Quickstart

Install xvfb, node, and either Chrome or Firefox.
e.g.
$$

Start by running
`npm start -- https://example.com`
or you can directly run
`node src/index.js`
Chrome will be run by default.
If you don't have Chrome installed, use `npm run Firefox`.

By default, you'll end up in the body of a webpage.
If you don't specify a URL on the command line, you'll be sent to `https://www.google.com/`.

- Arrow keys or `j`/`k`: move
- `Enter`: activate
- `Ctrl+L`: enter an address
- `Tab`: next interactive control
- `Alt+-`: back
- `q`: quit
- `Alt+?`: keyboard help/configuration

TAWB does not create a diagnostic log by default. If you are investigating a
problem, add `--log`:

```
npm start -- --log https://example.com
```

The log is written to your home directory with a name such as
`~/.tawb.20260827140509.1234.log`.

To configure your key bindings, use alt-shift-slash (or alt-questionmark).

## Purpose

Browsers and OS's have accessibility APIs, ARIA handlers, etc.
Layers on top of layers, with no  escape hatches.
I want to provide a browser interface as separated from these APIs as possible.
If a site is broken from a accessibility prospective, we should be easily able to work around it.

## Usage

In order to allow for a smooth reading experience, Tawb freezes it's view of the webpage,
unless you're sitting still on the webpage for more than two and a half seconds.
Use the refresh key (r by default) to refresh your view of the webpage.
If you're trying to use a site that's giving you problems,
you can switch "views" (using \ by default).

- ax: a view using ARIA and accessible content
- page: a view using the pages underlying HTML
- inspect: a view of the webpage's HTML, marked up for easy navigation
- source: raw HTML

You can move around in each of these views using the navigation keys below, as well as those found in the keyboard wizard.

These bindings are configurable; see Keys below.
You can move by link, form field, heading, and text block.
- h for headings
- l for links
- tab for form fields and links (anything you can normally "tab to")
- n for blocks of text
- p for paragraphs
Press enter to edit a field, and Enter or Escape to exit that field.
Press enter to activate something like a link.
If you need to perform an actual mouse click, press `m`.
Go back a page by pressing `alt--` and forward by pressing `alt-+`.
For a new tab, press Ctrl-t.

## Going somewhere

`Ctrl+L` opens the address bar. It takes an address when you give it one and
searches when you do not, the same way a graphical browser's does:

```
Address: en.wikipedia.org/wiki/Braille    goes there
Address: braille dots                     searches for it
```

You never have to type `https://`. A bare host name gets it, and the things
that normally have no certificate — `localhost:8080`, `192.168.1.5`, a
`.local` name on your own network, a bare `myhost:3000` — get `http` instead,
which is the guess a browser makes too. Anything with a scheme already on it
is taken exactly as typed, so `about:blank` and `file:///tmp/page.html` work.

Anything else is words, and words are searched for. The status line says so —
*Searching for "braille dots"…* — because a host name with a typo in it
otherwise lands you on a results page with no account of why.

Searches go to DuckDuckGo unless you say otherwise. Neither browser will tell
us which engine you chose in its own settings, so it is said here instead:

```
npm start -- --search 'https://www.google.com/search?q=%s'
export TAWB_SEARCH='https://html.duckduckgo.com/html/?q=%s'
```

`%s` is where your words go; a template without one has them added on the end.

The same reading applies to what you type on the command line, so
`npm start -- wikipedia.org` is an address and needs no scheme.

## Your bookmarks, history and downloads

TAWB asks the browser for its own three lists, so they are the same bookmarks
and the same history you would see in the browser itself.

- `Ctrl-o` for bookmarks
- `alt-h` for history
- `alt-j` for downloads

(Browsers use Ctrl-h and Ctrl-j for the last two, but a terminal spent those
two keys on Backspace and Enter long before browsers existed, so they become
the alt keys of the same letters.)

- `Ctrl-d` to bookmark the page you are on

Each opens as an ordinary list you move through with the arrow and page keys.
**Typing filters it**, rather than jumping: type `braille` and only the
entries with that word in them remain, and every word you type has to appear
somewhere in the entry, in any order. Backspace takes a letter back. Press
Enter to go to the entry you are standing on, or Escape to close the list and
return to exactly where you were reading.

`Ctrl-d` files the page you are reading, which is the same key every browser
uses for it. The page's own title is offered as the name, already typed in:

```
Bookmark: Braille - Wikipedia
```

Press Enter to file it under that name, or edit it first — the usual editing
keys work. Escape files nothing. It goes into the browser's own bookmarks, in
the folder the browser's own star would use, and TAWB says which one that was.

A page you have already bookmarked is not filed twice; you are told the name it
is already under, which is what a browser does too.

On Chrome and Chromium all of this works with any browser, including one you
attached to with `--connect`. On Firefox it works only with a browser TAWB
started itself: Firefox will only answer these questions to privileged code,
and the one moment such code can be installed is while the browser is starting
up. A Firefox that was already running says so instead.

## Passwords the browser remembers

TAWB never holds a password of yours. What it does is let you reach the
browser's own password manager, which is where your passwords already are.

Sign in to a site and the browser offers to remember it, in a window of its
own that arrives on the terminal like any other question:

```
Save password?
Passwords are saved to Password Manager on this device.
Username: reader
Password: ••••••••••••••

Never
No thanks
Save
```

The password is shown masked because the browser masks it — that is its own
dialog you are reading. Move to an answer and press Enter. Escape presses
nothing and leaves the question open; `Alt+Q` goes back to it.

Next time you visit, the fields say so:

```
Username[Username: filled by the browser]
Password[Password: filled by the browser]
```

They read as empty otherwise, and they are not empty — both browsers fill a
saved sign-in in a way that pages cannot read, which is what stops a hostile
page stealing it. Press the sign-in button and it goes through with the
remembered password; you do not need to type anything.

Whether the browser fills a particular form is the browser's decision, not
TAWB's. Chrome in particular reads the form and the words around it and will
decline to fill one it has decided is a sign-up rather than a sign-in.

## Sending a file to a site

Press Enter on a file control — "Choose file", "Your document", whatever the
page calls it — and TAWB asks you for a path on the status line:

```
File: ~/docs/rep
```

**Tab completes it**, the way a shell does: as far as the names agree, with a
`/` when it is a directory so the next Tab carries on inside it, and a list of
what matched when there is more than one. `~` works, and a bare name is taken
from the directory you started TAWB in. Enter attaches the file and tells you
what it attached and how big it was; Escape attaches nothing. If the page
takes several files it keeps asking until you press Enter on an empty line.

A file that does not exist, or cannot be read, is refused there and then —
before the browser is given it, because a browser handed a bad path says
nothing and the page ends up with a file that is not there.

Some pages have no file control to press: an "Upload" button that opens the
chooser itself, which is most drag-and-drop upload boxes. Press `m` on the
button — the real click — and the same prompt appears, because the browser
hands the chooser to TAWB instead of asking the desktop for it.

Nothing is ever opened on a screen you cannot see. Escaping the prompt leaves
the page with no file, which is exactly what cancelling a file dialog does.

## When the browser asks you something

Some of what a browser puts in front of you is not a page. Adding an extension
is the clearest case: you go to the Chrome Web Store, press **Add to Chrome**
like anybody else, and Chrome asks you to confirm — in a window of its own,
drawn outside the document, which nothing that reads a page can see.

TAWB brings that question to the terminal. What appears is the dialog's own
words, including the list of what the extension will be able to do:

```
Add "uBlock Origin Lite"?
It can:
Read and change all your data on all websites

Cancel
Add extension
```

Move to the answer you want with the arrow keys and press Enter, and TAWB
presses that button in the browser. Escape presses whichever button the
browser itself has ready — on an install prompt that is **Cancel**, which is
Chrome's own safe answer, and the hint line always says which one it is. The
browser does the installing; nothing is added behind your back, and nothing
is decided for you.

Afterwards the browser's "has been added" confirmation arrives the same way,
with its own button, because a sighted user sees that too.

Firefox works the same, from addons.mozilla.org. Its panel says more — the
permissions, whether the add-on collects data, and an option to allow it in
private windows. An option like that appears as `[ ]` or `[x]`; press Enter on
it to tick it, and the question stays up until you answer it.

This is not only for extensions. Anything the browser draws in a window of its
own rather than in the page comes through the same way — on Chrome and
Chromium that includes a site's permission request ("wants to: Know your
location", with all four of the browser's own answers) and a page's own
`alert` box, which is a modal that stops the page until it is answered and
which before this was simply a page that had quietly stopped.

On Chrome and Chromium this needs a browser TAWB started itself, because
describing its own windows is something Chrome is told to do at startup.
Firefox decides that for itself, so there it works with `--connect` too. On a
desktop TAWB uses the accessibility bus that is already running; with no
desktop at all it provides one for the browser and takes it away again when
you quit.

## Keys

Pressing alt-shift-slash will bring you into a keyboard wizard.
From here, press your arrow keys to move up and down the list of actions.
Press enter to replace all bindings for the action you're on, or press alt-a to add a binding.
Once you press alt-a or enter, you'll be prompted for a new binding.
Type the new keystroke, and you'll be returned immediately to the actions list.
When you're finished, down arrow to "exit keyboard wizard", press enter, and confirm your changes.

## If the browser will not start

TAWB starts an ordinary browser and attaches to it, so a failure here is
usually about the browser rather than about TAWB. The error message names the
browser, its profile directory, the display it was given, and whatever the
browser itself printed; that last part is normally the answer.

Two cases are worth knowing about:

- **A Snap browser.** Ubuntu ships Firefox (and Chromium) as Snap packages,
  and a Snap can only open non-hidden directories under your home directory.
  TAWB gives such a browser a profile inside its snap directory, for example
  `~/snap/firefox/common/tawb/firefox-profile`. If you pass `--profile`
  yourself, it has to be somewhere the Snap can reach, or the browser will sit
  there showing an error you cannot see.
- **A slow first launch.** A browser creating a profile for the first time on
  a slow machine can take longer than TAWB waits (25s for Chrome, 45s for
  Firefox). Set `TAWB_BROWSER_TIMEOUT` to a number of seconds to wait longer:
  `TAWB_BROWSER_TIMEOUT=120 npm start -- https://example.com`. If that makes
  it work, the browser was only slow.

Do not run TAWB as root: browsers refuse to use their security sandbox as
root, and TAWB will not disable the sandbox for them.

## Problems

We'd like to hear about any issues you encounter.
This is especially true for captchas/bot protection.
File an issue at
https://github.com/bmmcginty/tawb/issues
or email
git@bmcginty.us.
You're welcome to email if you have a problem URL you want kept private, or don't want linked with a Github username.
(Specifics of emailed bug reports will be kept strictly confidential, and the author of this project will not make judgement calls on anyone else's browsing habits.)
