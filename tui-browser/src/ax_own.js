'use strict';

// The accessibility tree, computed by us.
//
// Used only where Playwright is not available to do it — which today means
// Firefox. Chromium keeps using Playwright's, deliberately: the working path
// is not put at risk by a second implementation of the hardest thing in this
// program, and having the two side by side means `npm run compare` can hold
// them against each other on real pages.
//
// This is not the full W3C accessible-name algorithm and does not pretend to
// be. It is the part of it a reader actually depends on, in the order the
// specification checks them: aria-labelledby, then aria-label, then the native
// mechanism for that element (a label element, alt text, a caption), then the
// element's own text where the role permits naming from content. The
// recursion into labelledby is depth-limited rather than cycle-tracked,
// because a page that nests labels three deep is not the case worth the code.
//
// What it deliberately shares with the Playwright path is everything after
// this point: the items produced here go through the same buildBlocks, so
// prose merging, separator folding and line layout behave identically in both
// browsers, and a difference between them is a difference in the tree rather
// than in the rendering.

// Roles whose accessible name may come from the text inside them. Everything
// else has to be named explicitly, which is what stops a whole <div> of prose
// from becoming one enormous name.
const NAME_FROM_CONTENT = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem',
]);

// Elements we never descend into or emit: no content, or content that is not
// text a reader wants.
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title',
  'svg', 'path', 'defs', 'symbol', 'canvas', 'br', 'wbr',
]);

// Tag to role, for the elements that carry one implicitly. Anything absent
// here is a generic container, which the flattener treats as structure rather
// than content.
const IMPLICIT_ROLES = {
  a: 'link', area: 'link', button: 'button', h1: 'heading', h2: 'heading',
  h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img',
  select: 'combobox', textarea: 'textbox', iframe: 'iframe', frame: 'iframe',
  table: 'table', thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup',
  tr: 'row', td: 'cell', th: 'columnheader', caption: 'caption',
  ul: 'list', ol: 'list', li: 'listitem', dl: 'DescriptionList',
  dt: 'DescriptionListTerm', dd: 'DescriptionListDetail',
  nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  aside: 'complementary', form: 'form', search: 'search', section: 'region',
  article: 'article', figure: 'figure', figcaption: 'caption',
  blockquote: 'blockquote', p: 'paragraph', hr: 'separator',
  em: 'emphasis', i: 'emphasis', strong: 'strong', b: 'strong',
  code: 'code', kbd: 'code', samp: 'code', pre: 'generic',
  sub: 'subscript', sup: 'superscript', del: 'deletion', ins: 'insertion',
  time: 'time', output: 'status', progress: 'progressbar', meter: 'meter',
  dialog: 'dialog', details: 'group', summary: 'button', video: 'video',
  audio: 'audio', label: 'generic', option: 'option', fieldset: 'group',
  legend: 'caption', abbr: 'generic', q: 'generic', cite: 'generic',
  dfn: 'term', mark: 'mark', small: 'generic', span: 'generic', div: 'generic',
};

// input types map to quite different roles, which is the whole reason the
// field vocabulary exists.
const INPUT_ROLES = {
  button: 'button', submit: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  text: 'textbox', password: 'textbox', date: 'textbox', month: 'textbox',
  week: 'textbox', time: 'textbox', 'datetime-local': 'textbox',
  color: 'textbox', file: 'button', hidden: null,
};

