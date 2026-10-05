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
//
// ## Pictures the page paints and no text accounts for
//
// A sighted user of https://celticchoir.ca/ finds the dropdown menus by
// seeing a small triangle beside three of the seven menu items, thinking
// "there is more to see there", and only then moving the pointer. The
// triangle is a CSS background image on the menu link, so the triangle is in
// no tag, in no attribute and in no text node, and nothing about it reaches
// the accessibility tree: a background image has no role and no accessible
// name. The reader is left with seven identical-looking links, three of which
// lead somewhere the other four do not.
//
// So this view reports the picture. A decoration on a control or a heading is
// a property of that control rather than a thing beside it, and is said as a
// suffix on the same line:
//
//   {About Us} (image: s5 menu arrow)
//   {Links}
//
// An element that paints a picture and says nothing gets a line of its own,
// and so does an <img> whose alt attribute the page never wrote. Until a
// browser engine will answer "does anything happen when the pointer is over
// this", naming the picture is the nearest a reader can get to the cue the
// sighted user is acting on. `Alt+M` then does the pointer's half.
//
// What is deliberately not reported, each for a reason the page itself gave:
//
//   alt=""                 The one way HTML has to say "this picture carries
//                          nothing". Saying it anyway argues with the page.
//   aria-hidden="true"     The same statement in ARIA, and the form every one
//                          of the 115 unnamed <svg> icons on a GitHub
//                          repository page takes. visibilityOf already drops
//                          these, which is why <svg> needs no case of its own.
//   a gradient             background-image also carries gradients, which are
//                          colour rather than picture. Only a url() counts,
//                          so a gradient is skipped by construction and a
//                          `linear-gradient(...), url(...)` pair still reports
//                          the url() layer.
//
// Nothing is filtered by size. A page-wide photographic backdrop is a picture
// the sighted user is looking at, so a line saying so is right rather than
// noisy, and on the three pages measured here — celticchoir.ca, an English
// Wikipedia article and github.com/nodejs/node — background images number 14,
// 45 and 0 against 242, 3387 and 2993 visible elements. Pictures without text
// are rare, and a threshold invented to thin them out would drop real content
// silently.

