#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

BINARY=${1:-bin/tawb}
if [ ! -x "$BINARY" ]; then
  echo "verify_crystal_build: $BINARY is not executable" >&2
  exit 1
fi

expected_revision=$(tools/version.py revision)
actual_revision=$($BINARY --version)
if [ "$actual_revision" != "$expected_revision" ]; then
  echo "verify_crystal_build: $BINARY was not built from HEAD" >&2
  echo "expected: $expected_revision" >&2
  echo "actual:   $actual_revision" >&2
  exit 1
fi

# These tests compare every embedded page-program source with the generated
# Crystal asset. Since the browser gate builds immediately before this check,
# matching files are the bytes compiled into the binary under test.
node --test test/crystal_assets.test.js
