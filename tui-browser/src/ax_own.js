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
function extractAxItems() {
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
  window.__twebAxNodes = nodes;
  const out = [];

  // The flattened tree — what the browser actually renders, and what it
  // exposes to a screen reader. An element with a shadow root renders that
  // tree rather than its own children, and a <slot> renders what was assigned
  // to it. Stopping at childNodes stops at every web component: Playwright's
  // tree descends into them on Chromium, so ours has to as well or the two
  // engines describe different pages.
  const kidsOf = (node) => {
    if (node.shadowRoot) return Array.from(node.shadowRoot.childNodes);
    if (typeof node.assignedNodes === 'function') {
      const assigned = node.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  };

  const hidden = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.hasAttribute('hidden')) return true;
    const cs = window.getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse';
  };

  // Three answers, not two. "Collapsed" is a promise that pressing this
  // opens something; "no aria-expanded at all" is a plain control with
  // nothing behind it. Collapsing those two into false would announce every
  // button on the page as closed.
  const expandedOf = (el) => {
    const attr = el.getAttribute('aria-expanded');
    if (attr === 'true') return true;
    if (attr === 'false') return false;
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

  const emit = (item) => out.push(item);
  const boundary = () => emit({ role: '__break__', name: '' });

  const walk = (el) => {
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
        axIndex: register(el),
      });
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
