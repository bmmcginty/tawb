#!/bin/sh
set -u

# The long-running qualification gates the parity plan still has open.
#
#   script -q -c ./long-tests.sh script.log      # capture the run
#   ./long-tests.sh
#   TAWB_LONG_PHASES=soak ./long-tests.sh        # one phase
#   TAWB_LONG_DRY=1 ./long-tests.sh              # print the plan, run nothing
#   ./long-tests.sh --list                       # phases and prerequisites
#
# Phases, in the order they run:
#
#   soak     tools/test_soak.sh: one hour per runtime on a page that keeps
#            mutating while the reader is driven through movement, refresh and
#            activation. Descriptors, resident memory, process count,
#            responsiveness and cleanup are asserted for the whole run.
#
#   matrix   tools/test_release_matrix.sh: the exact candidate artifact built
#            from HEAD, verified, then run through every discovered browser
#            differential in distribution Chromium, distribution Firefox, the
#            Mozilla stable, beta and nightly archives, the Flatpak sandbox,
#            and a no-desktop Xvfb environment.
#
#   cycles   The release gate twice, as a rehearsal of the two-release-cycle
#            item: npm test, the native/JavaScript differentials, the full
#            browser differentials on Chromium and on Firefox, the performance
#            corpus on the optimized artifact, the no-Node artifact check, and
#            a parity-manifest status report. A script cannot produce two
#            shipped releases, so this phase is evidence for the gates, not for
#            the calendar: the item still needs two releases that actually
#            shipped with no unexplained parity incident.
#
# Each phase writes its own log under long-tests/<UTC timestamp>/ and prints
# one line per step to this terminal, so script.log stays readable while the
# detail is retained. A phase that fails does not stop the later phases: the
# point of a long run is the whole picture, and the summary says exactly which
# step failed and where its log is.
#
# Interrupting the run (Ctrl-C, SIGTERM, SIGHUP) stops the step that is running
# and everything it started, gives it up to 30 seconds to close its browsers,
# records the step as interrupted, and still writes SUMMARY.txt and
# summary.json for the steps that did finish.
#
# Knobs:
#
#   TAWB_LONG_PHASES        default "soak,matrix,cycles" (comma separated)
#   TAWB_LONG_CYCLES        default 2
#   TAWB_LONG_PERFORMANCE   default 1; include the performance corpus per cycle
#   TAWB_LONG_JS            default 0; also run the JavaScript-only browser
#                           suites per engine (npm run test:browser)
#   TAWB_SOAK_MS            default 3600000 (one hour per runtime, minimum 60000)
#   TAWB_LONG_LOG           default long-tests/<stamp>
#   TAWB_LONG_DRY           1 prints every command without running it
#   TAWB_LONG_MATRIX_TIMEOUT  default 21600 seconds for the whole matrix
#
# Anything already understood by a gate is passed through unchanged, including
# TAWB_MATRIX_ONLY, TAWB_MATRIX_ALLOW_MISSING, TAWB_MATRIX_LOG,
# TAWB_MATRIX_ARTIFACT, TAWB_PERF_ONLY, TAWB_PERF_ENGINE and TAWB_SKIP_BUILD.
#
# Not included, because they are not the three open items and each is its own
# milestone gate: tools/test_mutations.sh (full set before retirement) and
# tools/test_firefox_releases.sh (the Firefox diagnostic containers).

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

PHASES=${TAWB_LONG_PHASES:-soak,matrix,cycles}
CYCLES=${TAWB_LONG_CYCLES:-2}
PERFORMANCE=${TAWB_LONG_PERFORMANCE:-1}
JS_SUITES=${TAWB_LONG_JS:-0}
SOAK_MS=${TAWB_SOAK_MS:-3600000}
DRY=${TAWB_LONG_DRY:-0}
MATRIX_TIMEOUT=${TAWB_LONG_MATRIX_TIMEOUT:-21600}
MODE=run

usage() {
  sed -n '4,58p' "$0" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --help|-h)
      usage
      exit 0
      ;;
    --list)
      MODE=list
      shift
      ;;
    --dry-run)
      DRY=1
      shift
      ;;
    *)
      printf 'long-tests: unknown option: %s (see --help)\n' "$1" >&2
      exit 2
      ;;
  esac
