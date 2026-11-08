#!/bin/sh
set -eu

# The performance corpus for the artifact users install.
#
#   xvfb-run -a tools/test_performance.sh
#   TAWB_PERF_ONLY=large xvfb-run -a tools/test_performance.sh
#
# The ordinary browser gate runs the same test against the development binary
# as a smoke check. That binary is compiled without optimization on purpose so
# the browser suites stay affordable to iterate on, and an unoptimized Crystal
# JSON parser is several times slower than the one in the release build. That
# difference dominated every protocol reply and made snapshot extraction look
# slower than the JavaScript reference even though the extraction work is the
# same. The shipped artifact is the optimized one, so this script builds it
# into bin/tawb-performance and measures that against the reference with the
# release budgets: 20% extraction latency, the same target as every other
# browser-bound phase.
#
# TAWB_SKIP_BUILD=1 keeps a binary an earlier run built; TAWB_CRYSTAL_BIN
# names a different one. Every other knob the corpus understands
# (TAWB_PERF_ONLY, TAWB_PERF_ENGINE, TAWB_PERF_REVERSE) passes through the
# environment unchanged.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

BINARY=${TAWB_CRYSTAL_BIN:-bin/tawb-performance}
if [ -z "${TAWB_SKIP_BUILD:-}" ]; then
  TAWB_RELEASE_BUILD=1 tools/build_crystal.sh "$BINARY"
fi
tools/verify_crystal_build.sh "$BINARY"

export TAWB_CRYSTAL_BIN="$BINARY"
export TAWB_TEST_CRYSTAL_BROWSER=1
export TAWB_A11Y_BUS=private
# Select the release budgets and make the test report which artifact it read.
export TAWB_PERF_RELEASE=1

# The private bus, isolated process tree and skip reporter are the same ones
# the ordinary browser gate uses, so a performance failure is reported by the
# same rule that turns an unexpected skip into a failure.
exec tools/run_isolated.sh node --test --test-concurrency=1 \
  --test-reporter=spec \
  --test-reporter="$ROOT/tools/fail_on_skips_reporter.js" \
  --test-reporter-destination=stdout \
  --test-reporter-destination=stderr \
  test/browser/crystal_performance.test.js "$@"
