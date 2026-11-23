'use strict';

// Where the three classes of extra information are said:
//
//   context      the landmark, group, list, table or tree the cursor is in
//   annotations  what a control says beyond its name: description, error,
//                keystroke, described role, the popup it opens
//   notes        asides — a note, a tooltip, a figure caption — whose text is
//                not the page's argument but is worth being able to hear
//
// Each class is `inline`, `status` or `off`, per reader rather than per site:
// one person wants the landmark announced on every line, another wants a quiet
// row, and a third finds both noise. The defaults are the ones that change
// nobody's existing reading: context off, annotations in the status row (where
// nothing else was saying them), notes inline as they already were.

const CLASSES = ['context', 'annotations', 'notes'];
const MODES = new Set(['inline', 'status', 'off']);
const DEFAULTS = { context: 'off', annotations: 'status', notes: 'inline' };

// Roles whose text is an aside rather than the page's own content.
const NOTE_ROLES = new Set(['note', 'tooltip', 'figure', 'suggestion', 'comment']);

function displayMode(name, value) {
  if (value === undefined || value === null || value === '') return DEFAULTS[name];
  const mode = String(value).toLowerCase();
  if (!MODES.has(mode)) {
    throw new Error(`Unknown ${name} mode ${value}; use inline, status or off`);
  }
  return mode;
}

// The whole setting, from whatever the caller supplied.
function displaySettings(values = {}) {
  const settings = {};
  for (const name of CLASSES) settings[name] = displayMode(name, values[name]);
  return settings;
}

// The words for one container in a context path: "navigation Breadcrumb".
function containerLabel(container) {
  const role = container.role || 'container';
  return container.name ? `${role} ${container.name}` : role;
}

// The context path, outermost first, as one phrase.
function contextLabel(context) {
  return (context || []).filter(Boolean).map(containerLabel).join(' › ');
}

// Everything the row can say about the line the cursor is on, in the order a
// person would want to hear it: where they are, then what this control says
// about itself. Empty when the settings ask for nothing.
function rowDetail(block, settings = DEFAULTS) {
  if (!block) return '';
  const said = [];
  if (settings.context === 'status' && block.context && block.context.length) {
    said.push(`in: ${contextLabel(block.context)}`);
  }
  const annotation = block.annotation || {};
  if (settings.annotations === 'status') {
    if (annotation.description) said.push(annotation.description);
    if (annotation.error) said.push(`error: ${annotation.error}`);
    if (annotation.keyshortcuts) said.push(`keys ${annotation.keyshortcuts}`);
    if (annotation.haspopup) said.push(`opens a ${annotation.haspopup}`);
    if (annotation.roleDescription) said.push(annotation.roleDescription);
  }
  if (settings.notes === 'status' && block.note) said.push(block.note);
  return said.join(' — ');
}

// The same information as part of a line, for the inline modes. The line's own
// text stays first: it is what the cursor is on, and a screen reader reads the
// line from its start.
function inlineDetail(block, settings = DEFAULTS) {
  if (!block) return '';
  const said = [];
  const annotation = block.annotation || {};
  if (settings.annotations === 'inline') {
    if (annotation.description) said.push(annotation.description);
    if (annotation.error) said.push(`error: ${annotation.error}`);
    if (annotation.keyshortcuts) said.push(`keys ${annotation.keyshortcuts}`);
    if (annotation.haspopup) said.push(`opens a ${annotation.haspopup}`);
    if (annotation.roleDescription) said.push(annotation.roleDescription);
  }
  return said.join(' — ');
}

module.exports = {
  CLASSES, MODES, DEFAULTS, NOTE_ROLES, displayMode, displaySettings,
  containerLabel, contextLabel, rowDetail, inlineDetail,
};