done

ALL_PHASES='soak matrix cycles'
selected_phase() {
  case ",$PHASES," in
    *",$1,"*) return 0 ;;
  esac
  return 1
}

for phase in $(printf '%s\n' "$PHASES" | tr ',' ' '); do
  known=0
  for candidate in $ALL_PHASES; do
    [ "$phase" = "$candidate" ] && known=1
  done
  if [ "$known" = 0 ]; then
    printf 'long-tests: unknown phase: %s (known: %s)\n' "$phase" "$ALL_PHASES" >&2
    exit 2
  fi
done

if ! printf '%s' "$SOAK_MS" | grep -q '^[0-9]\+$'; then
  printf 'long-tests: TAWB_SOAK_MS must be a number of milliseconds\n' >&2
  exit 2
fi
if ! printf '%s' "$CYCLES" | grep -q '^[0-9]\+$' || [ "$CYCLES" -lt 1 ]; then
  printf 'long-tests: TAWB_LONG_CYCLES must be a positive number\n' >&2
  exit 2
fi

have() { command -v "$1" >/dev/null 2>&1; }

# --- phases and prerequisites ----------------------------------------------

if [ "$MODE" = list ]; then
  cat <<'EOF'
phases, in default order:

  soak     one hour per runtime of live/idle/action soak, growth and cleanup
           prerequisites: node, crystal, tmux, a browser, a display or xvfb-run
           time: about two hours plus build and setup

  matrix   the release artifact in every release environment
           prerequisites: node, crystal, curl, tar, docker, chromium, firefox,
           a display or xvfb-run (Flatpak needs a reachable Docker daemon)
           time: one built artifact, then the whole differential suite once per
           environment

  cycles   the release gate, rehearsed TAWB_LONG_CYCLES times
           prerequisites: node, crystal, chromium, firefox, bwrap, tput,
           a display or xvfb-run
           time: one gate per cycle, plus a release build for the performance
           corpus

environment:

  TAWB_LONG_PHASES, TAWB_LONG_CYCLES, TAWB_LONG_PERFORMANCE, TAWB_LONG_JS,
  TAWB_SOAK_MS, TAWB_LONG_LOG, TAWB_LONG_DRY, TAWB_LONG_MATRIX_TIMEOUT
EOF
  exit 0
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG_ROOT=${TAWB_LONG_LOG:-$ROOT/long-tests/$STAMP}
RESULTS="$LOG_ROOT/results.tsv"
ENVIRONMENT="$LOG_ROOT/environment.txt"
SUMMARY="$LOG_ROOT/SUMMARY.txt"

say() { printf '%s\n' "$*"; }
warn() { printf 'long-tests: %s\n' "$*" >&2; }

display_mode='real display'
if [ -z "${DISPLAY:-}" ]; then
  if have xvfb-run; then
    display_mode='no DISPLAY: browser steps run under xvfb-run -a'
  else
    display_mode='no DISPLAY and no xvfb-run: browser steps will fail'
  fi
fi

if [ "$DRY" != 1 ]; then
  mkdir -p "$LOG_ROOT"
  LOG_ROOT=$(CDPATH= cd -- "$LOG_ROOT" && pwd)
  RESULTS="$LOG_ROOT/results.tsv"
  ENVIRONMENT="$LOG_ROOT/environment.txt"
  SUMMARY="$LOG_ROOT/SUMMARY.txt"
  : > "$RESULTS"
fi

say '==> Preflight'
revision=$(tools/version.py revision 2>/dev/null || printf 'unknown')
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')
say "    revision:     $revision"
say "    branch:       $branch ($(git rev-parse --short HEAD 2>/dev/null || printf 'unknown'))"
changed=$(git status --porcelain --untracked-files=no 2>/dev/null || true)
if [ -n "$changed" ]; then
  say '    working tree: tracked files are modified (the gates verify the'
  say '                  committed revision, not uncommitted edits)'
  printf '%s\n' "$changed" | sed 's/^/                  /'
else
  say '    working tree: clean tracked files'
