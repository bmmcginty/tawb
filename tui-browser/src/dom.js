'use strict';

const { clickThrough } = require('./click');

// HTML mode: builds the line list from the DOM itself instead of the
// accessibility tree.
//
// The two views disagree more often than you would hope, and the AX tree is
// the lossy one. A <video> with a perfectly playable source reports only its
// fallback text — "Your browser does not support videos." — because that
// text is the element's content; the actual media URL appears nowhere in the
// AX tree. Cross-origin <iframe> embeds (YouTube and friends) are likewise
// absent from the top frame's tree entirely. Anything driven by attributes
// rather than semantics is invisible to a screen reader by construction.
//
// So this mode shows tags and their meaningful attributes, and suppresses
// only the containers that carry nothing (div/span wrappers). Elements are
// stashed in a page-side array so a line can be activated later by index;
// that array is rebuilt on every snapshot, which is also what keeps it valid
// across navigations.

// Tags that always earn a line, even without interesting attributes.
const NOTABLE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'video', 'audio', 'source',
  'track', 'iframe', 'embed', 'object', 'img', 'form', 'label', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'details', 'dialog',
  'canvas', 'svg', 'progress', 'meter', 'time', 'output',
]);

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);

// Attributes worth showing. `src`/`href` are the whole point: they are what
// the AX tree drops.
const ATTRS = [
  'src', 'currentSrc', 'href', 'type', 'value', 'alt', 'title', 'name',
  'controls', 'poster', 'download', 'target', 'placeholder', 'aria-label',
];

// Runs in the page. Kept as one self-contained function because it is
// serialised across to the browser.
function extractDom() {
  const NOTABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'video', 'audio',
    'source', 'track', 'iframe', 'embed', 'object', 'img', 'form', 'label', 'table',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary', 'details', 'dialog',
    'canvas', 'svg', 'progress', 'meter', 'time', 'output']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link']);
  const ATTR_NAMES = ['src', 'href', 'type', 'value', 'alt', 'title', 'name',
    'controls', 'poster', 'download', 'target', 'placeholder', 'aria-label'];

  const nodes = [];
  window.__twebNodes = nodes;
  const out = [];

  const push = (entry) => out.push(entry);

  // The flattened tree — what the browser actually renders. An element with a
  // shadow root renders that shadow tree instead of its own children, and a
  // <slot> inside it renders whatever the light DOM assigned to it. Walking
  // childNodes alone therefore stops dead at every web component: on a
  // Bandcamp album page that hides the whole page footer and, with it, the
  // cookie dialog covering the page — which the reader could neither see nor
  // dismiss while it blocked every real click.
  const kidsOf = (node) => {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  };


  const walk = (el, depth) => {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (SKIP.has(tag)) return;

    const attrs = {};
    for (const a of ATTR_NAMES) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const v = el.getAttribute(a);
      if (v != null && v !== '') attrs[a] = v;
    }
    // currentSrc resolves what the element actually loaded, which can differ
    // from the src attribute (or exist when there is no src attribute).
    if ('currentSrc' in el && el.currentSrc && el.currentSrc !== attrs.src) {
      attrs.currentSrc = el.currentSrc;
    }
    if (tag === 'input' && el.value) attrs.value = el.value;

    const interesting = NOTABLE.has(tag) || Object.keys(attrs).length > 0;

    if (interesting) {
      const index = nodes.length;
      nodes.push(el);
      push({ kind: 'element', tag, attrs, depth, index });
    }

    for (const child of kidsOf(el)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) push({ kind: 'text', text, depth: depth + 1 });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child, depth + 1);
      }
    }
  };

  if (document.body) walk(document.body, 0);
  return out;
}

// Maps a tag to the role vocabulary the rest of the app navigates by, so
// quick-nav keys work identically in either mode.
function roleForTag(tag) {
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  return tag;
}

function renderEntry(entry) {
  if (entry.kind === 'text') return entry.text;

  const parts = [entry.tag];
  for (const [key, value] of Object.entries(entry.attrs)) {
    const shown = value.length > 120 ? value.slice(0, 117) + '...' : value;
    parts.push(`${key}=${shown}`);
  }
  return `<${parts.join(' ')}>`;
}

// `target` is a Page or a Frame — both expose evaluate(), and the node array
// is stashed per frame, so an item must remember which frame it came from or
// a later activation would look it up in the wrong document.
async function snapshotDomBlocks(target) {
  const frame = typeof target.mainFrame === 'function' ? target.mainFrame() : target;
  const entries = await target.evaluate(extractDom);

  return entries.map((entry) => {
    const text = renderEntry(entry);
    if (entry.kind === 'text') {
      return { kind: 'control', text, item: { role: 'text', name: entry.text, frame }, spans: [] };
    }
    const item = {
      role: roleForTag(entry.tag),
      name: entry.attrs['aria-label'] || entry.attrs.alt || entry.attrs.title || entry.tag,
      tag: entry.tag,
      attrs: entry.attrs,
      domIndex: entry.index,
      frame,
    };
    return { kind: 'control', text, item, spans: [] };
  }).filter((b) => b.text);
}

// Elements whose content is a stream, not a page. Pointing the browser at
// an .mp4 starts a download rather than a navigation, and rendering an image
// is no use here anyway — the URL itself is the useful result, ready to hand
// to mpv, yt-dlp or curl.
const MEDIA_TAGS = new Set(['video', 'audio', 'source', 'track', 'img']);
// Frames are real pages, so entering them is a genuine navigation.
const FRAME_TAGS = new Set(['iframe', 'embed', 'object']);

function resolvedUrl(page, item) {
  const raw = item.attrs && (item.attrs.currentSrc || item.attrs.src || item.attrs.href);
  if (!raw) return null;
  const base = (item.frame || page).url();
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

// Activates a DOM-mode line, with the action chosen by what the element
// actually is rather than by pretending everything is a link.
async function activateDomItem(page, item) {
  const url = resolvedUrl(page, item);

  if (MEDIA_TAGS.has(item.tag)) {
    return url ? `${item.tag} URL: ${url}` : `<${item.tag}> has no source URL.`;
  }

  if (FRAME_TAGS.has(item.tag) && url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return `Entered ${item.tag}: ${url}`;
  }

  // Aimed where a mouse would land rather than at the element itself: a
  // handler bound to a child hears a real click and would never hear ours.
  const handle = await domElementHandle(page, item);
  await handle.evaluate(clickThrough);
  await handle.dispose().catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return `Activated <${item.tag}>`;
}

async function domElementHandle(page, item) {
  const target = item.frame || page;
  return target.evaluateHandle((i) => window.__twebNodes && window.__twebNodes[i], item.domIndex);
}

module.exports = {
  snapshotDomBlocks, activateDomItem, domElementHandle, roleForTag, resolvedUrl,
  NOTABLE_TAGS, SKIP_TAGS, ATTRS, MEDIA_TAGS, FRAME_TAGS,
};