// Runs in the page, so it is one self-contained function with its tables
// inlined — it is serialised across and cannot close over anything here.
// `options.pairs` is a list of [host, closedShadowRoot] the driver found and
// is handing in for this call only. Nothing is written to the page to carry
// it: a mark left on a page's own elements is a mark on the one document
// where being noticed matters most — a challenge frame — and it undoes the
// very thing a closed shadow root was closed for.
//
// `options.pierce` is Firefox's route to the same list, where the pairs come
// from a privileged function installed at startup rather than over a
// protocol, and so can only be fetched from inside the page.
function extractAxItems(options) {
  const NAME_FROM_CONTENT = new Set(['button', 'cell', 'checkbox', 'columnheader',
    'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta',
    'link', 'title', 'svg', 'path', 'defs', 'symbol', 'canvas', 'br', 'wbr']);
  const IMPLICIT = {
    a: 'link', area: 'link', button: 'button', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', img: 'img',
    select: 'combobox', textarea: 'textbox', iframe: 'iframe', frame: 'iframe',
    table: 'table', thead: 'rowgroup', tbody: 'rowgroup', tfoot: 'rowgroup',
    tr: 'row', td: 'cell', th: 'columnheader', caption: 'caption',
    ul: 'list', ol: 'list', li: 'listitem', dl: 'DescriptionList',
    dt: 'DescriptionListTerm', dd: 'DescriptionListDetail',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', form: 'form', search: 'search', section: 'region',
    article: 'article', figure: 'figure', figcaption: 'caption',
    blockquote: 'blockquote', p: 'paragraph', hr: 'separator',
    em: 'emphasis', i: 'emphasis', strong: 'strong', b: 'strong',
    code: 'code', kbd: 'code', samp: 'code', pre: 'generic',
    sub: 'subscript', sup: 'superscript', del: 'deletion', ins: 'insertion',
    time: 'time', output: 'status', progress: 'progressbar', meter: 'meter',
    dialog: 'dialog', details: 'group', summary: 'button', video: 'video',
    audio: 'audio', label: 'generic', option: 'option', fieldset: 'group',
    legend: 'caption', abbr: 'generic', q: 'generic', cite: 'generic',
    dfn: 'term', mark: 'mark', small: 'generic', span: 'generic', div: 'generic',
  };
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    text: 'textbox', password: 'textbox', date: 'textbox', month: 'textbox',
    week: 'textbox', time: 'textbox', 'datetime-local': 'textbox',
    color: 'textbox', file: 'button', hidden: null,
  };
  // Roles that are their own line and whose name covers everything inside.
  const ATOMIC = new Set(['link', 'button', 'heading', 'img', 'menuitem', 'tab',
    'switch', 'checkbox', 'radio', 'option']);
  const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider',
    'spinbutton']);
  // Containers that only style a run of text, so content flows through them.
  const INLINE = new Set(['generic', 'none', 'presentation', 'emphasis', 'strong',
    'code', 'subscript', 'superscript', 'insertion', 'deletion', 'time', 'term',
    'mark']);

  // Invisible characters are not whitespace as far as a regular expression is
  // concerned, so collapsing \s leaves them behind — and a zero-width space
  // reaching a braille display is a cell spent on nothing. Wikipedia puts them
  // between scripts. Zero-width joiners are left alone: they carry meaning in
  // Arabic, Indic scripts and emoji sequences.
  const clean = (s) => String(s == null ? '' : s)
    .replace(/[\u200b\ufeff\u00ad]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const nodes = [];
  window[Symbol.for('tweb.ax')] = nodes;
  const out = [];

  // The flattened tree — what the browser actually renders, and what it
  // exposes to a screen reader. An element with a shadow root renders that
  // tree rather than its own children, and a <slot> renders what was assigned
  // to it. Stopping at childNodes stops at every web component: Playwright's
  // tree descends into them on Chromium, so ours has to as well or the two
  // engines describe different pages.
  const opts = options || {};
  const closedRoots = new Map();
  for (const pair of opts.pairs || []) {
    if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
  }
  const privileged = window[Symbol.for('tweb.pierce')];
  if (opts.pierce && typeof privileged === 'function') {
    try {
      for (const pair of privileged() || []) {
        if (pair && pair[0] && pair[1]) closedRoots.set(pair[0], pair[1]);
      }
    } catch { /* the privileged half is not installed here */ }
  }

  const kidsOf = (node) => {
    // A closed shadow root is invisible to page script by design: node.shadowRoot
    // is null and there is no other way in from here. Both drivers can reach
    // one — Chromium over the DevTools protocol, Firefox through a privileged
    // process script — and hand the pairs to this call, so the walk goes on
    // from here as if the root had been open.
    const closed = closedRoots.get(node);
    if (closed) return Array.from(closed.childNodes);
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  };

  // A modal dialog puts itself in the top layer and makes the whole of the
  // rest of the document inert — unfocusable, unclickable, and hidden from
  // assistive technology. There is no attribute anywhere to say so, which is
  // why it has to be asked of the document once and carried into the walk:
  // without it the reader is handed the entire page behind a cookie banner or
  // a login box, every control on it dead.
  let modal = null;
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    try { if (dialog.matches(':modal')) modal = dialog; } catch { /* older engine */ }
  }

  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    // Inert content is still on screen and still has a box, so nothing about
    // its style says it is gone; the specification says to hide it from
    // assistive technology all the same, and a control the browser refuses to
    // activate is worse than absent when it is the reader's only clue.
    if (el.hasAttribute('inert')) return true;
    // Everything outside the modal is inert. Its own ancestors are not — the
    // walk has to reach it through them.
    if (modal && !modal.contains(el) && !el.contains(modal)) return true;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    // display:contents is an element that generates no box of its own and
    // renders its children in its place. checkVisibility() answers for a box,
    // so it says false for every one of them — rendered or not. Asking it here
    // deleted whole pages: GitHub's issue list wraps the sidebar and the
    // issues themselves in one display:contents section, and the reader was
    // shown the header and the footer with nothing in between. Each child is
    // asked the question on its own account, so a pass-through box that is
    // genuinely inside something hidden still loses its contents.
    if (cs.display === 'contents') return false;
    // Content the browser is not rendering, whatever the mechanism. Computed
    // style is not enough on its own: the contents of a closed <details> come
    // back display:block, visibility:visible, content-visibility:visible and
    // with a client rect, and are hidden all the same — Chromium and Firefox
    // both answer false here and both are right. Without this the reader is
    // read the inside of every collapsed disclosure on the page as though it
    // were open, which is the opposite of what the control says.
    //
    // Default options on purpose: content-visibility:auto is content the
    // browser has merely not got to yet, and skipping that would drop
    // exactly the off-screen text this program exists to reach.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return true;
    return false;
  };

  // Three answers, not two. "Collapsed" is a promise that pressing this
  // opens something; "no aria-expanded at all" is a plain control with
  // nothing behind it. Collapsing those two into false would announce every
  // button on the page as closed.
  const expandedOf = (el) => {
    const attr = el.getAttribute('aria-expanded');
    if (attr === 'true') return true;
    if (attr === 'false') return false;
    // A native disclosure says the same thing in its own way: <details>
    // carries the state and <summary> is the control that opens it, with no
    // aria-expanded anywhere. The page is not obliged to spell out in ARIA
    // what the element already means, and a reader that only reads the
    // attribute would announce the one native disclosure control the web has
    // as though it opened nothing.
    const parent = el.parentElement;
    if (el.tagName === 'SUMMARY' && parent && parent.tagName === 'DETAILS') {
      return !!parent.open;
    }
    return undefined;
  };

  const roleOf = (el) => {
    const explicit = clean(el.getAttribute('role')).split(' ')[0];
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return Object.prototype.hasOwnProperty.call(INPUT_ROLES, type)
        ? INPUT_ROLES[type] : 'textbox';
    }
    // An anchor without href is not a link, which is the one implicit-role
    // rule pages actually trip over.
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    return Object.prototype.hasOwnProperty.call(IMPLICIT, tag) ? IMPLICIT[tag] : 'generic';
  };

  // Text as a reader would hear it. Not innerText: a link whose content is an
  // image has no text at all, and its name is the image's alt — so the
  // traversal has to ask each child for its accessible name rather than for
  // its characters. Wikipedia's logo link is exactly this, and reading it as
  // nameless dropped it from the tree entirely.
  // Whether a child contributes a space to its parent's name. Inline children
  // do not: Wikipedia writes an IPA pronunciation as one element per
  // character, and joining those with spaces turns /breɪl/ into "/ b r eɪ l /".
  const blockLevel = (el) => {
    const display = window.getComputedStyle(el).display;
    return display === 'block' || display === 'flex' || display === 'grid'
      || display === 'list-item' || display.startsWith('table');
  };

  const nameFromContent = (el, depth) => {
    // Built raw and cleaned once at the end, so the whitespace the source
    // actually had decides the spacing rather than a join character.
    let raw = '';
    for (const child of kidsOf(el)) {
      if (child.nodeType === Node.TEXT_NODE) {
        raw += child.data || '';
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        if (SKIP.has(child.tagName.toLowerCase())) continue;
        if (hidden(child)) continue;
        const name = accessibleName(child, depth + 1, true);
        if (!name) continue;
        raw += blockLevel(child) ? ` ${name} ` : name;
      }
    }
    return clean(raw);
  };

  const contentText = (el) => clean(el.innerText || el.textContent || '');

  const referencedText = (el, attr, depth) => {
    const ids = clean(el.getAttribute(attr));
    if (!ids) return '';
    const parts = [];
    for (const id of ids.split(' ')) {
      if (!id) continue;
      let target = null;
      try { target = document.getElementById(id); } catch { target = null; }
      if (target) parts.push(accessibleName(target, depth + 1, true));
    }
    return clean(parts.join(' '));
  };

  function accessibleName(el, depth = 0, fromReference = false) {
    // Deep enough for real markup, shallow enough that a pathological page
    // cannot walk forever. The DOM traversal cannot cycle; only labelledby
    // can, and it shares the budget.
    if (depth > 10) return '';

    if (el.hasAttribute('aria-labelledby')) {
      const referenced = referencedText(el, 'aria-labelledby', depth);
      if (referenced) return referenced;
    }
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;

    const tag = el.tagName.toLowerCase();

    // Native mechanisms, per element.
    if (tag === 'img' || tag === 'area') {
      const alt = clean(el.getAttribute('alt'));
      if (alt) return alt;
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) {
        let labelled = null;
        try { labelled = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); } catch { /* bad id */ }
        if (labelled) {
          const text = clean(labelled.innerText || labelled.textContent);
          if (text) return text;
        }
      }
      const wrapping = el.closest('label');
      if (wrapping) {
        const text = clean(wrapping.innerText || wrapping.textContent);
        if (text) return text;
      }
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && ['button', 'submit', 'reset'].includes(type)) {
        const value = clean(el.value);
        if (value) return value;
      }
      const placeholder = clean(el.getAttribute('placeholder'));
      if (placeholder) return placeholder;
    }
    if (tag === 'fieldset') {
      const legend = el.querySelector('legend');
      if (legend) return clean(legend.innerText || legend.textContent);
    }
    if (tag === 'table') {
      const caption = el.querySelector('caption');
      if (caption) return clean(caption.innerText || caption.textContent);
    }

    const role = roleOf(el);
    if (NAME_FROM_CONTENT.has(role) || fromReference) {
      const text = nameFromContent(el, depth);
      if (text) return text;
    }

    return clean(el.getAttribute('title'));
  }

  const valueOf = (el, role) => {
    if (!FIELDS.has(role)) return undefined;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return clean(el.value) || undefined;
    if (tag === 'select') return clean(el.selectedOptions?.[0]?.textContent) || undefined;
    if (el.isContentEditable) return contentText(el) || undefined;
    return undefined;
  };

  const register = (el) => {
    nodes.push(el);
    return nodes.length - 1;
  };

  const emit = (item) => {
    if (item.role !== '__break__') {
      if (insidePopup) item.popup = insidePopup;
      if (insideClosed) item.pierced = true;
    }
    out.push(item);
  };
  const boundary = () => emit({ role: '__break__', name: '' });

  // The popup whose subtree we are inside, if any; see ownedPopups below.
  let insidePopup = null;
  // Whether we are inside a closed shadow root the driver opened for us.
  // Carried on the items so that activating one knows it has to be a real
  // click: a closed shadow root is what a bot check is built out of, and the
  // DOM's own default action is not a person pressing anything.
  let insideClosed = false;

  // Which elements are somebody's popup, and whose.
  //
  // A menu or a listbox is very often not where the control that opens it is.
  // Frameworks render it into the end of <body> — a "portal" — so that no
  // ancestor's overflow or stacking can clip it, which for a reader means the
  // menu they just opened appears hundreds of lines below where they are
  // standing, with nothing to say it is theirs. `aria-controls` (or the older
  // `aria-owns`) is the thread back, and it is the only one there is.
  const ownedPopups = new Map();
  for (const opener of document.querySelectorAll('[aria-controls],[aria-owns]')) {
    // A control that opens something says so. Without that test this would
    // also collect tab panels, live regions and form descriptions, none of
    // which want moving.
    if (!opener.hasAttribute('aria-haspopup') && !opener.hasAttribute('aria-expanded')) continue;
    const named = opener.getAttribute('aria-controls') || opener.getAttribute('aria-owns') || '';
    for (const id of named.split(/\s+/)) {
      if (!id) continue;
      const target = document.getElementById(id);
      if (target) ownedPopups.set(target, id);
    }
  }
  // The id of what this control opens, if it says it opens anything.
  //
  // Deliberately not checking that the element exists: a portaled menu does
  // not exist until it is opened, which is exactly the moment we need to have
  // been told about it. The attribute declares the relationship; whether the
  // other end is in the document yet is a separate question, answered by
  // ownedPopups when it is.
  const opensPopup = (el) => {
    if (!el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-expanded')) return undefined;
    const named = el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '';
    return named.split(/\s+/)[0] || undefined;
  };

  const walkInner = (el) => {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (hidden(el)) return;

    const role = roleOf(el);

    // A frame marks where embedded content begins; its own lines are spliced
    // in after it by the frame walker.
    if (role === 'iframe') {
      emit({ role: 'iframe', name: accessibleName(el), axIndex: register(el) });
      return;
    }

    if (ATOMIC.has(role)) {
      const name = accessibleName(el);
      if (name) {
        const item = { role, name, axIndex: register(el) };
        if (role === 'heading') {
          item.level = el.getAttribute('aria-level')
            || (/^h[1-6]$/.test(tag) ? tag[1] : undefined);
        }
        const checked = el.getAttribute('aria-checked');
        if (checked === 'true' || el.checked === true) item.checked = true;
        // A menu button is an atomic role, and whether its menu is open is
        // the only thing that distinguishes pressing it from having pressed
        // it. Carried here as well as on fields for that reason.
        const expanded = expandedOf(el);
        if (expanded !== undefined) item.expanded = expanded;
        const controls = opensPopup(el);
        if (controls) item.controls = controls;
        emit(item);
      }
      return; // the name already covers everything inside
    }

    if (FIELDS.has(role)) {
      emit({
        role,
        name: accessibleName(el),
        value: valueOf(el, role),
        expanded: expandedOf(el),
        controls: opensPopup(el),
        axIndex: register(el),
      });

      // A listbox is the one field whose contents are the point of it. Every
      // other field holds a value; a listbox holds the choices, and returning
      // here meant a page's own dropdown had no entries in the buffer at all
      // — the reader could open it and find nothing inside.
      //
      // A native <select> is excluded on purpose. Its options are in the DOM
      // too, but they are not part of the reading order: they are reached by
      // opening the control, which splices them in and takes them out again,
      // and a sixty-entry year field does not belong in the middle of the
      // page it sits on.
      if (role === 'listbox' && tag !== 'select') {
        for (const child of kidsOf(el)) {
          if (child.nodeType === Node.ELEMENT_NODE) walk(child);
        }
      }
      return;
    }

    // A structural container: let the contents speak. Block-level ones end
    // the current run of flowing text, which is what keeps a list of links
    // from merging into one unreadable paragraph.
    const blockLevel = !INLINE.has(role);
    if (blockLevel) boundary();

    const before = out.length;
    for (const child of kidsOf(el)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = clean(child.data);
        if (text) emit({ role: 'text', name: text });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }

    // Nothing inside produced anything, so the container's own name is the
    // only place its content exists — a table cell holding a bare string.
    const produced = out.slice(before).some((i) => i.role !== '__break__');
    if (!produced) {
      const name = accessibleName(el);
      if (name) emit({ role: 'text', name });
    }

    if (blockLevel) boundary();
  };

  // Everything emitted from inside a popup is tagged with whose it is, so
  // that whatever assembles the buffer can put it where the reader is rather
  // than where the page happened to render it.
  const walk = (el) => {
    const outerPopup = insidePopup;
    const outerClosed = insideClosed;
    if (ownedPopups.has(el)) insidePopup = ownedPopups.get(el);
    if (closedRoots.has(el)) insideClosed = true;
    try {
      walkInner(el);
    } finally {
      insidePopup = outerPopup;
      insideClosed = outerClosed;
    }
  };

  if (document.body) walk(document.body);

  // Collapse the runs of boundaries that nesting produces, so consumers see
  // at most one between runs — the same shape the Playwright path produces.
  const collapsed = [];
  for (const item of out) {
    if (item.role === '__break__') {
      if (collapsed.length === 0) continue;
      if (collapsed[collapsed.length - 1].role === '__break__') continue;
    }
    collapsed.push(item);
  }
  while (collapsed.length && collapsed[collapsed.length - 1].role === '__break__') collapsed.pop();
  return collapsed;
}

module.exports = {
  extractAxItems, NAME_FROM_CONTENT, SKIP_TAGS, IMPLICIT_ROLES, INPUT_ROLES,
};
