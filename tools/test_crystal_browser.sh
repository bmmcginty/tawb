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
  set -- test/browser/crystal_dump.test.js test/browser/crystal_fields.test.js test/browser/crystal_actions.test.js test/browser/crystal_interactive.test.js test/browser/crystal_tabs.test.js test/browser/crystal_frames.test.js test/browser/crystal_library.test.js test/browser/crystal_auth.test.js test/browser/crystal_views.test.js test/browser/crystal_focus.test.js "$@"
fi

# Run under tools/run_isolated.sh so a run cut short does not leave the
# browsers it started behind; see that script for why a process group is not
# enough to reach them.
exec tools/run_isolated.sh node --test --test-concurrency=1 "$@"
