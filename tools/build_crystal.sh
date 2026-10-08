#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

CRYSTAL=${CRYSTAL:-crystal}
OUTPUT=${1:-dist/tawb-crystal}

for tool in "$CRYSTAL" file readelf; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "build_crystal: $tool is required" >&2
    exit 1
  fi
done

mkdir -p "$(dirname -- "$OUTPUT")"
"$CRYSTAL" build --static --release --no-debug -o "$OUTPUT" crystal/src/tawb.cr

if ! file "$OUTPUT" | grep -q 'statically linked'; then
  echo "build_crystal: output is not statically linked" >&2
  exit 1
fi
if readelf -lW "$OUTPUT" | grep -q ' INTERP '; then
  echo "build_crystal: output has an ELF interpreter" >&2
  exit 1
fi
if readelf -dW "$OUTPUT" 2>/dev/null | grep -q ' NEEDED '; then
  echo "build_crystal: output has dynamic dependencies" >&2
  exit 1
fi

printf 'Built %s with Crystal %s\n' "$OUTPUT" "$("$CRYSTAL" --version | head -1 | awk '{print $2}')"
file "$OUTPUT"
