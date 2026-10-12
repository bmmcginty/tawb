// Generated from src/source_html.js extractSource; update with tools/update_crystal_assets.js.
function extractSource(options = {}) {
  const OPAQUE = new Set(['script', 'style']);
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const LIMIT = 20000;
  const ATTR_LIMIT = 120;

  const nodes = [];
  window[Symbol.for('tweb.dom')] = nodes;
  const out = [];
  const privilegedRoots = new Map();
  const nativeControls = new Map();
  const remember = (pairs) => {
    for (const pair of pairs || []) {
      if (pair && pair[0] && pair[1]) {
        privilegedRoots.set(pair[0], { root: pair[1], kind: pair[3] || 'closed' });
      }
      if (pair && pair[0] && pair[2] && Array.from(pair[2]).length) {
        nativeControls.set(pair[0], Array.from(pair[2]));
      }
    }
  };
  remember(options.pairs);
  if (options.pierce) {
    const pierce = window[Symbol.for('tweb.pierce')];
    if (typeof pierce === 'function') {
      try { remember(pierce()); } catch { /* privileged roots unavailable */ }
    }
  }
  const shadowOf = (el) => {
    const privileged = privilegedRoots.get(el);
    if (privileged) return { ...privileged, controls: nativeControls.get(el) || [] };
    if (nativeControls.has(el)) {
      return { root: null, controls: nativeControls.get(el), kind: 'user-agent' };
    }
    return el.shadowRoot ? { root: el.shadowRoot, kind: 'open' } : null;
  };

  const attrsOf = (el) => {
    const attrs = {};
    for (const attr of el.attributes || []) {
      const value = attr.value || '';
      attrs[attr.name] = value.length > ATTR_LIMIT ? value.slice(0, ATTR_LIMIT - 1) + '…' : value;
    }
    return attrs;
  };

  const openTag = (tag, attrs) => {
    const parts = [tag];
    for (const [name, value] of Object.entries(attrs)) {
      parts.push(value === '' ? name : `${name}="${value}"`);
    }
    return `<${parts.join(' ')}>`;
  };

  const textOf = (node) => (node.textContent || '').replace(/\s+/g, ' ').trim();

  // Whether everything inside is text, so the element fits on one line. A
  // shadow host never does: it has a whole second tree to show.
  const textOnly = (el) => {
    if (shadowOf(el)) return false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) return false;
    }
    return true;
  };

  const walk = (el, depth) => {
    if (out.length >= LIMIT) return;

    const tag = el.tagName.toLowerCase();
    const attrs = attrsOf(el);
    const index = nodes.length;
    nodes.push(el);
    const open = openTag(tag, attrs);

    if (VOID.has(tag)) {
      out.push({ kind: 'element', tag, attrs, depth, index, text: open });
      return;
    }

    if (OPAQUE.has(tag)) {
      const size = (el.textContent || '').length;
      const body = size ? `… ${size} characters …` : '';
      out.push({ kind: 'element', tag, attrs, depth, index, text: `${open}${body}</${tag}>` });
      return;
    }

    if (textOnly(el)) {
      const text = textOf(el);
      out.push({ kind: 'element', tag, attrs, depth, index, text: `${open}${text}</${tag}>` });
      return;
    }

    out.push({ kind: 'element', tag, attrs, depth, index, text: open });

    // A shadow root is a second tree, not the element's children, and this
    // view shows what is there rather than a flattened impression of it. The
    // light children still follow, where they are written; what the browser
    // renders in their place is the shadow tree's <slot>s.
    const shadow = shadowOf(el);
    if (shadow) {
      out.push({ kind: 'text', depth: depth + 1, text: `#${shadow.kind}-shadow-root` });
      for (const control of shadow.controls || []) {
        if (out.length >= LIMIT) break;
        const attrs = { role: control.role, name: control.name };
        if (control.value) attrs.value = control.value;
        out.push({
          kind: 'element', tag: 'native-control', attrs, depth: depth + 2,
          index: nodes.length, text: `${openTag('native-control', attrs)}</native-control>`,
        });
        nodes.push(el);
      }
      for (const child of shadow.root && !(shadow.controls || []).length ? shadow.root.childNodes : []) {
        if (out.length >= LIMIT) break;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = textOf(child);
          if (text) out.push({ kind: 'text', depth: depth + 2, text });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child, depth + 2);
        }
      }
    }

    for (const child of el.childNodes) {
      if (out.length >= LIMIT) break;
      if (child.nodeType === Node.TEXT_NODE) {
        const text = textOf(child);
        if (text) out.push({ kind: 'text', depth: depth + 1, text });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child, depth + 1);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        const text = textOf(child);
        if (text) out.push({ kind: 'comment', depth: depth + 1, text: `<!-- ${text.slice(0, 200)} -->` });
      }
    }
    out.push({ kind: 'close', tag, depth, text: `</${tag}>` });
  };

  if (document.documentElement) walk(document.documentElement, 0);
  return out;
}