fi
say "    display:      $display_mode"

missing=''
check_tool() { # name, needed-by
  if have "$1"; then
    printf '    %-12s ok' "$1"
    version=$("$1" --version 2>/dev/null | head -n 1 || true)
    [ -n "$version" ] && printf ' (%s)' "$version"
    printf '\n'
  else
    printf '    %-12s MISSING (needed by %s)\n' "$1" "$2"
    missing="$missing $1($2)"
  fi
}

check_tool node 'every phase'
check_tool npm 'cycles'
check_tool git 'every phase'
check_tool crystal 'every phase'
check_tool file 'every build'
check_tool readelf 'every build'
check_tool sha256sum 'the matrix summary'
check_tool tmux 'soak'
check_tool chromium 'matrix, cycles'
check_tool firefox 'matrix, cycles'
check_tool curl 'matrix (Mozilla archives)'
check_tool tar 'matrix (Mozilla archives)'
check_tool docker 'matrix (Flatpak)'
check_tool bwrap 'cycles (no-Node artifact)'
check_tool tput 'cycles (no-Node artifact)'
if [ -z "${DISPLAY:-}" ]; then
  check_tool xvfb-run 'browser steps with no DISPLAY'
fi

if have docker; then
  # The matrix reaches the daemon through /run/docker.sock when that is the
  # only socket on the machine, so the preflight asks the same way instead of
  # warning about a daemon the Flatpak environment will actually find.
  docker_host=${DOCKER_HOST:-}
  if [ -z "$docker_host" ] && [ -S /run/docker.sock ] && [ ! -S /var/run/docker.sock ]; then
    docker_host=unix:///run/docker.sock
  fi
  if ! DOCKER_HOST=$docker_host docker info >/dev/null 2>&1; then
    say '    docker       installed, but the daemon is not reachable: the'
    say '                 Flatpak environment will be reported unavailable'
  fi
fi

if have curl; then
  if ! curl -fsI --max-time 15 https://download.mozilla.org/ >/dev/null 2>&1; then
    say '    network      download.mozilla.org is unreachable: the stable,'
    say '                 beta and nightly archive environments will fail'
  fi
fi

free_kb=$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 { print $4 }')
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt 5242880 ]; then
  say "    disk         only $((free_kb / 1024)) MiB free: the Firefox archives,"
  say '                 builds and logs may not fit'
fi

if [ -n "$missing" ]; then
  warn "missing tools:$missing"
  warn 'phases that need them will fail; the rest still run'
fi

if [ -n "${TAWB_MATRIX_ARTIFACT:-}" ]; then
  say "    matrix       will qualify TAWB_MATRIX_ARTIFACT=$TAWB_MATRIX_ARTIFACT"
else
  say '    matrix       will build bin/tawb-release from HEAD and verify it'
fi

if [ "$DRY" != 1 ]; then
  {
    printf 'generated: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'revision: %s\n' "$revision"
    printf 'branch: %s\n' "$branch"
    printf 'kernel: %s\n' "$(uname -srm)"
    printf 'display: %s\n' "$display_mode"
    printf 'node: %s\n' "$(node --version 2>/dev/null || printf missing)"
    printf 'crystal: %s\n' "$(crystal --version 2>/dev/null | head -n 1 || printf missing)"
    printf 'chromium: %s\n' "$(chromium --version 2>/dev/null | head -n 1 || printf missing)"
    printf 'firefox: %s\n' "$(firefox --version 2>/dev/null | head -n 1 || printf missing)"
    printf 'phases: %s\n' "$PHASES"
    printf 'cycles: %s\n' "$CYCLES"
    printf 'soak-ms: %s\n' "$SOAK_MS"
    printf 'performance: %s\n' "$PERFORMANCE"
    printf 'javascript-suites: %s\n' "$JS_SUITES"
    printf 'long-tests: %s\n' "$ROOT/long-tests.sh"
  } > "$ENVIRONMENT"
fi

# --- step runner ------------------------------------------------------------

record() { # phase status seconds log
  [ "$DRY" = 1 ] && return 0
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$RESULTS"
}

