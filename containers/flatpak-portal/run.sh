#!/bin/sh
# The whole Flatpak test, from a machine with no flatpak on it.
#
# What it answers, in order:
#
#   1. does `flatpak run` pass DBUS_SESSION_BUS_ADDRESS from its own
#      environment through to the sandbox, so that a bus TAWB made is the bus
#      the sandboxed browser talks to;
#   2. does the sandbox's `xdg-dbus-proxy` let the whole FileChooser exchange
#      across — the call, the request path, and the broadcast `Response` signal
#      that carries the answer — when `org.freedesktop.portal.Desktop` is owned
#      by TAWB rather than by the machine's real portal;
#   3. does the second proxy flatpak makes for the accessibility bus carry a
#      call *inward*, from a reader outside the sandbox to the application
#      inside it, which is how TAWB reads a browser at all.
#
# Everything runs in one container: TAWB's own private bus and portal outside
# the Flatpak sandbox, and TAWB's own D-Bus client inside it. The sandboxed
# side is a probe rather than Firefox because the question is what the proxy
# carries, not what Firefox does with it — but it is the real `flatpak run`,
# the real proxy, and the real org.mozilla.firefox sandbox and permissions.
#
# Usage: containers/flatpak-portal/run.sh [--keep]
#   --keep leaves the container running, so a failed run can be poked at.
set -eu

IMAGE=tawb/flatpak-portal
CONTAINER=tawb-flatpak
VOLUME=tawb-flatpak-store
APP=org.mozilla.firefox
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
KEEP=no
[ "${1:-}" = "--keep" ] && KEEP=yes

say() { printf '\n=== %s ===\n' "$1"; }

say "building $IMAGE"
docker build -q -t "$IMAGE" "$ROOT/containers/flatpak-portal"

docker volume create "$VOLUME" >/dev/null
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
# Privileged because bubblewrap needs user namespaces and the runtime store
# needs FUSE. The source is read-only: nothing in this test writes to it.
docker run -d --name "$CONTAINER" --privileged --device /dev/fuse \
  --memory=4g --memory-swap=4g \
  -v "$VOLUME:/var/lib/flatpak" -v "$ROOT:/app:ro" -w /app \
  "$IMAGE" -c 'sleep infinity' >/dev/null

run() { docker exec "$CONTAINER" bash -lc "$1"; }

say "installing $APP"
run "flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo"
run "flatpak info $APP >/dev/null 2>&1 || flatpak install -y --system --noninteractive flathub $APP"

# `flatpak run` itself needs a system bus to proxy, and refuses to start an
# application without one. A desktop always has one; a container does not.
say "a system bus for flatpak to proxy"
run "mkdir -p /run/dbus"
docker exec -d "$CONTAINER" bash -c 'test -S /run/dbus/system_bus_socket || dbus-daemon --system --nofork > /tmp/systembus.log 2>&1'
sleep 2
run "ls -l /run/dbus/system_bus_socket"

# A directory the sandbox can see. The chooser answers with a path, and a path
# outside the sandbox's filesystems is a path the browser cannot open — so the
# answer is seeded inside XDG_DOWNLOAD_DIR, which org.mozilla.firefox holds.
say "a download directory, which this app may see"
run 'mkdir -p /root/.config /root/Downloads; printf "XDG_DOWNLOAD_DIR=\"\$HOME/Downloads\"\n" > /root/.config/user-dirs.dirs; echo downloaded > "/root/Downloads/a file.txt"; ls -l /root/Downloads'

# Node and TAWB's source, where the sandbox can reach them. A Flatpak sandbox
# cannot see /app, so the probe and what it needs are copied somewhere a
# --filesystem can be granted for.
run "mkdir -p /srv/tawb && cp /usr/bin/node /srv/tawb/node && cp -r /app/src /srv/tawb/src && cp /app/containers/flatpak-portal/portal_client.js /app/containers/flatpak-portal/a11y_app.js /srv/tawb/"

say "TAWB's private bus and portal, outside the sandbox"
# The bracket keeps the pattern from matching the shell this pkill runs in:
# that shell's own command line contains the pattern otherwise, and it kills
# itself before it kills anything else.
run "pkill -f '[p]ortal_host.js' || true"
sleep 1
docker exec -d "$CONTAINER" bash -c 'export PORTAL_CHOSEN_FILE="/root/Downloads/a file.txt" PORTAL_CHOSEN_DIR=/root/Downloads; sleep infinity | node /app/containers/flatpak-portal/portal_host.js > /tmp/portal.log 2>&1'
sleep 3
run "cat /tmp/portal.log"
ADDRESS=$(run 'grep -o "unix:path=[^\"]*" /tmp/portal.log | head -1')
printf 'bus: %s\n' "$ADDRESS"

say "the file chooser, asked from inside the Flatpak sandbox"
docker exec -e DBUS_SESSION_BUS_ADDRESS="$ADDRESS" -e AT_SPI_BUS_ADDRESS="$ADDRESS" "$CONTAINER" \
  bash -lc "flatpak run --filesystem=/srv/tawb --command=sh $APP -c '/srv/tawb/node /srv/tawb/portal_client.js'"

say "the accessibility bus, read inward into the sandbox"
docker exec -d -e DBUS_SESSION_BUS_ADDRESS="$ADDRESS" -e AT_SPI_BUS_ADDRESS="$ADDRESS" "$CONTAINER" \
  bash -c "sleep 120 | flatpak run --filesystem=/srv/tawb --command=sh $APP -c '/srv/tawb/node /srv/tawb/a11y_app.js' > /tmp/a11yapp.log 2>&1"
sleep 8
run "cat /tmp/a11yapp.log"
TARGET=$(run 'grep -o "\":1\.[0-9]*\"" /tmp/a11yapp.log | head -1 | tr -d "\""')
printf 'application inside the sandbox: %s\n' "$TARGET"
docker exec -e AT_SPI_BUS_ADDRESS="$ADDRESS" "$CONTAINER" \
  node /app/containers/flatpak-portal/a11y_reader.js "$TARGET"

say "what the portal saw"
run "cat /tmp/portal.log"

if [ "$KEEP" = no ]; then
  docker rm -f "$CONTAINER" >/dev/null
  printf '\nthe container is gone; the runtime store is kept in the %s volume\n' "$VOLUME"
else
  printf '\nthe container %s is still running\n' "$CONTAINER"
fi
