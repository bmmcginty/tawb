#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

# A browser differential takes a real browser all the way to its end, so a
# scoped run is how this suite is usually worked on, and paying the static
# build for one file makes that pointless. TAWB_SKIP_BUILD=1 keeps the binary
# the last build wrote.
if [ -z "${TAWB_SKIP_BUILD:-}" ]; then
  tools/build_crystal.sh
fi
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
# Node options narrow whatever set of files is chosen and are kept alongside
# the names:
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
  # a list that silently falls behind. The two historical names predate the
  # crystal_ prefix and remain explicit.
  set -- test/browser/crystal_*.test.js \
    test/browser/layout_order_crystal.test.js \
    test/browser/live_crystal.test.js "$@"
fi

# Run under tools/run_isolated.sh so a run cut short does not leave the
# browsers it started behind; see that script for why a process group is not
# enough to reach them.
exec tools/run_isolated.sh node --test --test-concurrency=1 "$@"
