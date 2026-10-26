# A machine with flatpak on it, which the development machine does not have.
#
# Two claims about Flatpak decide whether TAWB's file chooser can reach a
# Flatpak browser, and neither claim can be checked without flatpak present:
#
#   * whether `flatpak run` passes DBUS_SESSION_BUS_ADDRESS from its own
#     environment to the `xdg-dbus-proxy` it starts for the sandbox, so that a
#     private bus TAWB made is the bus the sandboxed application talks to;
#   * whether the proxy's default policy still lets
#     `org.freedesktop.portal.Desktop` through when that name is owned by TAWB
#     rather than by the machine's real portal;
#   * whether a path chosen on the terminal can be made reachable inside the
#     sandbox, which is what `xdg-document-portal` is for.
#
# xdg-desktop-portal is installed for one binary out of it,
# `/usr/libexec/xdg-document-portal`. The file chooser frontend in the same
# package is never started: TAWB answers that itself, and two frontends would
# compete for one name. flatpak *recommends* xdg-desktop-portal, so an Ubuntu
# machine with flatpak on it has the document portal already.
#
# Flatpak needs bubblewrap, bubblewrap needs user namespaces, and the runtime
# store needs FUSE for revokefs. Run this image with `--privileged` and
# `--device /dev/fuse`; it is a local test container and nothing else.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      dbus \
      dbus-x11 \
      flatpak \
      fuse3 \
      gnupg \
      libglib2.0-bin \
      python3 \
      strace \
      xauth \
      xdg-dbus-proxy \
      xdg-desktop-portal \
      xvfb \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node from NodeSource: Ubuntu 24.04 ships Node 18, and TAWB's source uses
# newer syntax than Node 18 parses.
RUN curl --fail --silent --show-error --location https://deb.nodesource.com/setup_24.x -o /tmp/node.sh \
    && bash /tmp/node.sh \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -f /tmp/node.sh \
    && rm -rf /var/lib/apt/lists/*

# TAWB refuses to launch a browser as root, because a browser's own sandbox
# cannot run that way — see requireBrowserUser in proc.js. The probes that only
# speak D-Bus run as root; the one that starts a real Firefox runs as this
# reader, who can run a system-installed Flatpak application without being able
# to modify it.
# Ubuntu 24.04 already has a uid 1000, so the reader gets the next one.
RUN useradd --create-home --uid 1100 --shell /bin/bash reader

# The runtime store is the expensive part of this test. Keeping it on a volume
# means a second run does not download a runtime again.
VOLUME ["/var/lib/flatpak"]

WORKDIR /app
ENTRYPOINT ["/bin/bash"]
