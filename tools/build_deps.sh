#!/bin/sh
# Build the pinned static dependencies TAWB needs when its Crystal source uses
# an HTTP client. Versions and hashes live in tools/deps.yml.
#
# The build lands in build/deps by default:
#
#   build/deps/downloads/       verified source archives
#   build/deps/src/             extracted and built source trees
#   build/deps/prefix/<name>/   installed static libraries and pkg-config files
#   build/deps/logs/            configure/build logs
#
# Set TAWB_DEPS_DIR to keep that cache somewhere else, and
# TAWB_DEPS_REBUILD=1 to discard and rebuild a dependency.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEPS_FILE=${TAWB_DEPS_FILE:-"$ROOT/tools/deps.yml"}
DEPS_DIR=${TAWB_DEPS_DIR:-"$ROOT/build/deps"}
JOBS=${TAWB_DEPS_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')}

case $JOBS in
  ''|*[!0-9]*) JOBS=1 ;;
esac

die() {
  printf 'build_deps: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: tools/build_deps.sh [all|openssl|zlib]
       tools/build_deps.sh prefix NAME
       tools/build_deps.sh libdir NAME
       tools/build_deps.sh pkgconfig NAME

With no dependency named, builds OpenSSL and zlib. The other forms print the
cache paths build_crystal.sh needs. TAWB_DEPS_DIR changes the cache directory;
TAWB_DEPS_JOBS sets the parallel make jobs; TAWB_DEPS_FILE overrides
tools/deps.yml; TAWB_DEPS_REBUILD=1 rebuilds a dependency that is already
cached.
USAGE
}

# The dependency file is deliberately a small, flat YAML document. This reads
# one scalar field without requiring PyYAML on a machine that only has Python
# for the release tools, and without making the build depend on yq.
dep_field() {
  section=$1
  field=$2
  [ -f "$DEPS_FILE" ] || die "missing dependency file $DEPS_FILE"
  awk -v section="$section:" -v field="$field:" '
    /^[[:space:]]*#/ { next }
    /^[^[:space:]]/ {
      inside = ($1 == section)
      next
    }
    inside && $1 == field {
      sub(/^[^:]*:[[:space:]]*/, "", $0)
      sub(/[[:space:]]*#.*$/, "", $0)
      if ($0 ~ /^".*"$/ || $0 ~ /^\047.*\047$/) {
        $0 = substr($0, 2, length($0) - 2)
      }
      print $0
      exit
    }
  ' "$DEPS_FILE"
}

dep_prefix() {
  name=$1
  version=$(dep_field "$name" version)
  [ -n "$version" ] || die "$name has no version in $DEPS_FILE"
  printf '%s/prefix/%s-%s\n' "$DEPS_DIR" "$name" "$version"
}

dep_source() {
  name=$1
  version=$(dep_field "$name" version)
  printf '%s/src/%s-%s\n' "$DEPS_DIR" "$name" "$version"
}

dep_libdir() {
  name=$1
  prefix=$(dep_prefix "$name")
  for dir in "$prefix/lib" "$prefix/lib64"; do
    [ -d "$dir" ] && { printf '%s\n' "$dir"; return 0; }
  done
  printf '%s/lib\n' "$prefix"
}

dep_pkgconfig() {
  name=$1
  prefix=$(dep_prefix "$name")
  for dir in "$prefix/lib/pkgconfig" "$prefix/lib64/pkgconfig"; do
    [ -d "$dir" ] && { printf '%s\n' "$dir"; return 0; }
  done
  printf '%s/lib/pkgconfig\n' "$prefix"
}

hash_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify dependency archives"
  fi
}

verify_hash() {
  file=$1
  expected=$2
  actual=$(hash_file "$file")
  [ "$actual" = "$expected" ] || die "checksum mismatch for $file: expected $expected, got $actual"
}

download() {
  name=$1
  url=$(dep_field "$name" url)
  expected=$(dep_field "$name" sha256)
  [ -n "$url" ] || die "$name has no URL in $DEPS_FILE"
  [ -n "$expected" ] || die "$name has no sha256 in $DEPS_FILE"
  case $url in
    https://*) : ;;
    *) die "$name URL must use https: $url" ;;
  esac

  mkdir -p "$DEPS_DIR/downloads"
  archive="$DEPS_DIR/downloads/$(basename "$url")"
  if [ -f "$archive" ]; then
    if [ "$(hash_file "$archive")" = "$expected" ]; then
      printf 'build_deps: using cached %s\n' "$archive" >&2
      printf '%s\n' "$archive"
      return 0
    fi
    printf 'build_deps: cached %s failed its checksum; downloading again\n' \
      "$archive" >&2
    rm -f "$archive"
  fi

  temporary="$archive.part"
  rm -f "$temporary"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 \
      --proto '=https' --tlsv1.2 -o "$temporary" "$url" ||
      { rm -f "$temporary"; die "could not download $url"; }
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --timeout=30 --tries=3 --no-verbose -O "$temporary" "$url" ||
      { rm -f "$temporary"; die "could not download $url"; }
  else
    die "curl or wget is required to download $url"
  fi
  verify_hash "$temporary" "$expected"
  mv "$temporary" "$archive"
  printf '%s\n' "$archive"
}

