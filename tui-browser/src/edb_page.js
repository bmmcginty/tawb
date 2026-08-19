'use strict';

// The page side of the edbrowse server: what runs inside the browser.
//
// Three jobs, all of them self-contained functions serialised across to the
// page, and all of them speaking in *descriptors* rather than handles.
//
// A descriptor is how an element is named on the wire: a path through the
// document, its tag, its accessible name, and its position in document
// order. Any process with a connection to the browser can resolve one — no
// handle table, no shared memory, no state that has to survive a restart.
// That is what keeps the transport open: today an http server holds the
// registry, tomorrow a plugin spawned per click could resolve the same
// descriptor with no daemon at all.
//
// The path crosses shadow roots, because the page a reader sees includes
// what web components put there, and on real sites that is where the cookie
// dialog lives.

// Extraction returns tokens, not html. The browser knows what is on the
// page; how it should be written for edbrowse is a decision for the other
// side, which is where the ids live.
function extractForEdbrowse() {
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head',
    'meta', 'link', 'title', 'base', 'svg', 'path', 'defs', 'symbol', 'use']);
  // Tags edbrowse renders well, kept as they are. Everything else is a
  // container: its children are emitted and the tag itself is dropped.
  const KEEP = new Set(['p', 'br', 'hr', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
  const FIELDS = new Set(['input', 'select', 'textarea']);
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab',
    'checkbox', 'radio', 'switch', 'option', 'treeitem']);

  const flat = (node) => {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  };

  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const parent = node.parentNode;
      if (!parent) break;
      if (parent.nodeType === 11) { // a shadow root: hop to its host
        parts.unshift(`s${Array.prototype.indexOf.call(parent.children, node)}`);
        node = parent.host;
        continue;
      }
      parts.unshift(String(Array.prototype.indexOf.call(parent.children, node)));
      node = parent;
    }
    return parts.join('/');
  };

  const order = new Map();
  const all = document.getElementsByTagName('*');
  for (let i = 0; i < all.length; i += 1) order.set(all[i], i);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // The name a reader would hear. Text first, because that is what the page
  // shows; then the labels, which is the only thing an icon control has.
  const nameOf = (el) => {
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 300);
    const labelled = clean(el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('alt') || el.getAttribute('placeholder')
      || el.getAttribute('name') || el.value || '');
    if (labelled) return labelled.slice(0, 300);
    // An icon link: the image inside it usually says what it is, and failing
    // that the last part of the address does. "index" is not much, but it is
    // more than an empty pair of braces in the buffer.
    const image = el.querySelector ? el.querySelector('img[alt]') : null;
    if (image) {
      const alt = clean(image.getAttribute('alt'));
      if (alt) return alt.slice(0, 300);
    }
    const href = el.getAttribute && el.getAttribute('href');
    if (href && !/^javascript:/i.test(href)) {
      const tail = href.split(/[?#]/)[0].split('/').filter(Boolean).pop();
      if (tail) return decodeURIComponent(tail).slice(0, 120);
    }
    return '';
  };

  const hidden = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  };

  // What can be activated. The tag list is the obvious half; the rest is the
  // half that matters on real pages, where the thing you have to click is a
  // div with a handler on it. Nothing can enumerate listeners in both
  // engines, so the signals are the ones a page gives away anyway: an
  // interactive role, a tabindex, or a pointer cursor.
  const activatable = (el, tag) => {
    if (tag === 'a') return el.hasAttribute('href') || el.hasAttribute('role');
    if (tag === 'button' || tag === 'summary') return true;
    if (FIELDS.has(tag)) return false; // fields are handled as fields
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;
    if (window.getComputedStyle(el).cursor === 'pointer' && nameOf(el)) return true;
    return false;
  };

  const out = [];
  const describe = (el, tag) => ({
    path: pathOf(el),
    tag,
    name: nameOf(el),
    ord: order.has(el) ? order.get(el) : -1,
  });

  const fieldToken = (el, tag) => {
    const token = {
      kind: 'field', tag, desc: describe(el, tag),
      type: (tag === 'input' ? (el.getAttribute('type') || 'text') : tag).toLowerCase(),
      label: '', value: '', checked: !!el.checked, options: null,
    };
    // A field's label is whatever names it, in the order a screen reader
    // would try: its own label element, then aria-label, then placeholder.
    let label = '';
    if (el.labels && el.labels.length) label = clean(el.labels[0].textContent);
    if (!label) {
      label = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder')
        || el.getAttribute('name') || el.getAttribute('title') || '');
    }
    token.label = label || token.type;
    if (tag === 'select') {
      token.options = Array.from(el.options).map((o) => ({
        text: clean(o.textContent) || o.value, selected: o.selected, disabled: o.disabled,
      }));
    } else {
      token.value = typeof el.value === 'string' ? el.value : '';
    }
    return token;
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.textContent);
      if (text) out.push({ kind: 'text', text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (hidden(el)) return;

    if (tag === 'iframe' || tag === 'frame') {
      out.push({
        kind: 'frame',
        desc: describe(el, tag),
        name: clean(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('src') || 'frame'),
      });
      return;
    }

    if (tag === 'img') {
      const alt = clean(el.getAttribute('alt'));
      if (alt) out.push({ kind: 'image', text: alt });
      return;
    }

    if (tag === 'form') {
      out.push({ kind: 'form-open', desc: describe(el, tag) });
      for (const child of flat(el)) walk(child);
      out.push({ kind: 'form-close' });
      return;
    }

    if (FIELDS.has(tag)) {
      out.push(fieldToken(el, tag));
      return;
    }

    if (activatable(el, tag)) {
      // Emitted whole: its own text is its name, and descending would
      // scatter that text across lines the reader cannot activate.
      const href = el.getAttribute('href');
      const navigational = tag === 'a' && !!href && href !== '#'
        && !/^javascript:/i.test(href);
      out.push({
        kind: 'link', desc: describe(el, tag), name: nameOf(el) || tag, navigational,
      });
      return;
    }

    const keep = KEEP.has(tag);
    if (keep) out.push({ kind: 'open', tag });
    for (const child of flat(el)) walk(child);
    if (keep) out.push({ kind: 'close', tag });
  };

  if (document.body) walk(document.body);

  return {
    url: location.href,
    title: document.title || location.href,
    tokens: out,
  };
}

