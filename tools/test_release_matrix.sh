#!/bin/sh
set -eu

# The browser release matrix, run against the exact artifact a release would
# publish.
#
#   tools/test_release_matrix.sh                 # every environment
#   TAWB_MATRIX_ONLY=chromium tools/test_release_matrix.sh
#   TAWB_MATRIX_ARTIFACT=bin/tawb tools/test_release_matrix.sh
#   tools/test_release_matrix.sh --plan          # what would run, and where
#   tools/test_release_matrix.sh --list          # environment names
#   tools/test_release_matrix.sh --test-name-pattern='one case'   # narrow
#
# A development binary built earlier in the job is not the release artifact.
# With no TAWB_MATRIX_ARTIFACT, this builds bin/tawb-release with
# TAWB_RELEASE_BUILD=1 and verifies that its reported revision is HEAD and that
# its embedded page programs still match their JavaScript sources, before any
# browser starts. Every environment then runs tools/test_crystal_browser.sh
# against that one artifact, with TAWB_SKIP_BUILD=1 so nothing rebuilds it
# halfway through the matrix.
#
# Environments:
#
#   chromium         the distribution Chromium
#   firefox          the distribution Firefox
#   firefox-stable   Mozilla's current stable Linux archive
#   firefox-beta     Mozilla's current beta Linux archive
#   firefox-nightly  Mozilla's current nightly Linux archive
#   flatpak          the real Flatpak sandbox (containers/flatpak-portal)
#   no-desktop       no DISPLAY, no session bus, no desktop environment variables
#
# The archive channels are downloaded through Mozilla's bouncer, which always
# names the newest build of that channel, into TAWB_MATRIX_CACHE. The resolved
# URL is kept beside the extracted tree, so a later run reuses the download
# only while the bouncer still names it; a stale cache layer cannot hide an
# upgrade.
#
# A missing engine is a failure, not a skip: the matrix cannot claim an
# environment it did not run. TAWB_MATRIX_ALLOW_MISSING=1 records it as
# unavailable and continues, which is for a development machine that wants the
# environments it does have. It never turns an unavailable engine into a pass,
# and a failed environment always fails the matrix.
#
# Every environment is run under tools/test_crystal_browser.sh, so the private
# accessibility bus, the skip reporter, the isolated process tree and the
# revision check are the gate's own. The summary names the exact test files
# selected, every environment with its status and browser version, and the
# artifact's revision and digest.

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

ALL_ENVIRONMENTS='chromium firefox firefox-stable firefox-beta firefox-nightly flatpak no-desktop'
ARTIFACT=${TAWB_MATRIX_ARTIFACT:-bin/tawb-release}
CACHE=${TAWB_MATRIX_CACHE:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/tawb/release-matrix}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG_ROOT=${TAWB_MATRIX_LOG:-$ROOT/release-matrix/$STAMP}
ALLOW_MISSING=${TAWB_MATRIX_ALLOW_MISSING:-0}
ARCHIVE_PLATFORM=${TAWB_MATRIX_PLATFORM:-linux64}

usage() {
  sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'
}

# Selected environments, in the order above. An unknown name is refused here
# rather than silently running nothing, because "the matrix passed" must mean
# the environments the plan names.
SELECTED=
for environment in $(printf '%s\n' "${TAWB_MATRIX_ONLY:-$ALL_ENVIRONMENTS}" | tr ',' ' '); do
  known=0
  for candidate in $ALL_ENVIRONMENTS; do
    [ "$environment" = "$candidate" ] && known=1
  done
  if [ "$known" = 0 ]; then
    printf 'test_release_matrix: unknown environment: %s (see --list)\n' "$environment" >&2
    exit 2
  fi
  SELECTED="$SELECTED $environment"
done

selected_environment() {
  for candidate in $SELECTED; do
    [ "$candidate" = "$1" ] && return 0
  done
  return 1
}

# Options come first. Everything after them is handed to every browser gate
# unchanged, exactly as tools/test_crystal_browser.sh accepts it (files, or
# node options like --test-name-pattern=...). A node option is recognised by
# its --test- prefix; a misspelt matrix option is refused instead of being
# passed on to a browser gate that would treat it as a file.
MODE=run
while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h)
      usage
      exit 0
      ;;
    --list)
      for environment in $ALL_ENVIRONMENTS; do
        printf '%s\n' "$environment"
      done
      exit 0
      ;;
    --plan)
      MODE=plan
      shift
      ;;
    --test-*)
      # A node test-runner option, kept for the gates. Use the = form for a
      # value with spaces: a bare value is a path to the gate, not a pattern.
      break
      ;;
    --*)
      printf 'test_release_matrix: unknown option: %s\n' "$1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done
test_selection() {
  tools/browser_tests.sh "$@"
}

