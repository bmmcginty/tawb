'use strict';

// Parses Playwright's locator.ariaSnapshot() YAML-ish text into a flat,
// reading-order list of items — the same shape a screen reader's browse
// mode presents.
//
// Format looks like:
//   - paragraph:
//     - text: Braille is a tactile writing system used by
//     - link "blind":
//       - /url: /wiki/Blindness
//     - text: people.
//   - searchbox "Search Wikipedia": current value
//
// Two things matter for reading real pages:
//   * prose lives in `- text:` nodes interleaved with links inside a
//     paragraph, so text nodes must become items of their own or the page
//     has no readable content at all;
//   * structural containers (row, cell, paragraph, listitem) carry a `name`
//     that is just the concatenation of everything inside them, so emitting
//     both the container and its children duplicates the whole page.
// The flattener below resolves that by only emitting a container's own name
// when nothing inside it was emitted.

const LINE_RE = /^([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)(?:\s*:\s?(.*))?$/;

// Roles we render as {Name} — things you "go to"
const LINK_ROLES = new Set(['link']);
// Roles we render as [*Name] — things you "activate"
const BUTTON_ROLES = new Set(['button', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option']);
// Roles we render as [Name] / [Name: value] — things that hold a value or take typing
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton']);

// Atomic roles: their accessible name already contains everything inside
// them (a link wrapping two images is still just one link), so we emit the
// node and never descend into it.
const ATOMIC_ROLES = new Set([
  ...LINK_ROLES, ...BUTTON_ROLES, 'heading', 'img',
]);

// Structural containers: never interesting in their own right, but their
// name may be the only content if they turn out to be empty (e.g. a table
// cell holding a bare string).
const CONTAINER_ROLES = new Set([
  'generic', 'none', 'presentation', 'group', 'main', 'navigation', 'banner',
  'contentinfo', 'form', 'region', 'list', 'listitem', 'iframe', 'application',
  'section', 'search', 'paragraph', 'article', 'complementary', 'note',
  'table', 'rowgroup', 'row', 'cell', 'columnheader', 'rowheader', 'figure',
  'definition', 'caption', 'superscript', 'subscript', 'blockquote', 'separator',
  'term', 'time', 'insertion', 'deletion', 'emphasis', 'strong', 'code',
  'DescriptionList', 'DescriptionListTerm', 'DescriptionListDetail',
]);

// Containers that only style a run of text, so content flows straight
// through them. Everything else in CONTAINER_ROLES is block-level and ends
// the current run of flowing text — without that boundary, a reference list
// of 361 links merges into a single unreadable "paragraph".
const INLINE_CONTAINER_ROLES = new Set([
  'generic', 'none', 'presentation', 'superscript', 'subscript',
  'emphasis', 'strong', 'code', 'insertion', 'deletion', 'time', 'term',
]);

// Marks a block boundary in the flat item stream.
const BREAK = { role: '__break__', name: '' };

function unescapeName(s) {
  return s.replace(/\\(.)/g, '$1');
}

// ariaSnapshot double-quotes any value with leading/trailing punctuation or
// special characters, so a fragment arrives as `", a"` and would otherwise
// be read out with its quotes intact.
function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return s;
}

// When an accessible name contains a colon, YAML single-quotes the entire
// node — `- 'link "Async I/O in DuckDB: Work"':` instead of the usual
// `- link "Async I/O in DuckDB: Work":`. Unwrapping that is not cosmetic:
// without it the line fails to parse and the element is dropped outright,
// which silently loses every heading and link whose title contains a colon.
// Inside a single-quoted scalar, YAML escapes a quote by doubling it.
function unwrapSingleQuoted(content) {
  if (content[0] !== "'") return null;
  let inner = '';
  let i = 1;
  while (i < content.length) {
    if (content[i] === "'") {
      if (content[i + 1] === "'") { inner += "'"; i += 2; continue; }
      break;
    }
    inner += content[i];
    i += 1;
  }
  if (i >= content.length) return null; // unterminated; leave it alone
  return { inner, trailing: content.slice(i + 1) };
}

// Builds the indent-nested tree. Attribute lines (`/url:`, `/checked:`) are
// metadata on their parent, not nodes.
function parseTree(yamlText) {
  const root = { role: '__root__', name: '', children: [] };
  const stack = [{ indent: -1, node: root }];

  for (const rawLine of yamlText.split('\n')) {
    const m = rawLine.match(/^(\s*)-\s(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const content = m[2];

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (content.startsWith('/')) continue; // attribute line

    const quoted = unwrapSingleQuoted(content);
    const body = quoted ? quoted.inner : content;

    const lm = body.match(LINE_RE);
    if (!lm) continue;

    const role = lm[1];
    const name = lm[2] ? unescapeName(lm[2]).trim() : '';
    const states = lm[3] || '';
    // For a quoted node the value, if any, follows the closing quote.
    const suffix = quoted
      ? quoted.trailing.replace(/^:\s?/, '').trim()
      : (lm[4] != null ? lm[4].trim() : '');

    const node = {
      role,
      name,
      suffix,
      checked: /\[checked\]/.test(states),
      expanded: /\[expanded\]/.test(states),
      level: (states.match(/\[level=(\d+)\]/) || [])[1],
      children: [],
    };
    parent.children.push(node);
    stack.push({ indent, node });
  }

  return root;
}

function flattenNode(node, out) {
  const { role, name, suffix } = node;

  // A text node is prose — the actual readable content of the page.
  if (role === 'text') {
    const text = unquote(suffix || name).trim();
    if (text) out.push({ role: 'text', name: text });
    return;
  }

  // ariaSnapshot renders an iframe as a bare stub with no contents, even
  // same-origin, so embedded pages are invisible here. Emit it as a marker
  // that the frame walker can splice the frame's own content in after.
  if (role === 'iframe') {
    out.push({ role: 'iframe', name });
    return;
  }

  if (ATOMIC_ROLES.has(role)) {
    if (name) {
      out.push({ role, name, level: node.level, checked: node.checked });
    }
    return; // name already covers everything inside
  }

  if (FIELD_ROLES.has(role)) {
    // Simple <input>-backed fields put their live value inline as
    // `role "name": value`; custom/contenteditable widgets nest it as a
    // child `text:` node instead. Cover both, then still descend so any
    // attached suggestion list stays reachable.
    const inlineValue = suffix ? unquote(suffix) : null;
    const textChild = node.children.find((c) => c.role === 'text');
    const value = inlineValue || (textChild ? unquote(textChild.suffix || textChild.name) : null);
    out.push({ role, name, value: value || undefined, expanded: node.expanded });
    for (const child of node.children) {
      if (child === textChild) continue; // already consumed as the value
      flattenNode(child, out);
    }
    return;
  }

  // Structural container: let the contents speak, and fall back to the
  // container's own name only if nothing inside it produced an item.
  const blockLevel = !INLINE_CONTAINER_ROLES.has(role);
  if (blockLevel) out.push(BREAK);

  const before = out.length;
  for (const child of node.children) flattenNode(child, out);
  const emitted = out.slice(before).some((i) => i.role !== '__break__');
  if (!emitted && CONTAINER_ROLES.has(role)) {
    // A short container inlines its text as a suffix (`- paragraph: hello`)
    // rather than nesting a text child, so the suffix is the only place that
    // content exists. Falling back to the name covers the empty-cell case.
    const inline = unquote(suffix || '').trim();
    const text = inline || name;
    if (text) out.push({ role: 'text', name: text });
  }

  if (blockLevel) out.push(BREAK);
}

function parseAriaSnapshot(yamlText) {
  const root = parseTree(yamlText);
  const raw = [];
  for (const child of root.children) flattenNode(child, raw);

  // Collapse the runs of boundary markers that nesting produces, and drop
  // leading/trailing ones, so consumers see at most one break between runs.
  const out = [];
  for (const item of raw) {
    if (item.role === '__break__') {
      if (out.length === 0) continue;
      if (out[out.length - 1].role === '__break__') continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].role === '__break__') out.pop();
  return out;
}

function renderLine(item) {
  const { role, name, value, level } = item;
  if (role === 'heading') {
    const marker = level ? '#'.repeat(Number(level)) + ' ' : '## ';
    return marker + name;
  }
  if (LINK_ROLES.has(role)) return `{${name}}`;
  if (BUTTON_ROLES.has(role)) return `[*${name}]`;
  if (FIELD_ROLES.has(role)) return `[${value ? name + ': ' + value : name}]`;
  if (role === 'img') return `(image) ${name}`;
  // A frame marks where embedded content begins; the frame's own lines are
  // spliced in after it, so it needs to survive even when unnamed.
  if (role === 'iframe') return name ? `<frame: ${name}>` : '<frame>';
  return name; // prose
}

function describe(item) {
  return renderLine(item);
}

module.exports = {
  parseAriaSnapshot, parseTree, renderLine, describe,
  LINK_ROLES, BUTTON_ROLES, FIELD_ROLES, ATOMIC_ROLES, CONTAINER_ROLES,
};
