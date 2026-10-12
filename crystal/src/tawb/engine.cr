# The browser, reduced to what a reader actually needs from it: the seam
# src/driver.js draws, in Crystal's own terms.
#
# Everything above this file talks in pages, frames and handles. That shape
# came from Playwright and outlived it — page/frame/handle is a reasonable
# contract in its own right, and the subset used here is small. Both engines
# satisfy it themselves (cdp.cr and firefox_driver.cr), which is what lets a
# second engine arrive without rewriting everything that reads pages.
#
# JavaScript gets that for nothing: a page is whatever answers `url()`. A
# statically typed port has to say so, and there are exactly two ways to say
# it. An interface each engine includes would make the collections awkward —
# an `Array(FirefoxDriver::Frame)` is not an `Array` of the interface, so
# every method that answers with frames would have to build a different array
# than it has. A union says the same thing without that: Crystal dispatches
# `page.evaluate` across the members, and a member that does not answer it is
# a compile error rather than a surprise at runtime. The set of engines is
# closed either way — src/driver.js's own ENGINES table is a closed list of
# two.
#
# What cannot be put in a union is the handful of operations where the engines
# genuinely differ, and those live on the engine classes themselves: the
# trusted pointer gestures, the slider track each measures its own way, the
# accessibility extraction, and the browser's own bookmarks and history. The
# policy above them — when a trusted click is needed at all, what a read-back
# value means — stays in Actions and Core, named once.

require "./cdp"
require "./firefox_driver"

module Tawb
  module Engine
    # A tab, and the documents in it.
    alias Page = Cdp::Page | FirefoxDriver::Page
    alias Frame = Cdp::Frame | FirefoxDriver::Frame
    # Where a script runs: a tab's top document, or one embedded in it.
    alias Scope = Page | Frame
    # A value living in the page, held by reference.
    alias Handle = Cdp::Handle | FirefoxDriver::Handle
    # The browser's own input pipeline, for the one thing a page cannot be
    # asked to do to itself.
    alias Keyboard = Cdp::Keyboard | FirefoxDriver::Keyboard
    # The browser, as a tab inventory.
    alias Session = Cdp::BrowserSession | FirefoxDriver::BrowserSession
  end
end
