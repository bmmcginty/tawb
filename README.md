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