if [ "$MODE" = plan ]; then
  printf 'artifact-build: TAWB_RELEASE_BUILD=1 tools/build_crystal.sh %s\n' "$ARTIFACT"
  printf 'artifact-verify: tools/verify_crystal_build.sh %s\n' "$ARTIFACT"
  test_selection "$@" | while IFS= read -r path; do
    case $path in
      *.test.js) printf 'test: %s\n' "$path" ;;
    esac
  done
  for argument in "$@"; do
    printf 'forward: %s\n' "$argument"
  done
  for environment in $SELECTED; do
    case $environment in
      chromium)
        printf 'environment: chromium engine=chromium browser=distribution desktop=yes\n'
        ;;
      firefox)
        printf 'environment: firefox engine=firefox browser=distribution desktop=yes\n'
        ;;
      firefox-stable|firefox-beta|firefox-nightly)
        printf 'environment: %s engine=firefox browser=mozilla-%s desktop=yes\n' \
          "$environment" "${environment#firefox-}"
        ;;
      flatpak)
        printf 'environment: flatpak engine=firefox browser=flatpak desktop=yes\n'
        ;;
      no-desktop)
        printf 'environment: no-desktop engine=chromium browser=distribution desktop=no\n'
        printf 'environment: no-desktop engine=firefox browser=distribution desktop=no\n'
        ;;
    esac
  done
  exit 0
fi

mkdir -p "$LOG_ROOT"
LOG_ROOT=$(CDPATH= cd -- "$LOG_ROOT" && pwd)
RESULTS="$LOG_ROOT/results.tsv"
: > "$RESULTS"

# --- browser discovery -----------------------------------------------------

find_command() {
  for name in "$@"; do
    if command -v "$name" >/dev/null 2>&1; then
      command -v "$name"
      return 0
    fi
  done
  return 1
}

browser_identity() {
  # The first line of --version, which is what both engines print.
  "$1" --version 2>/dev/null | head -n 1 || true
}

prepare_archive() {
  # Echo the directory to put first on PATH, or fail. The tree is extracted
  # once per bouncer URL and reused until the channel moves.
  channel=$1
  case $channel in
    stable) product=firefox-latest ;;
    beta) product=firefox-beta-latest ;;
    nightly) product=firefox-nightly-latest-ssl ;;
    *) return 1 ;;
  esac
  bouncer="https://download.mozilla.org/?product=$product&os=$ARCHIVE_PLATFORM&lang=en-US"
  resolved=$(curl -fsIL --retry 3 "$bouncer" 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's/^[Ll]ocation: *//p' \
    | tail -n 1) || resolved=
  if [ -z "$resolved" ]; then
    printf 'test_release_matrix: Mozilla bouncer did not resolve %s\n' "$channel" >&2
    return 1
  fi
  tree="$CACHE/firefox-$channel"
  shim="$tree/bin"
  if [ -x "$shim/firefox" ] && [ "$(cat "$tree/url" 2>/dev/null || true)" = "$resolved" ]; then
    printf '%s\n' "$shim"
    return 0
  fi
  rm -rf "$tree"
  mkdir -p "$tree"
  printf 'test_release_matrix: downloading Firefox %s from %s\n' "$channel" "$resolved" >&2
  if ! curl -fsL --retry 3 -o "$tree/download.tar.xz" "$resolved"; then
    rm -rf "$tree"
    return 1
  fi
  if ! tar -xJf "$tree/download.tar.xz" -C "$tree"; then
    rm -rf "$tree"
    return 1
  fi
  rm -f "$tree/download.tar.xz"
  if [ ! -x "$tree/firefox/firefox" ]; then
    printf 'test_release_matrix: %s did not contain firefox/firefox\n' "$resolved" >&2
    rm -rf "$tree"
    return 1
  fi
  mkdir -p "$shim"
  ln -sf "$tree/firefox/firefox" "$shim/firefox"
  printf '%s\n' "$resolved" > "$tree/url"
  printf '%s\n' "$shim"
}

# --- artifact --------------------------------------------------------------

if [ -z "${TAWB_MATRIX_ARTIFACT:-}" ]; then
  printf '==> Building the release artifact: %s\n' "$ARTIFACT"
  TAWB_RELEASE_BUILD=1 tools/build_crystal.sh "$ARTIFACT"
fi
if [ ! -x "$ARTIFACT" ]; then
  printf 'test_release_matrix: %s is not executable\n' "$ARTIFACT" >&2
  exit 2
fi
ARTIFACT=$(CDPATH= cd -- "$(dirname -- "$ARTIFACT")" && pwd)/$(basename -- "$ARTIFACT")

