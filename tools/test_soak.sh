#!/bin/sh
set -eu

# The long live/idle/action soak.
#
#   tools/test_soak.sh                         # one hour per runtime
#   TAWB_SOAK_MS=1800000 tools/test_soak.sh    # half an hour per runtime
#   xvfb-run -a tools/test_soak.sh             # with no display of your own
#
# crystal_soak.test.js is the same test the browser gate runs as a short CI
# smoke case. This runs it against the freshly built native binary and the
# JavaScript reference for the full duration, and the ordinary browser runner
# supplies the private bus, the skip reporter, the isolated process tree and
# the build/revision checks. Growth, descriptor, process and cleanup
# assertions are the test's, not this script's; the script only decides how
# long they are measured for.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

export TAWB_SOAK_MS="${TAWB_SOAK_MS:-3600000}"
if [ "$TAWB_SOAK_MS" -lt 60000 ]; then
  echo "test_soak: TAWB_SOAK_MS=$TAWB_SOAK_MS is too short for a soak" >&2
  exit 2
fi

printf 'Soaking for %s ms per runtime\n' "$TAWB_SOAK_MS"
exec tools/test_crystal_browser.sh test/browser/crystal_soak.test.js
