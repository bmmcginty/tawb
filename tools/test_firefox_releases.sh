#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOCKERFILE="$ROOT/containers/firefox-upgrade/Dockerfile"
LOG_ROOT=${TAWB_FIREFOX_LOG_DIR:-"$ROOT/firefox-diagnostics"}
MEMORY=${TAWB_FIREFOX_MEMORY:-1536m}
SHM_SIZE=${TAWB_FIREFOX_SHM_SIZE:-256m}
PIDS_LIMIT=${TAWB_FIREFOX_PIDS_LIMIT:-256}
CPUS=${TAWB_FIREFOX_CPUS:-2}

if [ "$#" -eq 0 ]; then
  set -- stable beta nightly
fi

mkdir -p "$LOG_ROOT"
LOG_ROOT=$(CDPATH= cd -- "$LOG_ROOT" && pwd)
revision=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf unknown)
refresh=$(date -u +%Y%m%dT%H%M%SZ)
failed=0

for channel in "$@"; do
  case "$channel" in
    stable|beta|nightly) ;;
    *)
      printf 'Unknown Firefox channel: %s (use stable, beta, or nightly)\n' "$channel" >&2
      exit 2
      ;;
  esac

  image="tawb-firefox-diagnostic:$channel"
  channel_logs="$LOG_ROOT/$refresh/$channel"
  mkdir -p "$channel_logs"
  # The image runs as its unprivileged node user. A bind mount keeps the log
  # retrievable even when that uid differs from the host user running Docker.
  chmod 0777 "$channel_logs"

  printf '\n==> Building latest Firefox %s\n' "$channel"
  if ! docker build --pull \
    --file "$DOCKERFILE" \
    --build-arg "FIREFOX_CHANNEL=$channel" \
    --build-arg "FIREFOX_REFRESH=$refresh" \
    --build-arg "TAWB_IMAGE_REVISION=$revision-firefox-$channel" \
    --tag "$image" \
    "$ROOT"; then
    failed=1
    continue
  fi

  printf '\n==> Diagnosing Firefox %s (memory=%s, shm=%s)\n' \
    "$channel" "$MEMORY" "$SHM_SIZE"
  run_ok=1
  if ! docker run --rm --init \
    --memory "$MEMORY" \
    --memory-swap "$MEMORY" \
    --shm-size "$SHM_SIZE" \
    --pids-limit "$PIDS_LIMIT" \
    --cpus "$CPUS" \
    --volume "$channel_logs:/logs" \
    "$image"; then
    failed=1
    run_ok=0
  fi

  # Diagnostic mode deliberately continues after a true webdriver flag so it
  # can collect the rest of its report. A release-matrix run is a test, so its
  # authoritative startup reading must be false or this channel fails.
  report=$(find "$channel_logs" -maxdepth 1 -type f -name '.tawb.*.log' | sort | tail -n 1)
  if [ "$run_ok" -eq 1 ] \
      && { [ -z "$report" ] \
        || ! grep -q '"event":"firefox.ready".*"webdriver":false' "$report"; }; then
    printf 'Firefox %s did not produce a successful webdriver check in its diagnostic log.\n' \
      "$channel" >&2
    failed=1
  fi
done

printf '\nFirefox diagnostic logs: %s\n' "$LOG_ROOT"
exit "$failed"
