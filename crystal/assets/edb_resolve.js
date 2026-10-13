// Generated from src/edb_page.js resolveDescriptor; update with tools/update_crystal_assets.js.
function resolveDescriptor(options) {
  const desc = options && options.desc ? options.desc : options;
  const closedRoots = new Map();
  for (const pair of (options && options.pairs) || []) {
    if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
  }
  if (options && options.pierce && typeof window[Symbol.for('tweb.pierce')] === 'function') {
    try {
      for (const pair of window[Symbol.for('tweb.pierce')]() || []) {
        if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
      }
    } catch { /* the privileged half is not installed here */ }
  }
  const rootOf = (node) => closedRoots.get(node) || node.shadowRoot || null;

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
        const root = rootOf(node);
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
  // Everything, including what is behind the roots we were lent.
  const all = [];
  const gather = (root) => {
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      const shadow = rootOf(el);
      if (shadow) gather(shadow);
    }
  };
  gather(document);
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
