'use strict';

// The three lists a browser keeps about itself: what you saved, where you
// have been, and what you fetched.
//
// Each engine answers for its own — see library_chromium.js and the privileged
// agent in firefox.js — and both hand back entries of the same shape:
//
//   { title, url, when, folder?, file?, state?, bytes?, totalBytes? }
//
// `when` is milliseconds since the Unix epoch, or null where the browser does
// not say. What is here is everything after that: how many entries are worth
// keeping, how one is written on a line, and what filtering a list means.
// Nothing in this file knows which browser it is talking about.

const KINDS = ['bookmarks', 'history', 'downloads'];

const KIND_LABELS = {
  bookmarks: 'Bookmarks',
  history: 'History',
  downloads: 'Downloads',
};

// How many entries are worth having. History is the only one that grows
// without limit, and a list nobody can reach the bottom of is not more useful
// for being longer; the newest are the ones anybody is looking for.
const MAX_ENTRIES = 5000;

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Ages, not timestamps. "3 days ago" is what places a visit in a reader's own
// memory of the day; "2026-08-25 17:41:09" has to be worked out first, and is
// four times as long to listen to.
function relativeAge(when, now = Date.now()) {
  if (!when) return '';
  const ago = now - when;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${Math.round(ago / MINUTE)} min ago`;
  if (ago < DAY) {
    const hours = Math.round(ago / HOUR);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(ago / DAY);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(when).toISOString().slice(0, 10);
}

function sizeText(bytes, total) {
  if (!total && !bytes) return '';
  const units = [['GB', 1 << 30], ['MB', 1 << 20], ['KB', 1 << 10]];
  const value = total || bytes;
  for (const [name, scale] of units) {
    if (value >= scale) return `${(value / scale).toFixed(value >= 10 * scale ? 0 : 1)}${name}`;
  }
  return `${value}B`;
}

// An address a reader can hear the whole of.
//
// A tracking link is routinely four hundred characters of percent-encoded
// query, and a line wraps: one entry of a browser's history filled twelve rows
// of a twenty-two row screen with a base64 blob, and buried the rest of the
// list under it. What identifies a page is its host and its path, so a long
// address is cut back to those and marked as cut. Nothing is lost — Enter goes
// to the address the browser gave us, not to the one on screen.
const MAX_ADDRESS = 100;

function shortAddress(url, max = MAX_ADDRESS) {
  if (url.length <= max) return url;
  try {
    const parsed = new URL(url);
    const base = `${parsed.origin}${parsed.pathname}`;
    if (base.length <= max) return `${base}…`;
  } catch { /* not an address we can take apart */ }
  return `${url.slice(0, max - 1)}…`;
}

function text(value) {
  return value == null ? '' : String(value);
}

// One entry, on one line, most identifying part first. The title is what a
// reader is scanning for; the address is what tells two of the same title
// apart, and is the whole line when a page never gave itself a title.
function entryLine(kind, entry, now = Date.now()) {
  const full = text(entry.url);
  const address = shortAddress(full);
  // A page that never titled itself is titled by its address, and a redirect
  // hop's address is not the one it ended at — so the title can be a second
  // four-hundred-character tracking link, and gets the same treatment.
  const named = text(entry.title).replace(/\s+/g, ' ').trim();
  const title = /^[a-z][\w+.-]*:\/\//i.test(named) ? shortAddress(named) : named;
  if (kind === 'downloads') {
    const described = [title || address, entry.state, sizeText(entry.bytes, entry.totalBytes),
      relativeAge(entry.when, now)].filter(Boolean).join(' — ');
    return address ? `${described} — from ${address}` : described;
  }
  const parts = [title && title !== address && title !== full ? title : null, address];
  if (kind === 'bookmarks' && entry.folder) parts.push(`in ${entry.folder}`);
  if (kind === 'history') parts.push(relativeAge(entry.when, now));
  return parts.filter(Boolean).join(' — ');
}

// What the reader typed, against what they can see. Case is ignored, because
// an address is lower case and a title is not, and nobody filtering a list of
// pages means the difference. Every space-separated word must appear, so
// "wiki braille" finds the article without knowing which order they come in.
function matches(line, filter) {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = line.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// What both engines' answers pass through before anyone sees them. Bookmarks
// keep the order the browser files them in — a bookmark's place in its folder
// is something the reader chose — and the other two are newest first, which is
// the only order a record of what happened has.
function orderEntries(kind, entries, { max = MAX_ENTRIES } = {}) {
  const clean = entries.filter((entry) => entry && (entry.url || entry.file));
  const ordered = kind === 'bookmarks'
    ? clean
    : [...clean].sort((a, b) => (b.when || 0) - (a.when || 0));
  return ordered.slice(0, max);
}

module.exports = {
  KINDS, KIND_LABELS, MAX_ENTRIES,
  entryLine, matches, relativeAge, sizeText, shortAddress, orderEntries,
};
