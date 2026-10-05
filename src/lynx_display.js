'use strict';

const { LINK_ROLES, BUTTON_ROLES, FIELD_ROLES, FOCUSABLE_ROLES } = require('./aria');
const { joinProse } = require('./blocks');

const FIELD_WIDTH = 20;

// The only attributes the Lynx screen adds. Reverse video marks the current
// control and bold marks a heading; there is deliberately no colour. They are
// written here so no escape byte can reach line text, searches or caret
// offsets, which are computed from plain text elsewhere.
const ANSI_REVERSE = '\x1b[7m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

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

// One display row as plain text: the document margin, the number marker and
// any suffix put back around the row's own text. The full-screen renderer and
// the non-interactive dump both need exactly this; only the former adds the
// terminal's styling on top, so the composition lives here once.
function lynxRowText(line, text) {
  const indent = line ? ' '.repeat(line.displayIndent || 0) : '';
  return indent + (line ? line.displayPrefix || '' : '')
    + text + (line ? line.displaySuffix || '' : '');
}

// One display row as Lynx's terminal would write it. `line` is the row itself,
// `selected` is the row the cursor is on, `current` is the block under the
// caret and `blocks` is the list the row indexes into. Pure text in, styled
// text out; the caller still owns the terminal.
function renderLynxRow({ text, line, selected, current, blocks = [] }) {
  const indent = line ? ' '.repeat(line.displayIndent || 0) : '';
  const prefix = indent + (line ? line.displayPrefix || '' : '');
  const suffix = line ? line.displaySuffix || '' : '';

  // A composite paragraph or table row holds several blocks on one line, so
  // the row is not the current item: only the span the caret is in is. The
  // number marker is outside the span and so outside the highlight, which is
  // what keeps a marker from being read as part of the thing it numbers.
  if (line && line.spans && line.spans.length) {
    if (!current || !lynxFocusable(current)) return lynxRowText(line, text);
    const currentIndex = blocks.indexOf(current);
    let out = '';
    let at = 0;
    for (const span of line.spans) {
      if (span.blockIndex !== currentIndex) continue;
      out += text.slice(at, span.start)
        + ANSI_REVERSE + text.slice(span.start, span.end) + ANSI_RESET;
      at = span.end;
    }
    if (!out) return lynxRowText(line, text);
    return prefix + out + text.slice(at) + suffix;
  }

  const block = line && blocks[line.blockIndex];
  // Lynx highlights every visible part of a wrapped current link.
  if (line && selected && line.blockIndex === selected.blockIndex && lynxFocusable(block)) {
    return `${prefix}${ANSI_REVERSE}${text}${ANSI_RESET}${suffix}`;
  }
  if (block && block.item && block.item.role === 'heading') {
    return `${prefix}${ANSI_BOLD}${text}${ANSI_RESET}${suffix}`;
  }
  return lynxRowText(line, text);
}

// Core blocks as the Lynx display shows them: rendered into Lynx's control
// vocabulary, numbered, with inline prose rejoined and table rows laid out.
// Both transformations retain their source spans, so a link inside either
// composite still resolves to its browser element.
function lynxBlocks(blocks, preferences = {}, transform = String) {
  const rendered = blocks.map((block) => renderLynxBlock(block, transform));
  const numbered = numberLynxBlocks(rendered, preferences);
  return groupLynxTableRows(groupLynxFlows(numbered));
}

// The gap between two columns of a laid-out table row, in cells.
const TABLE_GAP = 2;

function markerWidth(block) {
  return (block.displayPrefix || '').length + block.text.length + (block.displaySuffix || '').length;
}

function blockSourceIndex(block, position) {
  return block.sourceIndex != null ? block.sourceIndex : position;
}

// Put text and links that the extractor proved came from one HTML flow back
// into one display paragraph. Each original block owns only its text range;
// number markers and the joining space sit outside every span. That keeps a
// link activatable and keeps its highlight off both its number and surrounding
// prose even after the paragraph wraps.
function groupLynxFlows(blocks) {
  const out = [];
  let index = 0;

  while (index < blocks.length) {
    const first = blocks[index];
    const flow = first.item && first.item.flow;
    const role = first.item && first.item.role;
    const inline = flow && (role === 'text' || LINK_ROLES.has(role));
    if (!inline) {
      out.push({ ...first, sourceIndex: blockSourceIndex(first, index) });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < blocks.length) {
      const item = blocks[end].item;
      if (!item || item.flow !== flow || (item.role !== 'text' && !LINK_ROLES.has(item.role))) break;
      end += 1;
    }
    if (end === index + 1) {
      out.push({ ...first, sourceIndex: blockSourceIndex(first, index) });
      index = end;
      continue;
    }

    let text = '';
    let previous = '';
    const spans = [];
    for (let at = index; at < end; at += 1) {
      const block = blocks[at];
      const joined = previous ? joinProse(previous, block.text) : block.text;
      if (previous && joined.length > previous.length + block.text.length) text += ' ';
      text += block.displayPrefix || '';
      const start = text.length;
      text += block.text;
      if (block.spans && block.spans.length) {
        for (const span of block.spans) {
          spans.push({ ...span, start: start + span.start, end: start + span.end });
        }
      } else {
        spans.push({
          blockIndex: blockSourceIndex(block, at),
          start,
          end: text.length,
          displayNumber: block.displayNumber || null,
        });
      }
      text += block.displaySuffix || '';
      previous = block.text;
    }

    out.push({
      ...first,
      text,
      spans,
      sourceIndex: blockSourceIndex(first, index),
      displayPrefix: '',
      displaySuffix: '',
      displayNumber: null,
      merged: true,
    });
    index = end;
  }
  return out;
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
// Inline prose and links have already become one display block per cell. A
// cell holding several block-level runs — a list, for example — is left as it
// is. Lynx stacks such a row too (a multi-line cell pushes the rest of the row
// down), and guessing where the columns go would be worse than showing the
// cells in reading order. Nested tables fall out of the same rule:
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
      for (let at = run.from; at < run.to; at += 1) {
        out.push({ ...blocks[at], sourceIndex: blockSourceIndex(blocks[at], at) });
      }
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
      if (block.spans && block.spans.length) {
        for (const span of block.spans) {
          spans.push({ ...span, start: start + span.start, end: start + span.end });
        }
      } else {
        spans.push({
          blockIndex: blockSourceIndex(block, at),
          start,
          end: text.length,
          displayNumber: block.displayNumber || null,
        });
      }
      text += block.displaySuffix || '';
    }
    out.push({
      text,
      spans,
      sourceIndex: blockSourceIndex(blocks[order[0]], order[0]),
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
  FIELD_WIDTH, TABLE_GAP, ANSI_REVERSE, ANSI_BOLD, ANSI_RESET,
  clipField, renderLynxItem, renderLynxBlock, lynxBlocks, renderLynxRow, lynxRowText,
  lynxFocusable, numberLynxBlocks, groupLynxFlows, groupLynxTableRows,
};
