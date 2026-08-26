'use strict';

const { roleForTag } = require('./dom');

// The fourth view: the page's live markup.
//
// AX and INSPECT answer what the page means, and PAGE answers what it visibly
// says. This answers what it is made of: real opening and closing tags, every
// attribute, and text where the text sits. Privileged shadow roots are marked
// explicitly; where Firefox cannot safely expose browser-owned media nodes,
// honest <native-control> descriptors stand in for them.
//
//   <p>
//     teenagers are just
//     <em>really</em>
//     dumb in general
//   </p>
//
// An element holding nothing but text is written on one line, since
// splitting `<em>really</em>` across three of them helps nobody. Everything
// else opens, indents and closes.
//
// It reads the live DOM rather than the bytes that came off the network, so
// it shows the page as it is now — after scripts have run, which is the
// state the other views describe and the only one worth comparing them to.

// Their content is code, not markup, and a page can carry hundreds of
// kilobytes of it. The tag is shown; the body is summarised.
const OPAQUE_TAGS = new Set(['script', 'style']);
// Nothing to close.
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
// A page that is mostly generated markup can serialise to a great many
// lines. Reading stays responsive because every view is a flat list, but
// there is no point holding a million rows nobody will reach.
const MAX_LINES = 20000;
const MAX_ATTR = 120;

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

// Deliberately not indented, for the same reason there is no marker on the
// focused line: leading spaces shift every line sideways, and sideways is
// expensive here. A reader who cannot see the shape of the indentation pays
// its whole cost — Home lands on whitespace, a braille display spends cells
// on blanks — and gets none of the benefit. Reddit nests its comments twenty
// levels deep, which at two spaces a level is half a terminal gone before
// any markup appears.
//
// The tags say what the indentation would have: every element opens and
// closes on its own line unless it fits on one.

function sourceEntriesToBlocks(entries, frame) {
  return entries.map((entry) => {
    const { text } = entry;
    if (entry.kind === 'element') {
      return {
        kind: 'control',
        text,
        item: {
          // The same role vocabulary the other views use, so h/l/f/b quick
          // navigation behaves identically here.
          role: roleForTag(entry.tag),
          name: entry.text,
          tag: entry.tag,
          attrs: entry.attrs,
          domIndex: entry.index,
          frame,
        },
        spans: [],
      };
    }
    // Text, comments and closing tags are structure, not something to act on.
    return { kind: 'control', text, item: { role: 'text', name: entry.text, frame }, spans: [] };
  }).filter((b) => b.text.trim());
}

async function snapshotSourceBlocks(target) {
  const frame = typeof target.mainFrame === 'function' ? target.mainFrame() : target;
  return sourceEntriesToBlocks(await target.evaluate(extractSource), frame);
}

module.exports = {
  snapshotSourceBlocks, sourceEntriesToBlocks, extractSource,
  OPAQUE_TAGS, VOID_TAGS, MAX_LINES, MAX_ATTR,
};
