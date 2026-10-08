#!/bin/sh
set -eu

# Build the copy-one-file Linux release. Deno supplies a self-contained JS
# runtime; StaticX then wraps that glibc executable in a genuinely static,
# compressed launcher that extracts the original into a private temp directory.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

DENO=${DENO:-deno}
PYTHON=${PYTHON:-python3}
STATICX_VERSION=${STATICX_VERSION:-0.14.2}
case $(uname -m) in
  x86_64) default_name=tawb-linux-x64 ;;
  aarch64|arm64) default_name=tawb-linux-arm64 ;;
  *) echo "build_standalone: unsupported build architecture $(uname -m)" >&2; exit 1 ;;
esac
OUTPUT=${1:-dist/$default_name}

for tool in "$DENO" "$PYTHON" patchelf file; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "build_standalone: $tool is required" >&2
    exit 1
  fi
done

STATICX=${STATICX:-}
if [ -z "$STATICX" ]; then
  cache=${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/tawb/standalone
  venv="$cache/staticx-$STATICX_VERSION"
  STATICX="$venv/bin/staticx"
  if [ ! -f "$venv/.ready" ]; then
    mkdir -p "$cache"
    rm -rf "$venv"
    "$PYTHON" -m venv "$venv"
    "$venv/bin/pip" install "staticx==$STATICX_VERSION"
    touch "$venv/.ready"
  fi
fi

revision=$(git rev-parse --verify HEAD 2>/dev/null || printf unknown)
output_dir=$(dirname -- "$OUTPUT")
output_name=$(basename -- "$OUTPUT")
mkdir -p "$output_dir"
work=$(mktemp -d "$output_dir/.tawb-static.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
printf 'TAWB_COMMIT=%s\n' "$revision" >"$work/build.env"

"$DENO" compile \
  --no-check \
  --allow-all \
  --env-file="$work/build.env" \
  --include src \
  --output "$work/tawb-dynamic" \
  src/standalone.js
"$STATICX" "$work/tawb-dynamic" "$work/tawb-static"
chmod 755 "$work/tawb-static"
mv "$work/tawb-static" "$OUTPUT"

"$OUTPUT" --help >/dev/null
if ! file "$OUTPUT" | grep -q 'statically linked'; then
  echo "build_standalone: output is not a statically linked ELF" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$output_name" >"$output_name.sha256")
fi

printf 'Built %s with Deno %s and StaticX %s\n' \
  "$OUTPUT" "$("$DENO" --version | head -1 | awk '{print $2}')" "$STATICX_VERSION"
file "$OUTPUT"