// Resolving a descriptor, in the page, with nothing else to go on.
//
// The path is tried first and is right almost always: it is where the
// element was, and pages usually change around their controls rather than
// underneath them. When the structure has shifted, the tag and the
// accessible name identify it, and document order picks between duplicates —
// the same evidence place.js uses to keep a reader's place across views.
function resolveDescriptor(desc) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 300);
    return clean(el.getAttribute('aria-label') || el.getAttribute('title')
      || el.getAttribute('alt') || el.getAttribute('placeholder')
      || el.getAttribute('name') || el.value || '').slice(0, 300);
  };

  const byPath = (path) => {
    let node = document.documentElement;
    for (const part of String(path).split('/')) {
      if (!node) return null;
      if (part === '') continue;
      if (part[0] === 's') {
        const root = node.shadowRoot;
        node = root ? root.children[Number(part.slice(1))] : null;
      } else {
        node = node.children[Number(part)];
      }
    }
    return node || null;
  };

  const wanted = clean(desc.name);
  const found = byPath(desc.path);
  if (found && found.tagName.toLowerCase() === desc.tag
    && (!wanted || nameOf(found) === wanted)) {
    window[Symbol.for('tweb.resolved')] = found;
    return { how: 'path' };
  }

  // The path missed. Look for the same tag and name, nearest to where it was
  // in document order — a page that inserted a banner has moved everything
  // down by the same amount, and the nearest match is the right one.
  const all = document.getElementsByTagName('*');
  let best = null;
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i];
    if (el.tagName.toLowerCase() !== desc.tag) continue;
    if (wanted && nameOf(el) !== wanted) continue;
    const distance = Math.abs(i - (desc.ord == null ? i : desc.ord));
    if (!best || distance < best.distance) best = { el, distance };
  }
  if (best) {
    window[Symbol.for('tweb.resolved')] = best.el;
    return { how: 'name' };
  }

  window[Symbol.for('tweb.resolved')] = null;
  return null;
}

// Putting the reader's answers into the live page.
//
// Values are set and then input and change are dispatched, so the site's own
// handlers, validation and enable/disable logic run exactly as they would
// have. What this does not do is press the button: the submit itself is a
// real click, sent through the browser's input pipeline, because that is the
// half that needs to be a person as far as the page is concerned.
function applyFieldValues(entries) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const byPath = (path) => {
    let node = document.documentElement;
    for (const part of String(path).split('/')) {
      if (!node) return null;
      if (part === '') continue;
      if (part[0] === 's') {
        const root = node.shadowRoot;
        node = root ? root.children[Number(part.slice(1))] : null;
      } else {
        node = node.children[Number(part)];
      }
    }
    return node || null;
  };

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const applied = [];
  const missed = [];

  for (const entry of entries) {
    const el = byPath(entry.path);
    if (!el || el.tagName.toLowerCase() !== entry.tag) { missed.push(entry.path); continue; }
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (type === 'checkbox' || type === 'radio') {
      const on = entry.value === 'on' || entry.value === 'true' || entry.value === '1';
      if (el.checked !== on) { el.checked = on; fire(el, 'input'); fire(el, 'change'); }
    } else if (el.tagName.toLowerCase() === 'select') {
      let matched = false;
      for (const option of el.options) {
        const want = clean(entry.value);
        const is = clean(option.textContent) === want || option.value === entry.value;
        if (el.multiple) option.selected = is && !matched ? true : (is || false);
        else if (is && !matched) { el.value = option.value; matched = true; }
        if (is) matched = true;
      }
      fire(el, 'input');
      fire(el, 'change');
    } else {
      el.value = entry.value;
      fire(el, 'input');
      fire(el, 'change');
    }
    applied.push(entry.path);
  }

  return { applied: applied.length, missed };
}

module.exports = { extractForEdbrowse, resolveDescriptor, applyFieldValues };