function extractVisible(options) {
  // Whether to record the inline-flow and table-cell placement the Lynx
  // display lays a page out with. The ordinary PAGE view never reads it, so
  // by default the per-item closest() walk is not run at all.
  const layout = !!(options && options.layout);
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

  // Where a cell's content came from, for the Lynx interface that lays a row
  // out as a row. See ax_own.js for why it is computed from the element
  // rather than carried down the walk, and for what the fields mean. The two
  // copies have to agree, which is the same constraint the role tables in
  // both files already carry.
  const tableIds = new WeakMap();
  const rowNumbers = new WeakMap();
  const cellNumbers = new WeakMap();
  let tableCount = 0;

  // Flattening turns the text and links inside a paragraph into independent
  // entries. Keep the nearest HTML block container as their shared identity,
  // so the Lynx display can put only genuine inline neighbours back together.
  // The ordinary PAGE view deliberately ignores this field.
  const FLOW_ROOTS = [
    'body', 'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav',
    'aside', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'tr', 'td',
    'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'form',
    'fieldset', 'figure', 'figcaption', 'address', 'details', 'summary',
  ].join(',');
  const flowIds = new WeakMap();
  let flowCount = 0;

  const flowRootOf = (el) => (el && typeof el.closest === 'function'
    ? el.closest(FLOW_ROOTS) : null);
  const breakFlow = (el) => {
    const root = flowRootOf(el);
    if (root) flowIds.delete(root);
  };

  const flowOf = (el, kind) => {
    const root = flowRootOf(el);
    if (!root) return undefined;
    if (kind !== 'text' && (el === root || (el.querySelector && el.querySelector(FLOW_ROOTS)))) {
      return undefined;
    }
    if (!flowIds.has(root)) flowIds.set(root, (flowCount += 1));
    return flowIds.get(root);
  };

  const numberedTable = (table) => {
    if (!tableIds.has(table)) tableIds.set(table, (tableCount += 1));
    return tableIds.get(table);
  };

  const tableInfoOf = (el) => {
    if (!el || typeof el.closest !== 'function') return undefined;
    const cell = el.closest('td,th');
    if (cell) {
      const row = cell.parentElement && cell.parentElement.tagName === 'TR'
        ? cell.parentElement
        : cell.closest('tr');
      const table = row && row.closest('table');
      if (!row || !table) return undefined;
      const id = numberedTable(table);

      let rows = rowNumbers.get(table);
      if (!rows) {
        rows = new Map();
        for (const [index, one] of Array.from(table.rows || []).entries()) rows.set(one, index);
        rowNumbers.set(table, rows);
      }
      let cells = cellNumbers.get(row);
      if (!cells) {
        cells = new Map();
        let index = 0;
        for (const child of Array.from(row.children || [])) {
          if (child.tagName === 'TD' || child.tagName === 'TH') cells.set(child, index++);
        }
        cellNumbers.set(row, cells);
      }

      const colspan = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
      const rowspan = Math.max(1, Number(cell.getAttribute('rowspan')) || 1);
      return {
        id,
        row: rows.get(row) || 0,
        cell: cells.get(cell) || 0,
        header: cell.tagName === 'TH',
        ...(colspan > 1 ? { colspan } : {}),
        ...(rowspan > 1 ? { rowspan } : {}),
      };
    }

    const caption = el.closest('caption');
    if (caption) {
      const table = caption.closest('table');
      if (table) return { id: numberedTable(table), caption: true };
    }
    return undefined;
  };

  const emit = (entry, el) => {
    if (el && layout) {
      const table = tableInfoOf(el);
      if (table) entry.table = table;
      const flow = flowOf(el, entry.kind);
      if (flow) entry.flow = flow;
    }
    out.push(entry);
  };

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

  // The first url() in a CSS value, which is what makes a gradient skip
  // itself: `linear-gradient(...)` holds no url() and yields nothing, while
  // `linear-gradient(...), url("icon.svg")` yields the icon.
  const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/;

  // A speakable name for a picture, from the only thing naming it: its
  // address. The file name is the part that carries meaning — a reader told
  // "s5 menu arrow" has the word "arrow", and a reader told the whole
  // 70-character URL has to hear a template path first. Separators become
  // spaces because a screen reader reads `s5_menu_arrow` as one word or
  // spells the underscores, and neither is the name.
  //
  // An embedded image has no file name at all. Wikipedia paints two of its
  // icons from `data:image/svg+xml,%3Csvg…`, an entire inline SVG document,
  // and the honest thing to say about one is what kind of picture it is.
  const nameForImageUrl = (raw) => {
    const url = String(raw || '').trim();
    if (!url) return null;
    if (/^data:/i.test(url)) {
      const type = (url.match(/^data:([^;,]*)/i) || [])[1] || '';
      const subtype = type.split('/')[1] || '';
      return `embedded ${subtype.replace(/\+.*$/, '') || 'image'}`;
    }
    if (/^blob:/i.test(url)) return 'embedded image';
    let file = url.split(/[?#]/)[0].split('/').pop() || '';
    // A file name reaches us percent-encoded, and the encoding is not the
    // name: Wikipedia's photograph of a Celtic festival arrives as
    // `330px-Keltfest_2010_%284610513447%29.jpg`, whose brackets a reader
    // should hear as brackets. A malformed sequence throws, and the raw name
    // is still better than nothing.
    try { file = decodeURIComponent(file); } catch { /* keep it encoded */ }
    const stem = file.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
    return stem || null;
  };

  const imageLabel = (value) => {
    const match = CSS_URL.exec(value || '');
    if (!match) return null;
    return nameForImageUrl(match[1] || match[2] || match[3] || '');
  };

  // Every picture this one element paints. Generated content is asked the
  // same question a real box is, and for the same reason pseudoText in
  // ax_own.js asks it: a ::before that is itself display:none paints nothing.
  const decorationsOf = (el) => {
    const found = [];
    let own = null;
    try { own = window.getComputedStyle(el); } catch { own = null; }
    const background = own && imageLabel(own.backgroundImage);
    if (background) found.push(background);
    for (const part of ['::before', '::after']) {
      let pseudo = null;
      try { pseudo = window.getComputedStyle(el, part); } catch { continue; }
      if (!pseudo) continue;
      if (pseudo.display === 'none' || pseudo.visibility === 'hidden') continue;
      const generated = imageLabel(pseudo.content);
      if (generated) found.push(generated);
    }
    return found;
  };

  // The same question asked of a control and everything inside it, because a
  // control is emitted whole and its descendants never get a line to carry a
  // picture of their own. `<button><span class="icon"></span>Save</button>`
  // paints its icon on the span, not the button.
  //
  // A descendant that is independently focusable is excluded: that descendant
  // gets its own line from walkNestedControls, and its picture belongs there.
  const MAX_DECORATIONS = 3;
  const decorationsUnder = (el) => {
    const found = decorationsOf(el);
    const visit = (node) => {
      for (const child of kidsOf(node)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (SKIP.has(child.tagName.toLowerCase())) continue;
        if (visibilityOf(child) === GONE) continue;
        if (independentlyFocusable(child)) continue;
        // An <img> inside a control never reaches the img branch, because a
        // control is emitted whole and returns. Only an unnamed one is a
        // picture as far as this is concerned: an <img> the page gave alt
        // text to is naming the control, and nameFromImages below reads it.
        if (child.tagName === 'IMG' && !child.hasAttribute('alt')) {
          const source = nameForImageUrl(child.currentSrc || child.getAttribute('src') || '');
          if (source) found.push(source);
        }
        found.push(...decorationsOf(child));
        visit(child);
      }
    };
    visit(el);
    // One repeated icon is one picture as far as the reader is concerned, and
    // a control holding a dozen of them should not spend a dozen names on it.
    return [...new Set(found)].slice(0, MAX_DECORATIONS);
  };

  // The alt text of an image inside a control, which is the control's name
  // whenever the control has no text of its own.
  //
  // A link around an image is the ordinary way to make a picture clickable,
  // and `own` is empty for every one of them because an <img> contributes no
  // text. Four controls on https://celticchoir.ca/ were missing from this
  // view outright for that reason — the logo linking home, and the
  // slideshow's Previous, Next and Pause — while the accessibility view
  // named all four from the same alt text this reads.
  const nameFromImages = (el) => {
    let found = '';
    const visit = (node) => {
      for (const child of kidsOf(node)) {
        if (found) return;
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (visibilityOf(child) === GONE) continue;
        if (independentlyFocusable(child)) continue;
        if (child.tagName === 'IMG' || child.tagName === 'INPUT') {
          const alt = (child.getAttribute('alt') || '').trim();
          if (alt) { found = alt; return; }
        }
        visit(child);
      }
    };
    visit(el);
    return found;
  };

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
    if (tag === 'br') { if (layout) breakFlow(el); return; }
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
      }, el);
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
      const text = own || el.value || label || nameFromImages(el);
      const images = decorationsUnder(el);
      // A control named by nothing at all is still a control, and the picture
      // on it is what the sighted user is reading. Emitting it without the
      // picture would be a line saying nothing; dropping it, as this did,
      // takes the control away.
      if (text || images.length) emit({ kind: 'button', text, images, index: register(), block: true }, el);
      walkNestedControls(el);
      return;
    }
    if (shown && ((tag === 'a' && el.getAttribute('href') != null) || explicitRole === 'link')) {
      const text = own || label || nameFromImages(el);
      // The resolved target, for the address line to show while the reader
      // stands on it — see ax_own.js. A div wearing role="link" has none.
      const href = typeof el.href === 'string' && el.href ? el.href : undefined;
      const images = decorationsUnder(el);
      if (text || images.length) emit({ kind: 'link', text, href, images, index: register(), block: true }, el);
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
        images: decorationsUnder(el),
        index: register(),
        block: true,
      }, el);
      walkNestedControls(el);
      return;
    }
    if (shown && /^h[1-6]$/.test(tag)) {
      if (own) {
        emit({
          kind: 'heading',
          level: Number(tag[1]),
          text: own,
          images: decorationsUnder(el),
          index: register(),
          block: true,
        }, el);
      }
      return;
    }
    // Three different statements, which this used to collapse into two.
    //
    //   alt="Welsh harpist"   the page named the picture
    //   alt=""                the page said the picture carries nothing
    //   no alt attribute      the page said nothing either way
    //
    // The third is not the second. Six of the fourteen images on the English
    // Wikipedia article for Celtic music have no alt attribute, and they are
    // the article's photographs — a harpist, a festival crowd, a stone
    // carving. Treating a missing attribute as a declaration of emptiness
    // dropped all six without a word.
    if (shown && tag === 'img') {
      const alt = (el.getAttribute('alt') || '').trim();
      if (alt) emit({ kind: 'image', text: alt, index: register(), block: true }, el);
      else if (!el.hasAttribute('alt')) {
        const source = nameForImageUrl(el.currentSrc || el.getAttribute('src') || '');
        if (source) emit({ kind: 'decoration', text: source, index: register(), block: true }, el);
      }
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
      emit({ kind: 'media', tag, text: parts.join(', '), index: register(), block: true }, el);
      return;
    }
    if (shown && (tag === 'iframe' || tag === 'frame')) {
      emit({ kind: 'frame', text: el.getAttribute('title') || el.getAttribute('src') || '', index: register(), block: true }, el);
      return;
    }

    // An ordinary element that paints a picture. No control and no heading
    // claimed this one, so there is no line to hang the picture off and the
    // picture gets a line of its own — the four icons the Shape5 template
    // paints onto bare <div> and <span> elements for its search, login, menu
    // and social controls arrive here. Only this element's own paint counts;
    // a decorated descendant is walked in its own right and reaches this same
    // branch itself.
    //
    // The line is registered like any other, so the cursor can be put on the
    // picture and `Alt+M` can hover it.
    if (shown) {
      for (const picture of decorationsOf(el)) {
        emit({ kind: 'decoration', text: picture, index: register(), block: true }, el);
      }
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
        }, el);
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

