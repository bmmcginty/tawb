'use strict';

const { LINK_ROLES, BUTTON_ROLES, FIELD_ROLES, FOCUSABLE_ROLES } = require('./aria');

const FIELD_WIDTH = 20;

function clipField(value, width = FIELD_WIDTH) {
  const shown = String(value || '').slice(0, width);
  return shown + '_'.repeat(Math.max(0, width - shown.length));
}

function labelAndControl(label, control) {
  return label ? `${label} ${control}` : control;
}

// Lynx draws controls as pieces of the surrounding document rather than
// speaking TAWB's semantic {link}, [*button], and [field: value] vocabulary.
// This renderer changes only the display copy. Core blocks retain their exact
// text for live updates, place matching, browser activation, and other views.
function renderLynxItem(item, fallback = '', transform = String) {
  if (!item) return transform(fallback);
  const name = transform(item.name || '');
  const value = transform(item.value || '');
  const role = item.role;

  // Lynx names a table's caption rather than printing it as prose. The
  // extractor marks the items that came from a caption, so the mark is all
  // this needs; every other view goes on printing the text as it always did.
  if (item.table && item.table.caption) return `CAPTION: ${name || transform(fallback)}`;
  if (role === 'text') return transform(fallback);
  if (role === 'heading') return name;
  if (LINK_ROLES.has(role)) return name || transform(fallback);
  if (role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox') {
    const mark = item.checked === 'mixed' ? '-' : item.checked ? 'X' : ' ';
    return `[${mark}]${name ? ` ${name}` : ''}`;
  }
  if (role === 'radio' || role === 'menuitemradio') {
    return `(${item.checked ? '*' : ' '})${name ? ` ${name}` : ''}`;
  }
  if (role === 'option') return name;
  // Submit and reset inputs are links in Lynx's interaction model and their
  // value is printed directly. A <button> element may gain a separate
  // “(BUTTON)” label in Lynx's parser, but AX does not retain which markup
  // produced the button, so plain link-like text is the faithful common case.
  if (BUTTON_ROLES.has(role)) return name || 'BUTTON';

  if (role === 'textbox' || role === 'searchbox') {
    // Lynx's default HTML input size is twenty columns. Password values are
    // not available in TAWB's extracted item either, leaving the same blank
    // field rather than exposing a secret in the reading buffer.
    return labelAndControl(name, clipField(value));
  }
  if (role === 'combobox' || role === 'listbox') {
    return labelAndControl(name, `[${value || name || '____________________'}]`);
  }
  if (role === 'slider' || role === 'spinbutton') {
    return labelAndControl(name, `[${value || '0'}]`);
  }
  if (FIELD_ROLES.has(role)) return labelAndControl(name, clipField(value));

  if (role === 'img') return name || '[IMAGE]';
  if (role === 'iframe') return name ? `IFRAME: ${name}` : 'IFRAME:';
  if (role === 'video' || role === 'audio') return name ? `[${name}]` : `[${role}]`;
  return name || transform(fallback);
}

function renderLynxBlock(block, transform = String) {
  const item = block.item || {};
  const rendered = { ...block, text: renderLynxItem(item, block.text, transform) };
  // Lynx's default styles use a three-cell document margin, with section
  // headings pulled left. H1 is centered; lower heading levels gain a small
  // indent. Keep that whitespace as layout metadata so searches still begin
  // at the first real character.
  if (item.role === 'heading') {
    const level = Number(item.level) || 2;
    if (level === 1) rendered.displayAlign = 'center';
    else rendered.displayIndent = level >= 3 ? 2 : 0;
  } else {
    rendered.displayIndent = 3;
  }
  return rendered;
}

function lynxFocusable(block) {
  return !!(block && block.item && FOCUSABLE_ROLES.has(block.item.role));
}

// The gap between two columns of a laid-out table row, in cells.
const TABLE_GAP = 2;

function markerWidth(block) {
  return (block.displayPrefix || '').length + block.text.length + (block.displaySuffix || '').length;
}

function spannedWidth(widths, from, colspan) {
  let total = 0;
  for (let column = from; column < from + colspan; column += 1) total += widths[column] || 0;
  return total + TABLE_GAP * (colspan - 1);
}