format_seconds() {
  seconds=$1
  if [ "$seconds" -ge 3600 ]; then
    printf '%dh%02dm' $((seconds / 3600)) $(((seconds % 3600) / 60))
  elif [ "$seconds" -ge 60 ]; then
    printf '%dm%02ds' $((seconds / 60)) $((seconds % 60))
  else
    printf '%ds' "$seconds"
  fi
}

# Terminate a step and everything it started, children first, so a gate's
# browser, broker and profile helper are closed instead of orphaned when the
# step itself is only a wrapper around them.
terminate_tree() { # pid signal
  for child in $(ps -o pid= --ppid "$1" 2>/dev/null); do
    terminate_tree "$child" "$2"
  done
  kill -"$2" "$1" 2>/dev/null || true
}

# Ctrl-C must not throw away an hour of measurement, and it must not leave a
# browser running against a profile whose reader just died.
interrupted() {
  trap - INT TERM HUP
  say ''
  warn "stopped by SIG$1"
  if [ -n "${STEP_PID:-}" ] && kill -0 "$STEP_PID" 2>/dev/null; then
    say "    closing down $STEP_NAME (up to 30s)"
    terminate_tree "$STEP_PID" TERM
    waited=0
    while kill -0 "$STEP_PID" 2>/dev/null && [ "$waited" -lt 30 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    [ "$waited" -ge 30 ] && terminate_tree "$STEP_PID" KILL
  fi
  if [ -n "${STEP_TICKER:-}" ]; then
    kill "$STEP_TICKER" 2>/dev/null || true
  fi
  if [ -n "${STEP_NAME:-}" ]; then
    elapsed=$(( $(date +%s) - STEP_STARTED ))
    record "$STEP_NAME" interrupted "$elapsed" "$STEP_LOG"
  fi
  summary_body > "$SUMMARY" 2>/dev/null || true
  cat "$SUMMARY" 2>/dev/null || true
  exit 130
}

# run_step NAME LIMIT_SECONDS(0 = none) COMMAND...
run_step() {
  name=$1
  limit=$2
  shift 2

  # The wrapper is part of the plan: a dry run that hid the deadline and the
  # private display would not describe what a real run does.
  if [ "$limit" -gt 0 ] && have timeout; then
    set -- timeout "$limit" "$@"
  fi
  if [ -z "${DISPLAY:-}" ] && have xvfb-run; then
    set -- xvfb-run -a "$@"
  fi

  logfile="$LOG_ROOT/$name.log"

  say ''
  say "==> $name"
  say "    command: $*"
  say "    log:     $logfile"
  if [ "$limit" -gt 0 ]; then
    say "    limit:   $(format_seconds "$limit")"
  fi

  if [ "$DRY" = 1 ]; then
    say '    dry run: not executed'
    return 0
  fi

  started=$(date +%s)
  STEP_NAME=$name
  STEP_LOG=$logfile
  STEP_STARTED=$started
  "$@" > "$logfile" 2>&1 &
  STEP_PID=$!
  # A dot a minute says the step is alive without copying the gate's output.
  ( while :; do sleep 60; printf '.'; done ) &
  STEP_TICKER=$!
  wait "$STEP_PID"
  status=$?
  STEP_PID=
  kill "$STEP_TICKER" 2>/dev/null || true
  wait "$STEP_TICKER" 2>/dev/null || true
  STEP_TICKER=
  finished=$(date +%s)
  elapsed=$((finished - started))
  printf '\n'

  if [ "$status" -eq 0 ]; then
    record "$name" pass "$elapsed" "$logfile"
    say "    PASS in $(format_seconds "$elapsed")"
  else
    record "$name" fail "$elapsed" "$logfile"
    if [ "$status" -eq 124 ]; then
      say "    FAIL: exceeded the $(format_seconds "$limit") limit"
    else
      say "    FAIL (exit $status) after $(format_seconds "$elapsed")"
    fi
    say '    last lines of the log:'
    tail -n 30 "$logfile" 2>/dev/null | sed 's/^/      /'
  fi
  return "$status"
}

# The manifest is the retirement inventory, so its status counts are part of
# the evidence, not a pass/fail gate: most entries are still inventory-only and
# that is exactly what a release summary has to say out loud.
manifest_report() {
  name=$1
  logfile="$LOG_ROOT/$name.txt"
  say ''
  say "==> $name"
  say "    log:     $logfile"
  if [ "$DRY" = 1 ]; then
    say '    dry run: not executed'
    return 0
  fi
  if ! have node; then
    say '    skipped: node is required to read the manifest'
    record "$name" skipped 0 "$logfile"
    return 0
  fi
  if ! node - > "$logfile" 2>&1 <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('test/parity-manifest.json', 'utf8'));
const counts = {};
const open = [];
const settled = new Set(['covered', 'retired', 'intentional-difference']);
for (const entry of manifest.entries) {
  counts[entry.status] = (counts[entry.status] || 0) + 1;
  if (!settled.has(entry.status)) open.push(entry);
}
console.log(`manifest: ${manifest.entries.length} entries, version ${manifest.version}`);
for (const status of Object.keys(counts).sort()) {
  console.log(`  ${status}: ${counts[status]}`);
}
console.log(`  not covered/retired/intentional-difference: ${open.length}`);
for (const entry of open) {
  console.log(`    ${entry.status}\t${entry.kind}\t${entry.id}`);
}
NODE
  then
    say '    could not read test/parity-manifest.json'
    record "$name" fail 0 "$logfile"
    return 1
  fi
  # The counts and the size of the open list; the entries themselves stay in
  # the log so a summary line never hides what is still unclassified.
  grep -v '^    ' "$logfile" | sed 's/^/    /'
  record "$name" report 0 "$logfile"
}

