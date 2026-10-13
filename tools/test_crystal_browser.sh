#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

tools/build_crystal.sh
export TAWB_TEST_CRYSTAL_BROWSER=1

# Run under tools/run_isolated.sh so a run cut short does not leave the
# browsers it started behind; see that script for why a process group is not
# enough to reach them.
exec tools/run_isolated.sh node --test --test-concurrency=1 test/browser/crystal_dump.test.js test/browser/crystal_fields.test.js test/browser/crystal_actions.test.js test/browser/crystal_interactive.test.js test/browser/crystal_tabs.test.js test/browser/crystal_frames.test.js test/browser/crystal_library.test.js test/browser/crystal_auth.test.js test/browser/crystal_views.test.js test/browser/crystal_focus.test.js
