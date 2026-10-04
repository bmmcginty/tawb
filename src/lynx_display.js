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
  if (role === 'iframe') return name ? `[FRAME: ${name}]` : '[FRAME]';
  if (role === 'video' || role === 'audio') return name ? `[${name}]` : `[${role}]`;
  return name || transform(fallback);
}

function renderLynxBlock(block, transform = String) {
  return { ...block, text: renderLynxItem(block.item, block.text, transform) };
}

function lynxFocusable(block) {
  return !!(block && block.item && FOCUSABLE_ROLES.has(block.item.role));
}

module.exports = {
  FIELD_WIDTH, clipField, renderLynxItem, renderLynxBlock, lynxFocusable,
};
