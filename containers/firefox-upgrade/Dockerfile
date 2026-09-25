FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dbus \
      libasound2 \
      libdbus-glib-1-2 \
      libgtk-3-0 \
      libx11-xcb1 \
      libxt6 \
      xauth \
      xz-utils \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

ARG FIREFOX_CHANNEL=stable
ARG FIREFOX_REFRESH=manual
ARG TARGETARCH=amd64

# Mozilla's bouncer URLs always resolve to the newest build in each channel.
# FIREFOX_REFRESH is changed by the runner so Docker cannot satisfy a future
# upgrade check from an old download layer while retaining the expensive apt
# layer in its cache.
RUN case "$FIREFOX_CHANNEL" in \
      stable) product=firefox-latest ;; \
      beta) product=firefox-beta-latest ;; \
      nightly) product=firefox-nightly-latest-ssl ;; \
      *) echo "unsupported Firefox channel: $FIREFOX_CHANNEL" >&2; exit 2 ;; \
    esac \
    && case "$TARGETARCH" in \
      amd64) platform=linux64 ;; \
      arm64) platform=linux64-aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 2 ;; \
    esac \
    && echo "Firefox refresh: $FIREFOX_REFRESH" \
    && curl --fail --location --retry 3 --output /tmp/firefox.tar.xz \
      "https://download.mozilla.org/?product=${product}&os=${platform}&lang=en-US" \
    && mkdir -p /opt \
    && tar -xJf /tmp/firefox.tar.xz -C /opt \
    && rm /tmp/firefox.tar.xz \
    && test -x /opt/firefox/firefox \
    && ln -s /opt/firefox/firefox /usr/local/bin/firefox

ARG TAWB_IMAGE_REVISION=unknown
ENV TAWB_IMAGE_REVISION=${TAWB_IMAGE_REVISION}

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools

USER node
ENTRYPOINT ["node", "tools/diagnose_firefox.js"]
CMD ["--log-dir", "/logs"]