// A picture painted on a control is said after the control, because the
// picture is a property of the control and not a thing standing beside it.
// The reader hears "About Us, link, image s5 menu arrow" and knows there is
// something there the other six menu items do not have.
function withImages(line, entry) {
  if (!entry.images || !entry.images.length) return line;
  return `${line} (image: ${entry.images.join(', ')})`;
}

// A control the page named nothing at all, whose picture is therefore the
// whole of what it says: `{(image: ccc logo)}` is a site logo linking home.
// The brackets stay, because what the reader needs first is that the line is
// a link.
function controlText(entry) {
  if (entry.text) return entry.text;
  return `(image: ${(entry.images || []).join(', ')})`;
}

function renderEntry(entry) {
  switch (entry.kind) {
    case 'heading': return withImages('#'.repeat(entry.level) + ' ' + entry.text, entry);
    case 'link': return entry.text ? withImages(`{${entry.text}}`, entry) : `{${controlText(entry)}}`;
    case 'button': return entry.text ? withImages(`[*${entry.text}]`, entry) : `[*${controlText(entry)}]`;
    case 'field': return withImages(`[${entry.value ? entry.text + ': ' + entry.value : entry.text}]`, entry);
    case 'image': return `(image) ${entry.text}`;
    // A picture with no text of its own, named by its file. The colon is what
    // separates the two cases out loud: "(image) Welsh harpist" is the page's
    // own words for the picture, and "(image: welsh harpist)" is its file
    // name standing in because the page wrote none.
    case 'decoration': return `(image: ${entry.text})`;
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
  decoration: 'img',
  media: 'video',
  frame: 'iframe',
  text: 'text',
};

async function snapshotRenderBlocks(target, { layout = false } = {}) {
  const frame = typeof target.mainFrame === 'function' ? target.mainFrame() : target;
  const entries = await target.evaluate(extractVisible, { layout });

  return entries.map((entry) => ({
    kind: 'control',
    text: renderEntry(entry),
    startsBlock: !!entry.block,
    isParagraph: !!entry.paragraph,
    item: {
      role: entry.role || ROLE_BY_KIND[entry.kind] || 'text',
      // A control the page named nothing at all is still announced and still
      // matched by name when the view changes, so its picture stands in.
      name: entry.text || ((entry.images && entry.images.length) ? controlText(entry) : entry.text),
      level: entry.level,
      href: entry.href,
      editable: entry.editable,
      file: entry.file,
      table: entry.table,
      flow: entry.flow,
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
