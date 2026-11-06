#!/bin/sh
set -eu

# Apply one named regression at a time to a scratch copy of HEAD, rebuild, and
# require the gate that claims to cover the behaviour to fail. A survivor is a
# coverage gap, not a passing test: this is the measurement that turns the
# parity manifest from a list of assertions into a claim about what the suite
# can actually detect.
#
#   tools/test_mutations.sh                    # every implemented mutation
#   tools/test_mutations.sh live-refresh-guard # one of them
#   TAWB_MUTATION_ROTATE=1 tools/test_mutations.sh  # one, chosen by the day
#   TAWB_MUTATION_KEEP=1 tools/test_mutations.sh   # keep logs and builds
#
# The scratch tree shares node_modules and build/deps with the checkout, so a
# mutation pays for the Crystal compile and the gate, not for another copy of
# the dependency build. Nothing outside the scratch directory is modified.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo 'test_mutations: python3 is required' >&2
  exit 1
fi

all=$(python3 tools/mutations.py names)
if [ "$#" -gt 0 ]; then
  selected=$*
elif [ "${TAWB_MUTATION_ROTATE:-}" = 1 ]; then
  day=$(date +%j)
  day=$((10#$day))
  count=$(printf '%s\n' "$all" | wc -l)
  selected=$(printf '%s\n' "$all" | sed -n "$((day % count + 1))p")
else
  selected=$all
fi

echo 'Mutations:'
python3 tools/mutations.py list
echo

scratch=$(mktemp -d "${TMPDIR:-/tmp}/tawb-mutations.XXXXXX")
cleanup() {
  if [ "${TAWB_MUTATION_KEEP:-}" = 1 ]; then
    echo "Kept mutation trees under $scratch"
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT HUP INT TERM

# The gate each mutation is required to break. Keeping the commands here means
# adding a mutation is two edits: the source transform in mutations.py and the
# gate it is supposed to break.
run_gate() {
  name=$1
  work=$2
  case $name in
    privileged-media)
      ( cd "$work" && env \
          TAWB_TEST_CRYSTAL=1 \
          TAWB_TEST_CRYSTAL_BROWSER=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          TAWB_A11Y_BUS=private \
          tools/run_isolated.sh node --test --test-concurrency=1 \
            --test-reporter=spec \
            --test-reporter="$work/tools/fail_on_skips_reporter.js" \
            --test-reporter-destination=stdout \
            --test-reporter-destination=stderr \
            test/browser/crystal_media.test.js )
      ;;
    native-control-field)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/block_parity.test.js )
      ;;
    live-refresh-guard)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/live_crystal.test.js )
      ;;
    browser-discovery)
      ( cd "$work" && node --test test/crystal_coverage.test.js )
      ;;
    handle-dispose)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/firefox_handle_crystal.test.js )
      ;;
    scroll-region-reset)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/reader_crystal.test.js )
      ;;
    frame-target-top)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/firefox_handle_crystal.test.js )
      ;;
    navigation-subscription)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh --test-name-pattern='Crystal follows navigation' \
            test/core_crystal.test.js )
      ;;
    early-status-fallback)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/reader_browse_crystal.test.js )
      ;;
    keymap-action)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh test/keys_crystal.test.js )
      ;;
    update-rename-failure)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh --test-name-pattern='replacement the filesystem refuses' \
            test/update_crystal.test.js )
      ;;
    typed-row-generation)
      ( cd "$work" && env \
          TAWB_SKIP_BUILD=1 TAWB_TEST_CRYSTAL=1 \
          TAWB_CRYSTAL_BIN="$work/bin/tawb" \
          tools/test_crystal.sh --test-name-pattern='write during a browser edit' \
            test/reader_modes_crystal.test.js )
      ;;
    *)
      echo "test_mutations: no gate for $name" >&2
      return 2
      ;;
  esac
}

caught=0
survived=0
errored=0

for name in $selected; do
  work="$scratch/$name"
  mkdir -p "$work"
  ( cd "$ROOT" && git archive HEAD ) | tar -x -C "$work"
  # A scratch tree is not a git checkout; keep the parts of the build that are
  # not this checkout's to recreate.
  ln -s "$ROOT/node_modules" "$work/node_modules"
  ln -s "$ROOT/build" "$work/build"

  echo "==> $name"
  if ! python3 tools/mutations.py apply "$name" "$work"; then
    echo "    could not apply the mutation" >&2
    errored=$((errored + 1))
    continue
  fi

  if [ "$(python3 tools/mutations.py needs-build "$name")" = yes ]; then
    printf '    building the mutated tree\n'
    # A scratch tree has no .git, but revision.cr asks Git for the commit
    # during compilation. Point it at this checkout's history; the source
    # being compiled is still the mutated scratch copy.
    if ! ( cd "$work" && env GIT_DIR="$ROOT/.git" tools/build_crystal.sh bin/tawb ) >"$work/build.log" 2>&1; then
      echo "    the mutation did not build; see $work/build.log" >&2
      errored=$((errored + 1))
      continue
    fi
  fi

  printf '    expecting its gate to fail\n'
  set +e
  run_gate "$name" "$work" >"$work/gate.log" 2>&1
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "    SURVIVED: the gate still passes"
    survived=$((survived + 1))
  else
    echo "    caught (gate exited $status)"
    caught=$((caught + 1))
  fi
done

printf '\ncaught %d, survived %d, errored %d\n' "$caught" "$survived" "$errored"
[ "$survived" -eq 0 ] && [ "$errored" -eq 0 ]