// A table row on one line, the way Lynx lays one out.
//
// The extractor records which cell each block came from (item.table). A run of
// consecutive blocks from one row whose cells each hold exactly one block is
// joined into a single display block with the columns padded to line up, and
// `spans` says which character range belongs to which original block so that
// activation, search and the number prompt still resolve to the real element.
//
// A row with a cell holding several blocks — a list, or prose around a link —
// is left as it is. Lynx stacks such a row too (a multi-line cell pushes the
// rest of the row down), and guessing where the columns go would be worse than
// showing the cells in reading order. Nested tables fall out of the same rule:
// the inner table's items carry the inner table's identity, so its rows are
// laid out first and the outer row around them is stacked.
function groupLynxTableRows(blocks) {
  const runs = [];
  let index = 0;
  while (index < blocks.length) {
    const table = blocks[index].item && blocks[index].item.table;
    if (!table || table.caption || table.row == null || table.cell == null) {
      runs.push({ from: index, to: index + 1, merged: false });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < blocks.length) {
      const next = blocks[end].item && blocks[end].item.table;
      if (!next || next.caption || next.id !== table.id || next.row !== table.row) break;
      end += 1;
    }
    const cells = new Map();
    let merged = true;
    for (let at = index; at < end; at += 1) {
      const cell = blocks[at].item.table.cell;
      if (cells.has(cell)) { merged = false; break; }
      cells.set(cell, at);
    }
    runs.push({ from: index, to: end, merged: merged && cells.size > 0, cells, id: table.id });
    index = end;
  }

  // Column widths, over every laid-out row of a table, so a short row lines up
  // with the long rows around it.
  const layouts = new Map();
  const layoutFor = (id) => {
    if (!layouts.has(id)) layouts.set(id, { widths: [], offsets: [] });
    return layouts.get(id);
  };
  for (const run of runs) {
    if (!run.merged) continue;
    const layout = layoutFor(run.id);
    for (const at of run.cells.values()) {
      const { cell, colspan = 1 } = blocks[at].item.table;
      if (colspan === 1) layout.widths[cell] = Math.max(layout.widths[cell] || 0, markerWidth(blocks[at]));
    }
  }
  for (const run of runs) {
    if (!run.merged) continue;
    const layout = layoutFor(run.id);
    for (const at of run.cells.values()) {
      const { cell, colspan = 1 } = blocks[at].item.table;
      if (colspan < 2) continue;
      const missing = markerWidth(blocks[at]) - spannedWidth(layout.widths, cell, colspan);
      if (missing > 0) layout.widths[cell + colspan - 1] = (layout.widths[cell + colspan - 1] || 0) + missing;
    }
  }
  for (const layout of layouts.values()) {
    let at = 0;
    for (let column = 0; column < layout.widths.length; column += 1) {
      layout.offsets[column] = at;
      at += (layout.widths[column] || 0) + TABLE_GAP;
    }
  }

  const out = [];
  for (const run of runs) {
    if (!run.merged) {
      for (let at = run.from; at < run.to; at += 1) out.push({ ...blocks[at], sourceIndex: at });
      continue;
    }
    const layout = layouts.get(run.id);
    const order = [...run.cells.entries()].sort((a, b) => a[0] - b[0]).map(([, at]) => at);
    let text = '';
    const spans = [];
    for (const at of order) {
      const block = blocks[at];
      const offset = layout.offsets[block.item.table.cell] || 0;
      if (text.length < offset) text += ' '.repeat(offset - text.length);
      text += block.displayPrefix || '';
      const start = text.length;
      text += block.text;
      spans.push({
        blockIndex: at,
        start,
        end: text.length,
        displayNumber: block.displayNumber || null,
      });
      text += block.displaySuffix || '';
    }
    out.push({
      text,
      spans,
      sourceIndex: order[0],
      displayIndent: 3,
      startsBlock: true,
      merged: true,
    });
  }
  return out;
}

function numberLynxBlocks(blocks, preferences = {}) {
  let number = 0;
  return blocks.map((block) => {
    const role = block.item && block.item.role;
    const link = LINK_ROLES.has(role);
    const field = role !== 'option' && (BUTTON_ROLES.has(role) || FIELD_ROLES.has(role));
    if ((!link || !preferences.numberLinks) && (!field || !preferences.numberFields)) return block;
    number += 1;
    const marker = `[${number}]`;
    const left = link ? preferences.numberLinksOnLeft !== false : preferences.numberFieldsOnLeft !== false;
    return {
      ...block,
      displayNumber: number,
      displayPrefix: left ? marker : '',
      displaySuffix: left ? '' : marker,
    };
  });
}

module.exports = {
  FIELD_WIDTH, TABLE_GAP, clipField, renderLynxItem, renderLynxBlock,
  lynxFocusable, numberLynxBlocks, groupLynxTableRows,
};
