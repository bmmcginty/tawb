// Generated from src/edb_page.js extractForEdbrowse; update with tools/update_crystal_assets.js.
function extractForEdbrowse(options) {
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

  // Closed shadow roots the driver found and handed in for this call. Page
  // script cannot reach one on its own — that is what closed means — and a
  // bot check is built out of them, so without this edbrowse is shown nothing
  // at all where a challenge is standing. See frames.js readDocument().
  const opts = options || {};
  const closedRoots = new Map();
  for (const pair of opts.pairs || []) {
    if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
  }
  if (opts.pierce && typeof window[Symbol.for('tweb.pierce')] === 'function') {
    try {
      for (const pair of window[Symbol.for('tweb.pierce')]() || []) {
        if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
      }
    } catch { /* the privileged half is not installed here */ }
  }

  const flat = (node) => {
    const closed = closedRoots.get(node);
    if (closed) return Array.from(closed.childNodes);
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

  // Whether the walk is currently inside a closed shadow root. Carried on
  // the tokens, because what edbrowse can usefully do with a control depends
  // on it: a form in there is not a form edbrowse can submit from the page it
  // is reading, and a checkbox in there cannot be ticked by setting a
  // property — the only thing a bot check accepts is a real click.
  let insideClosed = false;

  // Walking into an element's children, remembering whether what we are about
  // to see lives behind a closed shadow root.
  const descend = (el) => {
    const outer = insideClosed;
    if (closedRoots.has(el)) insideClosed = true;
    try {
      for (const child of flat(el)) walk(child);
    } finally {
      insideClosed = outer;
    }
  };
  const mark = (token) => {
    if (insideClosed) token.pierced = true;
    return token;
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = clean(node.textContent);
      if (text) out.push(mark({ kind: 'text', text }));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node;
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (hidden(el)) return;

    if (tag === 'iframe' || tag === 'frame') {
      out.push(mark({
        kind: 'frame',
        desc: describe(el, tag),
        name: clean(el.getAttribute('title') || el.getAttribute('name') || el.getAttribute('src') || 'frame'),
      }));
      return;
    }

    if (tag === 'img') {
      const alt = clean(el.getAttribute('alt'));
      if (alt) out.push(mark({ kind: 'image', text: alt }));
      return;
    }

    if (tag === 'form') {
      out.push(mark({ kind: 'form-open', desc: describe(el, tag) }));
      descend(el);
      out.push(mark({ kind: 'form-close' }));
      return;
    }

    if (FIELDS.has(tag)) {
      out.push(mark(fieldToken(el, tag)));
      return;
    }

    if (activatable(el, tag)) {
      // Emitted whole: its own text is its name, and descending would
      // scatter that text across lines the reader cannot activate.
      const href = el.getAttribute('href');
      const navigational = tag === 'a' && !!href && href !== '#'
        && !/^javascript:/i.test(href);
      out.push(mark({
        kind: 'link', desc: describe(el, tag), name: nameOf(el) || tag, navigational,
      }));
      return;
    }

    const keep = KEEP.has(tag);
    if (keep) out.push(mark({ kind: 'open', tag }));
    descend(el);
    if (keep) out.push(mark({ kind: 'close', tag }));
  };

  if (document.body) walk(document.body);

  return {
    url: location.href,
    title: document.title || location.href,
    tokens: out,
  };
}