printf '==> Verifying %s against HEAD and its embedded page programs\n' "$ARTIFACT"
# This exits non-zero on a binary that is not this checkout, so a stale artifact
# cannot be qualified by a matrix run.
tools/verify_crystal_build.sh "$ARTIFACT"

REVISION=$(tools/version.py revision)
REPORTED=$($ARTIFACT --version)
DIGEST=$(sha256sum "$ARTIFACT" | cut -d' ' -f1)

TEST_FILES="$LOG_ROOT/tests.txt"
test_selection "$@" | grep '\.test\.js$' > "$TEST_FILES" || true
TEST_COUNT=$(grep -c . "$TEST_FILES" || true)
if [ "$TEST_COUNT" -eq 0 ]; then
  printf 'test_release_matrix: no browser differentials were selected\n' >&2
  exit 2
fi
printf '==> Selected %s browser differential files:\n' "$TEST_COUNT"
sed 's/^/    /' "$TEST_FILES"

# --- environment runners ---------------------------------------------------

SURVIVORS=1

record() {
  # name engine browser status seconds log version
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" >> "$RESULTS"
}

missing_environment() {
  # name engine reason
  printf 'test_release_matrix: %s [%s] unavailable: %s\n' "$1" "$2" "$3" >&2
  record "$1" "$2" - unavailable 0 "$LOG_ROOT/$1-$2.log" -
  if [ "$ALLOW_MISSING" = 1 ]; then
    printf '    recorded as unavailable; TAWB_MATRIX_ALLOW_MISSING=1 does not make it a pass\n' >&2
  else
    SURVIVORS=0
  fi
}

failed_environment() {
  # name engine log seconds reason
  printf 'test_release_matrix: %s [%s] FAILED in %ss — %s\n' \
    "$1" "$2" "$4" "$5" >&2
  tail -n 40 "$3" >&2 || true
  record "$1" "$2" - failed "$4" "$3" -
  SURVIVORS=0
}

# name engine browser desktop shim log [test args...]
run_gate() {
  name=$1
  engine=$2
  browser=$3
  desktop=$4
  shim=$5
  log=$6
  shift 6
  old_path=$PATH
  if [ -n "$shim" ]; then
    PATH="$shim:$PATH"
    export PATH
  fi
  if [ "$engine" = chromium ]; then
    version=$(browser_identity "$(find_command chromium chromium-browser google-chrome)")
  else
    version=$(browser_identity "$(command -v firefox)")
  fi
  started=$(date +%s)
  status=0
  if [ "$desktop" = no ]; then
    TWEB_TEST_BROWSER=$engine TAWB_CRYSTAL_BIN=$ARTIFACT TAWB_SKIP_BUILD=1 \
      env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
        -u DESKTOP_SESSION -u XDG_CURRENT_DESKTOP \
        xvfb-run -a tools/test_crystal_browser.sh "$@" > "$log" 2>&1 || status=$?
  else
    TWEB_TEST_BROWSER=$engine TAWB_CRYSTAL_BIN=$ARTIFACT TAWB_SKIP_BUILD=1 \
      tools/test_crystal_browser.sh "$@" > "$log" 2>&1 || status=$?
  fi
  PATH=$old_path
  export PATH
  finished=$(date +%s)
  elapsed=$((finished - started))
  if [ "$status" -eq 0 ]; then
    printf '==> %s [%s] passed in %ss (%s)\n' "$name" "$engine" "$elapsed" "$version"
    record "$name" "$engine" "$browser" passed "$elapsed" "$log" "$version"
  else
    failed_environment "$name" "$engine" "$log" "$elapsed" ''
  fi
}

if selected_environment chromium; then
  chromium=$(find_command chromium chromium-browser google-chrome 2>/dev/null || true)
  if [ -z "$chromium" ]; then
    missing_environment chromium chromium 'no distribution Chromium on PATH'
  else
    printf '==> chromium: %s (%s)\n' "$chromium" "$(browser_identity "$chromium")"
    run_gate chromium chromium distribution yes '' "$LOG_ROOT/chromium.log" "$@"
  fi
fi

if selected_environment firefox; then
  firefox=$(command -v firefox 2>/dev/null || true)
  if [ -z "$firefox" ]; then
    missing_environment firefox firefox 'no distribution Firefox on PATH'
  else
    printf '==> firefox: %s (%s)\n' "$firefox" "$(browser_identity "$firefox")"
    run_gate firefox firefox distribution yes '' "$LOG_ROOT/firefox.log" "$@"
  fi
fi

for channel in stable beta nightly; do
  environment="firefox-$channel"
  selected_environment "$environment" || continue
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    missing_environment "$environment" firefox 'curl and tar are required for the Mozilla archives'
    continue
  fi
  if ! shim=$(prepare_archive "$channel"); then
    missing_environment "$environment" firefox "the Firefox $channel archive could not be prepared"
    continue
  fi
  printf '==> %s: %s (%s)\n' "$environment" "$shim/firefox" "$(browser_identity "$shim/firefox")"
  run_gate "$environment" firefox "mozilla-$channel" yes "$shim" \
    "$LOG_ROOT/$environment.log" "$@"
