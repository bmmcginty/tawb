#!/bin/sh
# The browser differentials a gate runs, one file per line.
#
# The set is discovered by convention rather than maintained by hand: a file
# named crystal_*.test.js is a native differential, because that is what the
# name means. The two historical files predate the prefix and are named
# explicitly so that renaming them cannot quietly remove them from every gate.
#
# Both tools/test_crystal_browser.sh and tools/test_release_matrix.sh read this
# file, so the set a release matrix claims to run is the set the gate actually
# runs, and a change to one cannot silently disagree with the other.
#
# Usage: tools/browser_tests.sh [extra files or node options...]
#   With no arguments the discovered set is printed. Arguments are appended,
#   which is how a caller adds a file the convention does not name.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

for path in test/browser/crystal_*.test.js \
  test/browser/layout_order_crystal.test.js \
  test/browser/live_crystal.test.js; do
  printf '%s\n' "$path"
done

if [ "$#" -gt 0 ]; then
  printf '%s\n' "$@"
fi
