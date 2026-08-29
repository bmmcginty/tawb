'use strict';

// What the reader typed, turned into somewhere to go.
//
// A graphical browser's address bar is not an address bar. It takes an
// address when it is given one and searches when it is not, and that second
// half is most of what people use it for: three words go in and results come
// back. Typing three words here used to produce `https://three words` and a
// name that does not resolve, which is not a degraded address bar, it is a
// broken one.
//
// So this file is the guess a browser makes: what looks like somewhere to go,
// what looks like something to look for, and which scheme a bare host gets.
// Everything it decides is decided from the text alone — no DNS lookup, no
// asking the network first — because the reader is waiting on the keystroke
// and a browser does not ask either.

// Bare host with a dot: https, because that is the web now, and a site still
// on plaintext will redirect us there itself. Loopback and `.local` get http,
// since they usually have no certificate — and so does a bare IP address,
// which is what a browser does with one typed on its own.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const BARE_SCHEME = /^(mailto|data|about|file|tel|view-source|blob):/i;
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/i;
const DOT_LOCAL = /\.local(:\d+)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/;
// A host with a port and no dot in it — `myhost:3000` — which is a
// development server rather than a scheme called "myhost". The dot is
// excluded so `example.com:8443` falls to the https rule below instead.
const HOST_PORT = /^[^\s/?#@:.]+:\d+$/;
const DOTTED_HOST = /^[^\s@]+\.[a-z][a-z0-9-]+(:\d+)?$/i;

// Where a search goes when nobody has said otherwise. A `%s` is where the
// words are put; without one they are appended, so a bare prefix works too.
const DEFAULT_SEARCH = 'https://duckduckgo.com/?q=%s';

function searchUrl(words, template = DEFAULT_SEARCH) {
  const encoded = encodeURIComponent(words);
  return template.includes('%s') ? template.replace('%s', encoded) : template + encoded;
}

// The answer is always somewhere the browser can be sent, so nothing above
// this has to decide what to do with a non-address. `searched` says the text
// was taken as words rather than as an address, which is worth saying on the
// status line — the reader typed a host name with a typo in it often enough
// that silently searching for it would be the confusing outcome.
function resolveAddress(typed, { search = DEFAULT_SEARCH } = {}) {
  const wanted = String(typed || '').trim();
  if (!wanted) return { error: 'nothing to open' };

  if (SCHEME.test(wanted) || BARE_SCHEME.test(wanted)) return { url: wanted, searched: false };

  const host = wanted.split(/[/?#]/)[0];
  if (LOOPBACK.test(host) || DOT_LOCAL.test(host) || IPV4.test(host) || HOST_PORT.test(host)) {
    return { url: `http://${wanted}`, searched: false };
  }
  if (DOTTED_HOST.test(host)) return { url: `https://${wanted}`, searched: false };

  return { url: searchUrl(wanted, search), searched: true, words: wanted };
}

module.exports = { resolveAddress, searchUrl, DEFAULT_SEARCH };
