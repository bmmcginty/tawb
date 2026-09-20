'use strict';

// PAGE view: the page as a reader should see it, derived from the DOM
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
// scope here — backslash reaches SOURCE when the hidden parts matter.

function extractVisible() {
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta',
    'link', 'title', 'svg', 'path', 'defs']);
  // Elements that start a new line of output regardless of their content.
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main',
    'nav', 'aside', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'tr', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'form', 'fieldset',
    'figure', 'figcaption', 'hr', 'br', 'address', 'details', 'summary']);
  const BUTTON_ROLES = new Set([
    'button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
    'checkbox', 'radio', 'option',
  ]);
  const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton']);

  const out = [];

  // See ax_own.js: a modal dialog makes the rest of the document inert, and
  // nothing in the markup or the style of those elements says so.
  let modal = null;
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    try { if (dialog.matches(':modal')) modal = dialog; } catch { /* older engine */ }
  }

  // See ax_own.js for all three answers. GONE takes the subtree with it;
  // INVISIBLE is this element alone, because `visibility` is inherited and a
  // descendant may set it back to `visible` and be rendered on its own.
  const GONE = 'gone';
  const INVISIBLE = 'invisible';
  const SHOWN = 'shown';

  const visibilityOf = (el) => {
    if (el.hasAttribute('inert')) return GONE;
    if (modal && !modal.contains(el) && !el.contains(modal)) return GONE;
    if (el.hasAttribute('hidden')) return GONE;
    if (el.getAttribute('aria-hidden') === 'true') return GONE;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none') return GONE;
    // This is the view of what is actually on screen, so unlike the
    // accessibility tree it takes opacity at its word: text painted at zero
    // opacity is not being shown to anybody.
    if (cs.opacity === '0') return GONE;
    // See ax_own.js: a closed <details> hides its contents by a route no
    // computed property reports, and this is the question that catches it —
    // but it answers for a box, and a display:contents element has none, so
    // it calls every one of them invisible and takes the children it renders
    // down with it.
    if (cs.display !== 'contents'
      && typeof el.checkVisibility === 'function' && !el.checkVisibility()) return GONE;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return INVISIBLE;
    return SHOWN;
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

  const explicitRoleOf = (el) => (el.getAttribute('role') || '').toLowerCase().split(/\s+/)[0];
  const interactionKind = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = explicitRoleOf(el);
    if (tag === 'button' || BUTTON_ROLES.has(role)
      || (tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(el.type))) {
      return 'button';
    }
    if ((tag === 'a' && el.hasAttribute('href')) || role === 'link') return 'link';
    if (['input', 'textarea', 'select'].includes(tag) || el.isContentEditable || FIELD_ROLES.has(role)) {
      return 'field';
    }
    return null;
  };
  const independentlyFocusable = (el) => interactionKind(el)
    && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && Number(el.tabIndex) >= 0;

  let walk = null;
  const walkNestedControls = (root) => {
    for (const child of kidsOf(root)) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (visibilityOf(child) === GONE) continue;
      if (independentlyFocusable(child)) walk(child, false);
      else walkNestedControls(child);
    }
  };

  walk = (el, inheritedBlock) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    const visibility = visibilityOf(el);
    if (visibility === GONE) return;
    // Nothing of this element's own is on screen, but the walk still goes
    // through it: a descendant may have asked to be visible again.
    const shown = visibility === SHOWN;

    const register = () => {
      nodes.push(el);
      return nodes.length - 1;
    };

    const explicitRole = explicitRoleOf(el);
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
    const own = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

    // Interactive and atomic elements: emit whole, do not descend.
    //
    // A file input is presented by the browser as a button, not a text field.
    // Keep that distinction and its upload metadata in this fallback view so
    // pressing it opens the same terminal path prompt as the AX view.
    if (shown && tag === 'input' && el.type === 'file') {
      const allFiles = Array.from(document.querySelectorAll('input[type="file"]'));
      const sameName = el.name ? allFiles.filter((one) => one.name === el.name) : [];
      const key = el.id ? `id:${el.id}`
        : (el.name ? `name:${el.name}:${sameName.indexOf(el)}` : `index:${allFiles.indexOf(el)}`);
      emit({
        kind: 'button',
        text: labelFor(el),
        file: {
          multiple: !!el.multiple,
          accept: el.getAttribute('accept') || '',
          key,
          names: Array.from(el.files || []).map((file) => file.name),
        },
        index: register(),
        block: true,
      });
      return;
    }
    //
    // A control is named by whatever names it — its own text, its value, or
    // the label it carries. A play button is an icon and a label and nothing
    // else, so a view that only looks at text drops it entirely: on a
    // Bandcamp album page every play button was missing here while the
    // accessibility view listed all twelve. And role="button" makes a button
    // whatever tag it was built from, which is how most of them are built.
    if (shown && (tag === 'button' || explicitRole === 'button'
      || (tag === 'input' && ['button', 'submit', 'reset'].includes(el.type)))) {
      const text = own || el.value || label;
      if (text) emit({ kind: 'button', text, index: register(), block: true });
      walkNestedControls(el);
      return;
    }
    if (shown && ((tag === 'a' && el.getAttribute('href') != null) || explicitRole === 'link')) {
      const text = own || label;
      // The resolved target, for the address line to show while the reader
      // stands on it — see ax_own.js. A div wearing role="link" has none.
      const href = typeof el.href === 'string' && el.href ? el.href : undefined;
      if (text) emit({ kind: 'link', text, href, index: register(), block: true });
      walkNestedControls(el);
      return;
    }
    const editingHost = el.isContentEditable
      && !(el.parentElement && el.parentElement.isContentEditable);
    if (shown && (tag === 'input' || tag === 'textarea' || tag === 'select'
      || editingHost || FIELD_ROLES.has(explicitRole))) {
      const ariaValue = (el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow') || '').trim();
      emit({
        kind: 'field',
        role: FIELD_ROLES.has(explicitRole) ? explicitRole : undefined,
        text: labelFor(el),
        value: ariaValue || (editingHost ? own : (el.value || '')),
        editable: editingHost ? 'content' : undefined,
        index: register(),
        block: true,
      });
      walkNestedControls(el);
      return;
    }
    if (shown && /^h[1-6]$/.test(tag)) {
      if (own) emit({ kind: 'heading', level: Number(tag[1]), text: own, index: register(), block: true });
      return;
    }
    if (shown && tag === 'img') {
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) emit({ kind: 'image', text: alt, index: register(), block: true });
      return;
    }
    if (shown && (tag === 'video' || tag === 'audio')) {
      // See ax_own.js: where a player has got to is asked of the element,
      // because the page stops saying. The source used to be here instead,
      // and on the sites where a player is worth reading it is a blob: URL
      // that names nothing.
      const clock = (seconds) => {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
        const whole = Math.floor(seconds);
        const pad = (n) => String(n).padStart(2, '0');
        return Math.floor(whole / 3600)
          ? `${Math.floor(whole / 3600)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`
          : `${Math.floor(whole / 60) % 60}:${pad(whole % 60)}`;
      };
      const parts = [el.paused ? 'paused' : 'playing'];
      const at = clock(el.currentTime);
      const of = clock(el.duration);
      if (at && of) parts.push(`${at} of ${of}`);
      else if (at) parts.push(`${at}, live`);
      if (el.muted || el.volume === 0) parts.push('muted');
      emit({ kind: 'media', tag, text: parts.join(', '), index: register(), block: true });
      return;
    }
    if (shown && (tag === 'iframe' || tag === 'frame')) {
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
        if (!shown) continue; // this element's own text is not on screen
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
      role: entry.role || ROLE_BY_KIND[entry.kind] || 'text',
      name: entry.text,
      level: entry.level,
      href: entry.href,
      editable: entry.editable,
      file: entry.file,
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
