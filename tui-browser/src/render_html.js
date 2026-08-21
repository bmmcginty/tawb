'use strict';

// The third view: the page as a reader should see it, derived from the DOM
// rather than from the accessibility tree.
//
// It produces the same shape of output as AX mode — {links}, [*buttons],
// [fields], ## headings, prose — but it is built from what is actually
// rendered. That matters when a page's semantics are broken: bogus ARIA, a
// <video> whose only accessible text is "your browser does not support
// videos", widgets that expose nothing at all. When the AX tree is wrong,
// this shows the page anyway.
//
// Only visible content is included. Anything hidden is deliberately out of
// scope here — backslash reaches raw HTML mode when the hidden parts matter.

function extractVisible() {
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta',
    'link', 'title', 'svg', 'path', 'defs']);
  // Elements that start a new line of output regardless of their content.
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main',
    'nav', 'aside', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'form', 'fieldset',
    'figure', 'figcaption', 'hr', 'br', 'address', 'details', 'summary']);

  const out = [];

  const isHidden = (el) => {
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    // See ax_own.js: a closed <details> hides its contents by a route no
    // computed property reports, and this is the question that catches it —
    // but it answers for a box, and a display:contents element has none, so
    // it calls every one of them invisible and takes the children it renders
    // down with it.
    if (cs.display !== 'contents'
      && typeof el.checkVisibility === 'function' && !el.checkVisibility()) return true;
    if (cs.opacity === '0') return true;
    if (el.hasAttribute('hidden')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    return false;
  };

  const nodes = [];
  window[Symbol.for('tweb.render')] = nodes;

  const emit = (entry) => out.push(entry);

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


  const labelFor = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
    return el.getAttribute('placeholder') || el.getAttribute('name') || el.type || 'field';
  };

  const walk = (el, inheritedBlock) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (isHidden(el)) return;

    const register = () => {
      nodes.push(el);
      return nodes.length - 1;
    };

    const explicitRole = (el.getAttribute('role') || '').toLowerCase();
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const own = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

    // Interactive and atomic elements: emit whole, do not descend.
    //
    // A control is named by whatever names it — its own text, its value, or
    // the label it carries. A play button is an icon and a label and nothing
    // else, so a view that only looks at text drops it entirely: on a
    // Bandcamp album page every play button was missing here while the
    // accessibility view listed all twelve. And role="button" makes a button
    // whatever tag it was built from, which is how most of them are built.
    if (tag === 'button' || explicitRole === 'button'
      || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type))) {
      const text = own || el.value || label;
      if (text) emit({ kind: 'button', text, index: register(), block: true });
      return;
    }
    if ((tag === 'a' && el.getAttribute('href') != null) || explicitRole === 'link') {
      const text = own || label;
      if (text) emit({ kind: 'link', text, index: register(), block: true });
      return;
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      emit({ kind: 'field', text: labelFor(el), value: el.value || '', index: register(), block: true });
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      if (own) emit({ kind: 'heading', level: Number(tag[1]), text: own, index: register(), block: true });
      return;
    }
    if (tag === 'img') {
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) emit({ kind: 'image', text: alt, index: register(), block: true });
      return;
    }
    if (tag === 'video' || tag === 'audio') {
      emit({ kind: 'media', tag, text: el.currentSrc || el.getAttribute('src') || '(no source)', index: register(), block: true });
      return;
    }
    if (tag === 'iframe' || tag === 'frame') {
      emit({ kind: 'frame', text: el.getAttribute('title') || el.getAttribute('src') || '', index: register(), block: true });
      return;
    }

    const isBlock = BLOCK.has(tag) || inheritedBlock;
    const startsParagraph = tag === 'p';

    // Only the first text in an element begins a line. The rest continue it,
    // because what separates them is inline styling: "teenagers are just
    // <em>really</em> dumb in general" is three text nodes and one sentence,
    // and the text after the </em> is no more a new line than the emphasis
    // was. A block-level child does end the run, so a paragraph nested here
    // still starts fresh.
    let opened = false;

    for (const child of kidsOf(el)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        emit({
          kind: 'text',
          text,
          block: isBlock && !opened,
          paragraph: startsParagraph && !opened,
        });
        opened = true;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child, false);
        if (BLOCK.has(child.tagName.toLowerCase())) opened = false;
      }
    }
  };

  if (document.body) walk(document.body, true);
  return out;
}

function renderEntry(entry) {
  switch (entry.kind) {
    case 'heading': return '#'.repeat(entry.level) + ' ' + entry.text;
    case 'link': return `{${entry.text}}`;
    case 'button': return `[*${entry.text}]`;
    case 'field': return `[${entry.value ? entry.text + ': ' + entry.value : entry.text}]`;
    case 'image': return `(image) ${entry.text}`;
    case 'media': return `(${entry.tag}) ${entry.text}`;
    case 'frame': return entry.text ? `<frame: ${entry.text}>` : '<frame>';
    default: return entry.text;
  }
}

const ROLE_BY_KIND = {
  heading: 'heading',
  link: 'link',
  button: 'button',
  field: 'textbox',
  image: 'img',
  media: 'video',
  frame: 'iframe',
  text: 'text',
};

async function snapshotRenderBlocks(target) {
  const frame = typeof target.mainFrame === 'function' ? target.mainFrame() : target;
  const entries = await target.evaluate(extractVisible);

  return entries.map((entry) => ({
    kind: 'control',
    text: renderEntry(entry),
    startsBlock: !!entry.block,
    isParagraph: !!entry.paragraph,
    item: {
      role: ROLE_BY_KIND[entry.kind] || 'text',
      name: entry.text,
      level: entry.level,
      renderIndex: entry.index,
      frame,
    },
    spans: [],
  })).filter((b) => b.text);
}

// Render-mode items are located through their own page-side node array.
async function renderElementHandle(page, item) {
  const target = item.frame || page;
  return target.evaluateHandle(
    (i) => window[Symbol.for('tweb.render')] && window[Symbol.for('tweb.render')][i],
    item.renderIndex,
  );
}

module.exports = { snapshotRenderBlocks, renderElementHandle, extractVisible };
