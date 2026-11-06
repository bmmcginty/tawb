#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if [ -z "${TAWB_SKIP_BUILD:-}" ]; then
  tools/build_crystal.sh
fi
tools/verify_crystal_build.sh

command -v bwrap >/dev/null 2>&1 || {
  echo "test_no_node: bubblewrap is required to construct the no-Node root" >&2
  exit 1
}

TPUT=$(command -v tput) || {
  echo "test_no_node: tput is required by the terminal executable" >&2
  exit 1
}
LOADER=/lib64/ld-linux-x86-64.so.2
[ -e "$LOADER" ] || {
  echo "test_no_node: unsupported dynamic-loader location: $LOADER" >&2
  exit 1
}

sandbox() {
  bwrap \
    --ro-bind "$ROOT/bin/tawb" /tawb \
    --dir /bin \
    --ro-bind "$TPUT" /bin/tput \
    --ro-bind /usr/lib /usr/lib \
    --dir /lib64 \
    --ro-bind "$(readlink -f "$LOADER")" "$LOADER" \
    --ro-bind /usr/share/terminfo /usr/share/terminfo \
    --dir /home --dir /home/test \
    --dev /dev --proc /proc --tmpfs /tmp \
    --setenv HOME /home/test \
    --setenv PATH /bin \
    --setenv TERM xterm \
    /tawb "$@"
}

# /bin contains only tput: there is no node, npm, shell, or JavaScript entry
# point available to satisfy an accidental runtime dependency.
version=$(sandbox --version)
help=$(sandbox --help)
[ -n "$version" ]
printf '%s\n' "$help" | grep -q '^Usage:'
printf 'No-Node artifact passed: %s\n' "$version"
