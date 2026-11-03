#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

CRYSTAL=${CRYSTAL:-crystal}
OUTPUT=${1:-bin/tawb}

for tool in "$CRYSTAL" file readelf; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "build_crystal: $tool is required" >&2
    exit 1
  fi
done

# An HTTP client brings TLS and compression into the link. The system may
# provide only shared OpenSSL and zlib, so the pinned static copies from
# tools/deps.yml are used when the source asks for HTTP. TAWB_WITH_HTTP=1 can
# force that path for a test build before the source itself starts requiring
# it.
NEEDS_HTTP=${TAWB_WITH_HTTP:-0}
if grep -RqsE '^[[:space:]]*require "(http/|openssl|compress/|zlib)' crystal/src; then
  NEEDS_HTTP=1
fi

LINK_FLAGS=
if [ "$NEEDS_HTTP" = 1 ]; then
  if ! command -v pkg-config >/dev/null 2>&1; then
    echo "build_crystal: pkg-config is required for the static HTTP client" >&2
    exit 1
  fi
  tools/build_deps.sh all
  OPENSSL_PC=$(tools/build_deps.sh pkgconfig openssl)
  ZLIB_PC=$(tools/build_deps.sh pkgconfig zlib)
  OPENSSL_LIB=$(tools/build_deps.sh libdir openssl)
  ZLIB_LIB=$(tools/build_deps.sh libdir zlib)
  PKG_CONFIG_PATH="$OPENSSL_PC:$ZLIB_PC${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  export PKG_CONFIG_PATH
  LINK_FLAGS="-L$OPENSSL_LIB -L$ZLIB_LIB"
fi

mkdir -p "$(dirname -- "$OUTPUT")"
set -- --static --release --no-debug
if [ -n "$LINK_FLAGS" ]; then
  set -- "$@" --link-flags "$LINK_FLAGS"
fi
set -- "$@" -o "$OUTPUT" crystal/src/tawb.cr
"$CRYSTAL" build "$@"

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
