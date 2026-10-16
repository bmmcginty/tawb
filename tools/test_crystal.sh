#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

BINARY=${TAWB_CRYSTAL_BIN:-bin/tawb}
# A scoped run is the common way to work, and the static build costs about a
# minute, so an iteration on one file that has not touched the Crystal source
# keeps the binary the last build wrote. TAWB_SKIP_BUILD=1 asks for that.
if [ -z "${TAWB_SKIP_BUILD:-}" ]; then
  tools/build_crystal.sh "$BINARY"
fi
export TAWB_TEST_CRYSTAL=1
export TAWB_CRYSTAL_BIN="$BINARY"
# A browser asked for a session bus will activate the desktop's portal, dconf,
# GVfs and keyring services on it, and each is a process of its own that
# outlives the run. The private bus has no service directories, so nothing is
# activatable, and it is what a terminal with no desktop already gets.
export TAWB_A11Y_BUS=private

if [ "$#" -gt 0 ]; then
  exec tools/run_isolated.sh node --test "$@"
fi
exec tools/run_isolated.sh node --test test/*.test.js