ensure_source() {
  name=$1
  version=$(dep_field "$name" version)
  source=$(dep_source "$name")
  archive=$(download "$name")

  if [ ! -x "$source/Configure" ] && [ ! -x "$source/configure" ]; then
    rm -rf "$source"
    mkdir -p "$source"
    tar -xzf "$archive" -C "$source" --strip-components=1 ||
      die "could not extract $archive"
  fi
  printf '%s\n' "$source"
}

is_built() {
  name=$1
  prefix=$(dep_prefix "$name")
  case $name in
    openssl)
      for dir in "$prefix/lib" "$prefix/lib64"; do
        if [ -f "$dir/libssl.a" ] && [ -f "$dir/libcrypto.a" ]; then
          return 0
        fi
      done
      ;;
    zlib)
      for dir in "$prefix/lib" "$prefix/lib64"; do
        [ -f "$dir/libz.a" ] && return 0
      done
      ;;
    *)
      die "unknown dependency $name"
      ;;
  esac
  return 1
}

openssl_target() {
  case $(uname -m) in
    x86_64|amd64)      printf 'linux-x86_64\n' ;;
    aarch64|arm64)     printf 'linux-aarch64\n' ;;
    armv7l|armv8l)     printf 'linux-armv4\n' ;;
    ppc64le)           printf 'linux-ppc64le\n' ;;
    s390x)             printf 'linux64-s390x\n' ;;
    riscv64)           printf 'linux64-riscv64\n' ;;
    *) die "no OpenSSL target for architecture $(uname -m)" ;;
  esac
}

build_openssl() {
  prefix=$(dep_prefix openssl)
  if [ "${TAWB_DEPS_REBUILD:-}" = 1 ]; then
    rm -rf "$prefix" "$(dep_source openssl)"
  fi
  if is_built openssl; then
    printf 'build_deps: OpenSSL %s is already built in %s\n' \
      "$(dep_field openssl version)" "$prefix" >&2
    return 0
  fi

  source=$(ensure_source openssl)
  log="$DEPS_DIR/logs/openssl.log"
  mkdir -p "$DEPS_DIR/logs" "$prefix"
  target=$(openssl_target)
  configure=$(dep_field openssl configure)
  printf 'build_deps: building OpenSSL %s\n' "$(dep_field openssl version)" >&2
  (
    cd "$source"
    set -f
    set -- "$target" $configure
    ./Configure "$@" --prefix="$prefix" --openssldir=/etc/ssl
    make -j"$JOBS" build_sw
    make install_sw
  ) >"$log" 2>&1 || {
    printf 'build_deps: OpenSSL build failed; last lines from %s:\n' "$log" >&2
    tail -40 "$log" >&2 || true
    exit 1
  }
  is_built openssl || die "OpenSSL build left no static libraries in $prefix"
}

build_zlib() {
  prefix=$(dep_prefix zlib)
  if [ "${TAWB_DEPS_REBUILD:-}" = 1 ]; then
    rm -rf "$prefix" "$(dep_source zlib)"
  fi
  if is_built zlib; then
    printf 'build_deps: zlib %s is already built in %s\n' \
      "$(dep_field zlib version)" "$prefix" >&2
    return 0
  fi

  source=$(ensure_source zlib)
  log="$DEPS_DIR/logs/zlib.log"
  mkdir -p "$DEPS_DIR/logs" "$prefix"
  configure=$(dep_field zlib configure)
  printf 'build_deps: building zlib %s\n' "$(dep_field zlib version)" >&2
  (
    cd "$source"
    set -f
    set -- $configure
    ./configure "$@" --prefix="$prefix"
    make -j"$JOBS"
    make install
  ) >"$log" 2>&1 || {
    printf 'build_deps: zlib build failed; last lines from %s:\n' "$log" >&2
    tail -40 "$log" >&2 || true
    exit 1
  }
  is_built zlib || die "zlib build left no static library in $prefix"
}

command=${1:-all}
case $command in
  -h|--help|help)
    usage
    ;;
  prefix|libdir|pkgconfig)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    case $command in
      prefix)    dep_prefix "$2" ;;
      libdir)    dep_libdir "$2" ;;
      pkgconfig) dep_pkgconfig "$2" ;;
    esac
    ;;
  all)
    shift || true
    [ "$#" -eq 0 ] || { usage >&2; exit 2; }
    build_openssl
    build_zlib
    ;;
  openssl|zlib)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    "build_$command"
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
