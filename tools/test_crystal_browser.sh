#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

# A browser differential takes a real browser all the way to its end, so a
# scoped run is how this suite is usually worked on, and paying the static
# build for one file makes that pointless. TAWB_SKIP_BUILD=1 keeps the binary
# the last build wrote.
# The binary under test is TAWB_CRYSTAL_BIN when a caller supplies one, which
# is how the release matrix runs one artifact through every environment
# without letting a later step rebuild it. Build and verify the same path,
# never the default while another binary is what the tests start.
BINARY=${TAWB_CRYSTAL_BIN:-bin/tawb}
if [ -z "${TAWB_SKIP_BUILD:-}" ]; then
  tools/build_crystal.sh "$BINARY"
fi
# TAWB_SKIP_BUILD is only safe when the retained binary still belongs to this
# checkout. Also prove that the page programs compiled into a fresh build are
# still generated from their JavaScript references.
tools/verify_crystal_build.sh "$BINARY"
export TAWB_TEST_CRYSTAL_BROWSER=1
# A browser asked for a session bus will activate the desktop's portal, dconf,
# GVfs and keyring services on it, and each is a process of its own that
# outlives the run. The private bus has no service directories, so nothing is
# activatable, and it is what a terminal with no desktop already gets.
export TAWB_A11Y_BUS=private

# Files may be named to run a subset:
#
#   tools/test_crystal_browser.sh test/browser/crystal_dump.test.js
#
# Node options narrow whatever set of files is chosen. Options come first,
# because node reads a test option after a file name as another file:
#
#   tools/test_crystal_browser.sh --test-name-pattern='the dump'
#
# With no file named, the whole suite is the set.
paths=0
for argument in "$@"; do
  case $argument in
    -*) ;;
    *) paths=1 ;;
  esac
done
if [ "$paths" -eq 0 ]; then
  # Discover every browser differential by convention instead of maintaining
  # a list that silently falls behind. tools/browser_tests.sh holds that
  # discovery so the release matrix can print the same set this gate runs.
  # The discovered names go after the caller's arguments: node treats an
  # option that follows a file name as another file to run, so a pattern
  # appended after the suite would silently select everything.
  set -- "$@" $(tools/browser_tests.sh)
fi

# Run under tools/run_isolated.sh so a run cut short does not leave the
# browsers it started behind; see that script for why a process group is not
# enough to reach them.
# Node normally treats skipped tests as success. Keep the ordinary spec output
# while a second reporter turns any skip (including a missing browser or tmux)
# into a failing parity gate.
exec tools/run_isolated.sh node --test --test-concurrency=1 \
  --test-reporter=spec \
  --test-reporter="$ROOT/tools/fail_on_skips_reporter.js" \
  --test-reporter-destination=stdout \
  --test-reporter-destination=stderr \
  "$@"