# --- phases -----------------------------------------------------------------

run_soak() {
  # The soak test measures duration itself; the limit only catches a hang, and
  # two runtimes each need their full window plus build, setup and cleanup.
  limit=$(( (SOAK_MS / 1000) * 2 + 3600 ))
  run_step soak "$limit" env TAWB_SOAK_MS="$SOAK_MS" tools/test_soak.sh
}

run_matrix() {
  run_step matrix "$MATRIX_TIMEOUT" \
    env TAWB_MATRIX_LOG="$LOG_ROOT/matrix" tools/test_release_matrix.sh
}

run_cycle() {
  cycle=$1
  run_step "$cycle-npm" 1800 npm test
  run_step "$cycle-crystal" 2700 tools/test_crystal.sh
  run_step "$cycle-chromium" 9000 \
    env TWEB_TEST_BROWSER=chromium tools/test_crystal_browser.sh
  run_step "$cycle-firefox" 9000 \
    env TWEB_TEST_BROWSER=firefox tools/test_crystal_browser.sh
  if [ "$JS_SUITES" = 1 ]; then
    run_step "$cycle-js-chromium" 7200 \
      env TWEB_TEST_BROWSER=chromium npm run test:browser
    run_step "$cycle-js-firefox" 7200 \
      env TWEB_TEST_BROWSER=firefox npm run test:browser
  fi
  if [ "$PERFORMANCE" = 1 ]; then
    run_step "$cycle-performance" 7200 tools/test_performance.sh
  fi
  run_step "$cycle-no-node" 900 tools/test_no_node.sh
  manifest_report "$cycle-manifest"
}

# --- summary ----------------------------------------------------------------

