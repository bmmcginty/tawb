#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

tools/build_crystal.sh
export TAWB_TEST_CRYSTAL_BROWSER=1
exec node --test --test-concurrency=1 test/browser/crystal_dump.test.js test/browser/crystal_fields.test.js test/browser/crystal_actions.test.js test/browser/crystal_interactive.test.js test/browser/crystal_tabs.test.js test/browser/crystal_frames.test.js test/browser/crystal_library.test.js
