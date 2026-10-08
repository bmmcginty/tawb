#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

BINARY=${TAWB_CRYSTAL_BIN:-dist/tawb-crystal}
tools/build_crystal.sh "$BINARY"
export TAWB_TEST_CRYSTAL=1
export TAWB_CRYSTAL_BIN="$BINARY"

if [ "$#" -gt 0 ]; then
  exec node --test "$@"
fi
exec node --test test/*.test.js