summary_body() {
  say ''
  say '==> Summary'
  say "    revision: $revision ($branch)"
  if [ "$DRY" = 1 ]; then
    say '    dry run: nothing was executed'
    return 0
  fi
  say ''
  printf '    %-24s %-11s %-8s %s\n' PHASE RESULT ELAPSED LOG
  while IFS='	' read -r phase result seconds logfile; do
    printf '    %-24s %-11s %-8s %s\n' \
      "$phase" "$result" "$(format_seconds "$seconds")" "$logfile"
  done < "$RESULTS"

  passes=$(grep -c '	pass	' "$RESULTS" || true)
  failures=$(grep -c '	fail	' "$RESULTS" || true)
  others=$(grep -cv -e '	pass	' -e '	fail	' "$RESULTS" || true)
  say ''
  say "    steps: $passes passed, $failures failed, $others informational"
  if [ -n "${RUN_STARTED:-}" ]; then
    say "    wall clock: $(format_seconds $(( $(date +%s) - RUN_STARTED )))"
  fi

  if selected_phase soak; then
    if grep -q "^soak	pass	" "$RESULTS"; then
      say ''
      say "    P3 Long soak and leak tests: the $(format_seconds $((SOAK_MS / 1000)))"
      say '    per-runtime soak passed.'
      if [ "$SOAK_MS" -lt 3600000 ]; then
        say '    A run shorter than an hour per runtime is a smoke case, not the'
        say '    qualification the item asks for.'
      fi
    else
      say ''
      say '    P3 Long soak and leak tests: did not pass; see the soak log.'
    fi
  fi
  if selected_phase matrix; then
    if grep -q "^matrix	pass	" "$RESULTS"; then
      say ''
      say '    P4 Browser release matrix: every environment passed.'
    else
      say ''
      say '    P4 Browser release matrix: did not pass; the matrix log names'
      say '    each environment and the reason it failed or was unavailable.'
    fi
  fi
  if selected_phase cycles; then
    cycle_failures=$(grep -c "^cycle[0-9]*-.*	fail	" "$RESULTS" || true)
    if [ "$cycle_failures" -eq 0 ] && grep -q "^cycle1-npm	pass	" "$RESULTS"; then
      say ''
      say "    P4 two release cycles: the rehearsal of all $CYCLES cycles passed."
      say '    This is the gate evidence only. Two releases have to ship with'
      say '    no unexplained parity incident before the item is closed.'
    else
      say ''
      say "    P4 two release cycles: the rehearsal had $cycle_failures"
      say '    failing step(s); see the cycle logs above.'
    fi
  fi

  say ''
  say "    Logs and machine-readable result: $LOG_ROOT"
  say "    Hand back: script.log and $SUMMARY"
  return 0
}

if [ "$DRY" = 1 ]; then
  say ''
  say '==> Plan (dry run)'
  selected_phase soak && run_soak
  selected_phase matrix && run_matrix
  if selected_phase cycles; then
    index=1
    while [ "$index" -le "$CYCLES" ]; do
      run_cycle "cycle$index"
      index=$((index + 1))
    done
  fi
  say ''
  say 'Nothing was executed.'
  exit 0
fi

# --- run --------------------------------------------------------------------

RUN_STARTED=$(date +%s)
STEP_PID=
STEP_TICKER=
STEP_NAME=
trap 'interrupted INT' INT
trap 'interrupted TERM' TERM
trap 'interrupted HUP' HUP

selected_phase soak && run_soak
selected_phase matrix && run_matrix
if selected_phase cycles; then
  index=1
  while [ "$index" -le "$CYCLES" ]; do
    run_cycle "cycle$index"
    index=$((index + 1))
  done
fi

summary_body > "$SUMMARY"

TAWB_LONG_RESULTS="$RESULTS" \
TAWB_LONG_ENVIRONMENT="$ENVIRONMENT" \
TAWB_LONG_SUMMARY="$LOG_ROOT/summary.json" \
TAWB_LONG_LOG_ROOT="$LOG_ROOT" \
TAWB_LONG_REVISION="$revision" \
node - <<'NODE' >/dev/null 2>&1 || true
const fs = require('node:fs');
const rows = fs.readFileSync(process.env.TAWB_LONG_RESULTS, 'utf8')
  .split('\n').filter(Boolean).map((line) => {
    const [phase, status, seconds, log] = line.split('\t');
    return { phase, status, seconds: Number(seconds), log };
  });
const counts = {};
for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
fs.writeFileSync(process.env.TAWB_LONG_SUMMARY, JSON.stringify({
  generated: new Date().toISOString(),
  revision: process.env.TAWB_LONG_REVISION,
  logRoot: process.env.TAWB_LONG_LOG_ROOT,
  environment: process.env.TAWB_LONG_ENVIRONMENT,
  counts,
  steps: rows,
}, null, 2) + '\n');
NODE

cat "$SUMMARY"
if grep -q '	fail	' "$RESULTS"; then
  exit 1
fi
exit 0