done

if selected_environment flatpak; then
  log="$LOG_ROOT/flatpak.log"
  docker_host=${DOCKER_HOST:-}
  if [ -z "$docker_host" ] && [ -S /run/docker.sock ] && [ ! -S /var/run/docker.sock ]; then
    docker_host=unix:///run/docker.sock
  fi
  if ! command -v docker >/dev/null 2>&1; then
    missing_environment flatpak firefox 'docker is required for the Flatpak sandbox'
  else
    started=$(date +%s)
    status=0
    DOCKER_HOST=$docker_host containers/flatpak-portal/run.sh > "$log" 2>&1 || status=$?
    finished=$(date +%s)
    elapsed=$((finished - started))
    if [ "$status" -eq 0 ]; then
      printf '==> flatpak [firefox] passed in %ss\n' "$elapsed"
      record flatpak firefox flatpak passed "$elapsed" "$log" 'org.mozilla.firefox (flatpak)'
    else
      failed_environment flatpak firefox "$log" "$elapsed" ''
    fi
  fi
fi

if selected_environment no-desktop; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    missing_environment no-desktop chromium 'xvfb-run is required to run without a desktop'
    missing_environment no-desktop firefox 'xvfb-run is required to run without a desktop'
  else
    # No DISPLAY, no session bus, no desktop environment; the gate starts its
    # own private accessibility bus, which is what a terminal on a machine
    # with no desktop gets.
    chromium=$(find_command chromium chromium-browser google-chrome 2>/dev/null || true)
    if [ -z "$chromium" ]; then
      missing_environment no-desktop chromium 'no distribution Chromium on PATH'
    else
      run_gate no-desktop chromium distribution no '' \
        "$LOG_ROOT/no-desktop-chromium.log" "$@"
    fi
    firefox=$(command -v firefox 2>/dev/null || true)
    if [ -z "$firefox" ]; then
      missing_environment no-desktop firefox 'no distribution Firefox on PATH'
    else
      run_gate no-desktop firefox distribution no '' \
        "$LOG_ROOT/no-desktop-firefox.log" "$@"
    fi
  fi
fi

# --- summary ---------------------------------------------------------------

TAWB_MATRIX_RESULTS=$RESULTS \
TAWB_MATRIX_TESTS=$TEST_FILES \
TAWB_MATRIX_SUMMARY="$LOG_ROOT/summary.json" \
TAWB_MATRIX_REVISION=$REVISION \
TAWB_MATRIX_ARTIFACT=$ARTIFACT \
TAWB_MATRIX_VERSION=$REPORTED \
TAWB_MATRIX_DIGEST=$DIGEST \
TAWB_MATRIX_SELECTED="$SELECTED" \
node -e '
  const fs = require("fs");
  const rows = fs.readFileSync(process.env.TAWB_MATRIX_RESULTS, "utf8")
    .split("\n").filter(Boolean).map((line) => {
      const [environment, engine, browser, status, seconds, log, version] = line.split("\t");
      return { environment, engine, browser, status,
        seconds: Number(seconds), log, browserVersion: version };
    });
  const tests = fs.readFileSync(process.env.TAWB_MATRIX_TESTS, "utf8")
    .split("\n").filter(Boolean);
  const summary = {
    generated: new Date().toISOString(),
    revision: process.env.TAWB_MATRIX_REVISION,
    artifact: {
      path: process.env.TAWB_MATRIX_ARTIFACT,
      version: process.env.TAWB_MATRIX_VERSION,
      sha256: process.env.TAWB_MATRIX_DIGEST,
    },
    selected: process.env.TAWB_MATRIX_SELECTED.split(" ").filter(Boolean),
    tests,
    environments: rows,
  };
  fs.writeFileSync(process.env.TAWB_MATRIX_SUMMARY, JSON.stringify(summary, null, 2) + "\n");
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  console.log(`Summary: ${process.env.TAWB_MATRIX_SUMMARY}`);
  for (const row of rows) {
    console.log(`${row.status.padEnd(12)} ${row.environment} [${row.engine}] ${row.browserVersion}`);
  }
  console.log(`Counts: ${JSON.stringify(counts)}`);
'

if [ "$SURVIVORS" -ne 1 ]; then
  printf '\nThe release matrix did not pass. Logs: %s\n' "$LOG_ROOT" >&2
  exit 1
fi

printf '\nThe release matrix passed. Logs and summary: %s\n' "$LOG_ROOT"
